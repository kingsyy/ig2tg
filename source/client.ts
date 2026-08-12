import {extname} from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
	type IgApiClient,
	IgCheckpointError,
	IgLoginTwoFactorRequiredError,
	IgLoginBadPasswordError,
	type DirectInboxFeedResponseThreadsItem,
	type DirectInboxFeedResponseUsersItem,
	type DirectThreadFeedResponseItemsItem,
	type AccountRepositoryLoginErrorResponseTwoFactorInfo,
} from 'instagram-private-api';
import {
	GraphQLSubscriptions,
	SkywalkerSubscriptions,
	RealtimeClient,
	IgApiClientExt,
} from 'instagram_mqtt';
import {SessionManager} from './session.js';
import {ConfigManager} from './config.js';
import type {
	Thread,
	Message,
	User,
} from './types/instagram.js';
import {
	parseMessageItem,
	parseReactionEvent,
	parseSeenEvent,
	getBestMediaUrl,
} from './utils/message-parser.js';
import {createContextualLogger} from './utils/logger.js';
import {describeError} from './utils/redact.js';

export type LoginResult = {
	success: boolean;
	error?: string;
	username?: string;
	checkpointError?: IgCheckpointError;
	twoFactorInfo?: AccountRepositoryLoginErrorResponseTwoFactorInfo;
	badPassword?: boolean;
};

export type RealtimeStatus =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'error';

export type SendMessageOptions = {
	/** Instagram item ID this message replies to, producing a native IG reply. */
	replyToItemId?: string;
	/** The replied-to item's client_context, when the bridge recorded one. */
	replyToClientContext?: string;
	/**
	 * A stable idempotency token reused across retries. Instagram treats a repeat
	 * of the same client_context as the same send, which is what keeps a retry
	 * after a mid-flight crash from producing a duplicate message.
	 */
	clientContext?: string;
};

/**
 * Application-owned reconnect schedule. Delays climb and then hold at the cap,
 * so a long Instagram outage keeps being retried without hammering the API.
 */
export const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/** ±20% jitter so repeated failures don't retry in lockstep. */
function withJitter(delayMs: number): number {
	const spread = delayMs * 0.2;
	return Math.round(delayMs - spread + Math.random() * spread * 2);
}

/**
 * The delay before reconnect attempt number `attempt` (0-based), jitter included.
 * Attempts past the end of the schedule hold at the cap and keep retrying.
 */
export function nextReconnectDelayMs(attempt: number): number {
	const index = Math.min(Math.max(0, attempt), RECONNECT_DELAYS_MS.length - 1);
	return withJitter(RECONNECT_DELAYS_MS[index]!);
}

// eslint-disable-next-line unicorn/prefer-event-target
export class InstagramClient extends EventEmitter {
	private readonly ig: IgApiClientExt;
	private realtime: RealtimeClient | undefined;
	private realtimeStatus: RealtimeStatus = 'disconnected';

	private reconnectAttempt = 0;
	private reconnectInFlight = false;
	private reconnectTimer: NodeJS.Timeout | undefined = undefined;
	private shuttingDown = false;
	private lastRealtimeEventAt: Date | undefined = undefined;

	private sessionManager: SessionManager | undefined = undefined;
	private readonly configManager: ConfigManager;
	private username: string | undefined = undefined;
	private readonly userCache = new Map<string, string>();
	private readonly logger = createContextualLogger('InstagramClient');

	private inboxFeed:
		| ReturnType<IgApiClientExt['feed']['directInbox']>
		| undefined = undefined;

	private readonly loginFlowStates: {
		preLoginDone: boolean;
		postLoginDone: boolean;
	} = {
		preLoginDone: false,
		postLoginDone: false,
	};

	constructor(username?: string) {
		super();
		this.ig = new IgApiClientExt();
		this.configManager = ConfigManager.getInstance();

		if (username) {
			this.username = username;
			this.sessionManager = new SessionManager(username);
		}
	}

	public async login(
		username: string,
		password: string,
		options?: {initializeRealtime: boolean},
	): Promise<LoginResult> {
		const loginOptions = options ?? {initializeRealtime: true};
		try {
			this.username = username;
			this.sessionManager = new SessionManager(username);

			this.ig.state.generateDevice(username);

			this.ig.request.end$.subscribe(async () => {
				await this.saveSessionState();
			});

			if (!this.loginFlowStates.preLoginDone) {
				await this.preLoginFlow();
				this.loginFlowStates.preLoginDone = true;
			}

			await this.ig.account.login(username, password);

			await this.saveSessionState();
			await this.configManager.set('login.currentUsername', username);

			const defaultUsername = this.configManager.get('login.defaultUsername');
			if (!defaultUsername) {
				await this.configManager.set('login.defaultUsername', username);
			}

			if (loginOptions.initializeRealtime) {
				try {
					await this.initializeRealtime();
				} catch (error) {
					this.setRealtimeStatus('error');
					this.emit(
						'error',
						new Error(
							`Realtime connection failed: ${(error as Error).name}`,
						),
					);
					// Authentication succeeded, so keep retrying the MQTT connection.
					this.scheduleReconnect();
				}
			}

			if (!this.loginFlowStates.postLoginDone) {
				await this.postLoginFlow();
				this.loginFlowStates.postLoginDone = true;
			}

			return {success: true, username};
		} catch (error) {
			if (error instanceof IgLoginTwoFactorRequiredError) {
				return {
					success: false,
					twoFactorInfo: error.response.body.two_factor_info,
				};
			}

			if (error instanceof IgCheckpointError) {
				return {success: false, checkpointError: error};
			}

			if (error instanceof IgLoginBadPasswordError) {
				return {success: false, badPassword: true};
			}

			this.logger.error('Login failed', error);
			return {
				success: false,
				error: describeError(error),
			};
		}
	}

	public async twoFactorLogin({
		verificationCode,
		twoFactorIdentifier,
		totp_two_factor_on,
	}: {
		verificationCode: string;
		twoFactorIdentifier: string;
		totp_two_factor_on: boolean;
	}): Promise<LoginResult> {
		try {
			if (!this.loginFlowStates.preLoginDone) {
				await this.preLoginFlow();
				this.loginFlowStates.preLoginDone = true;
			}

			const verificationMethod = totp_two_factor_on ? '0' : '1';
			await this.ig.account.twoFactorLogin({
				username: this.username!,
				verificationCode,
				twoFactorIdentifier,
				verificationMethod,
			});

			await this.saveSessionState();
			if (this.username) {
				await this.configManager.set('login.currentUsername', this.username);
			}

			if (!this.loginFlowStates.postLoginDone) {
				await this.postLoginFlow();
				this.loginFlowStates.postLoginDone = true;
			}

			return {success: true, username: this.username ?? undefined};
		} catch (error) {
			this.logger.error('2FA Login failed', error);
			return {
				success: false,
				error: describeError(error),
			};
		}
	}

	public async loginBySession(options?: {
		initializeRealtime: boolean;
	}): Promise<LoginResult> {
		const sessionOptions = options ?? {initializeRealtime: true};
		if (!this.sessionManager) {
			return {success: false, error: 'No session manager initialized'};
		}

		try {
			const sessionData = await this.sessionManager.loadSession();
			if (!sessionData) {
				return {success: false, error: 'No session file found'};
			}

			if (!this.username) {
				return {success: false, error: 'No username set for session login'};
			}

			this.ig.state.generateDevice(this.username);

			this.ig.request.end$.subscribe(async () => {
				await this.saveSessionState();
			});

			await this.ig.state.deserialize(sessionData);

			const originalUsername = this.username;
			const currentUser = await this.ig.account.currentUser();
			this.username = currentUser.username;

			await this.saveSessionState();
			await this.configManager.set('login.currentUsername', originalUsername);

			if (sessionOptions.initializeRealtime) {
				try {
					await this.initializeRealtime();
				} catch (error) {
					this.setRealtimeStatus('error');
					this.emit(
						'error',
						new Error(
							`Realtime connection failed: ${(error as Error).name}`,
						),
					);
					// Authentication succeeded, so keep retrying the MQTT connection.
					this.scheduleReconnect();
				}
			}

			if (!this.loginFlowStates.postLoginDone) {
				await this.postLoginFlow();
				this.loginFlowStates.postLoginDone = true;
			}

			return {success: true, username: this.username ?? undefined};
		} catch (error) {
			if (error instanceof IgCheckpointError) {
				return {success: false, checkpointError: error};
			}

			this.logger.error('Failed to login with session', error);
			return {
				success: false,
				error: describeError(error),
			};
		}
	}

	public async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.cancelScheduledReconnect();
		await this.teardownRealtime();
		this.setRealtimeStatus('disconnected');
	}

	/**
	 * Reconnects Instagram realtime now, restoring the existing authenticated
	 * session rather than logging in again. Safe to call while a scheduled
	 * reconnect is pending — it cancels it and takes over.
	 */
	public async reconnectRealtime(): Promise<'connected' | 'in_progress' | 'failed'> {
		if (this.reconnectInFlight) return 'in_progress';

		this.shuttingDown = false;
		this.cancelScheduledReconnect();
		this.reconnectAttempt = 0;
		return (await this.attemptReconnect()) ? 'connected' : 'failed';
	}

	/**
	 * Verifies the REST session is still authenticated. One lightweight request;
	 * callers must not poll it.
	 */
	public async checkSession(): Promise<boolean> {
		try {
			await this.ig.account.currentUser();
			return true;
		} catch (error) {
			this.logger.error('Instagram session check failed', error);
			return false;
		}
	}

	public getInstagramClient(): IgApiClient {
		return this.ig;
	}

	public getUsername(): string | undefined {
		return this.username;
	}

	public getUserId(): string {
		return this.ig.state.cookieUserId;
	}

	public getRealtimeStatus(): RealtimeStatus {
		return this.realtimeStatus;
	}

	public getLastRealtimeEventAt(): Date | undefined {
		return this.lastRealtimeEventAt;
	}

	public getReconnectAttempt(): number {
		return this.reconnectAttempt;
	}

	public getUserCache(): Map<string, string> {
		return this.userCache;
	}

	public async getCurrentUser(): Promise<User | undefined> {
		try {
			const user = await this.ig.user.info(this.ig.state.cookieUserId);
			return {
				pk: user.pk.toString(),
				username: user.username,
				fullName: user.full_name,
				profilePicUrl: user.profile_pic_url,
				isVerified: user.is_verified,
			};
		} catch (error) {
			this.logger.error('Failed to get current user', error);
			return undefined;
		}
	}

	public async getThreads(
		loadMore = false,
	): Promise<{threads: Thread[]; hasMore: boolean}> {
		try {
			if (!loadMore || !this.inboxFeed) {
				this.inboxFeed = this.ig.feed.directInbox();
				this.userCache.clear();
			}

			const inbox = await this.inboxFeed.items();

			for (const thread of inbox) {
				if (thread.users) {
					for (const user of thread.users) {
						this.userCache.set(
							user.pk.toString(),
							user.username ?? user.full_name ?? `User_${user.pk}`,
						);
					}
				}
			}

			const threads = inbox.map(thread => ({
				id: thread.thread_id,
				title: this.getThreadTitle(thread),
				users: this.getThreadUsers(thread),
				lastMessage: this.getLastMessage(thread),
				lastActivity: new Date(Number(thread.last_activity_at) / 1000),
				unread: (thread as any).read_state === 1,
			}));

			return {
				threads,
				hasMore: this.inboxFeed.isMoreAvailable(),
			};
		} catch (error) {
			this.logger.error('Failed to fetch threads', error);
			throw error;
		}
	}

	public async getMessages(
		threadId: string,
		cursor?: string,
	): Promise<{messages: Message[]; cursor: string | undefined}> {
		try {
			const thread = this.ig.feed.directThread({
				thread_id: threadId,
				oldest_cursor: cursor ?? '',
			});
			const items = await thread.items();
			const messages = items
				.map(item =>
					parseMessageItem(item as any, threadId, {
						userCache: this.userCache,
						currentUserId: this.ig.state.cookieUserId,
					}),
				)
				.filter((message): message is Message => message !== undefined);

			return {
				messages: messages.reverse(),
				cursor: thread.cursor,
			};
		} catch (error) {
			this.logger.error('Failed to fetch messages', error);
			throw error;
		}
	}

	/**
	 * Fetches a bounded window of the most recent messages in a thread, returned
	 * oldest-first. One REST request per call — used by reconciliation, which
	 * paces its calls so a reconnect cannot turn into aggressive polling.
	 */
	public async getRecentMessages(
		threadId: string,
		limit: number,
	): Promise<Message[]> {
		const {messages} = await this.getMessages(threadId);
		return limit > 0 && messages.length > limit ? messages.slice(-limit) : messages;
	}

	/**
	 * Sends a text message, optionally as a native Instagram reply.
	 *
	 * This goes through the `directThread` repository rather than
	 * `entity.directThread().broadcastText()` so the bridge can supply its own
	 * `client_context` for idempotent retries. The trade-off is that a message
	 * containing a URL is sent as plain text instead of being converted into a
	 * link item; Instagram still renders the URL as a tappable link.
	 */
	public async sendMessage(
		threadId: string,
		text: string,
		options: SendMessageOptions = {},
	): Promise<string> {
		const clientContext = options.clientContext ?? randomUUID();

		const form: Record<string, string> = {
			text,
			client_context: clientContext,
			mutation_token: clientContext,
		};

		if (options.replyToItemId) {
			form['replied_to_action_source'] = 'swipe';
			form['replied_to_item_id'] = options.replyToItemId;
			if (options.replyToClientContext) {
				form['replied_to_client_context'] = options.replyToClientContext;
			}
		}

		try {
			const res = await this.ig.directThread.broadcast({
				item: 'text',
				threadIds: [threadId],
				form,
			});
			return this.extractItemId(res);
		} catch (error) {
			// The raw error carries the request form, which contains the message
			// text — only the class name and status are safe to record here.
			this.logger.error(
				`Failed to send message (${(error as Error)?.name ?? 'unknown'})`,
			);
			throw error;
		}
	}

	private extractItemId(res: unknown): string {
		const body = res as
			| {payload?: {item_id?: string}; item_id?: string}
			| undefined;
		const itemId = body?.payload?.item_id ?? body?.item_id;
		if (!itemId) {
			throw new Error('Instagram accepted the send but returned no item ID');
		}

		return itemId;
	}

	public async sendPhoto(threadId: string, photoBuffer: Buffer): Promise<string> {
		try {
			const res = await this.ig.entity.directThread(threadId).broadcastPhoto({
				file: photoBuffer,
			});
			return this.extractItemId(res);
		} catch (error) {
			this.logger.error(`Failed to send photo (${(error as Error)?.name ?? 'unknown'})`);
			throw error;
		}
	}

	public async sendVideo(threadId: string, videoBuffer: Buffer): Promise<string> {
		try {
			const res = await this.ig.entity.directThread(threadId).broadcastVideo({
				video: videoBuffer,
			});
			return this.extractItemId(res);
		} catch (error) {
			this.logger.error(`Failed to send video (${(error as Error)?.name ?? 'unknown'})`);
			throw error;
		}
	}

	public async sendVoice(threadId: string, voiceBuffer: Buffer): Promise<string> {
		try {
			const res = await this.ig.entity.directThread(threadId).broadcastVoice({
				file: voiceBuffer,
			});
			return this.extractItemId(res);
		} catch (error) {
			this.logger.error(`Failed to send voice (${(error as Error)?.name ?? 'unknown'})`);
			throw error;
		}
	}

	public async sendReaction(threadId: string, itemId: string, emoji: string): Promise<void> {
		if (!this.realtime?.direct) {
			throw new Error('Realtime not connected');
		}
		await this.realtime.direct.sendReaction({
			threadId,
			itemId,
			reactionStatus: 'created',
			emoji,
		});
	}

	public async removeReaction(threadId: string, itemId: string, emoji: string): Promise<void> {
		if (!this.realtime?.direct) {
			throw new Error('Realtime not connected');
		}
		await this.realtime.direct.sendReaction({
			threadId,
			itemId,
			reactionStatus: 'deleted',
			emoji,
		});
	}

	public async unsendMessage(
		threadId: string,
		messageId: string,
	): Promise<void> {
		try {
			await this.ig.entity.directThread(threadId).deleteItem(messageId);
		} catch (error) {
			this.logger.error('Failed to unsend message', error);
			throw error;
		}
	}

	public async downloadMedia(mediaUrl: string): Promise<Buffer> {
		const response = await fetch(mediaUrl);

		if (!response.ok) {
			throw new Error(
				`Failed to download media: ${response.status} ${response.statusText}`,
			);
		}

		if (!response.body) {
			throw new Error('Response body is empty');
		}

		return Buffer.from(await response.arrayBuffer());
	}

	// ─── Private ────────────────────────────────────────────

	private setRealtimeStatus(status: RealtimeStatus) {
		this.realtimeStatus = status;
		this.emit('realtimeStatus', status);
	}

	private cancelScheduledReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	/**
	 * Detaches and disconnects the current realtime client. Listeners are removed
	 * first so a dying connection cannot schedule another reconnect on the way out.
	 */
	private async teardownRealtime(): Promise<void> {
		const previous = this.realtime;
		this.realtime = undefined;
		if (!previous) return;

		previous.removeAllListeners();
		try {
			await previous.disconnect();
		} catch {
			// Already gone — nothing to clean up.
		}
	}

	/**
	 * Queues the next reconnect attempt. Concurrent attempts are suppressed: at
	 * most one timer and one in-flight attempt exist at a time.
	 */
	private scheduleReconnect(): void {
		if (this.shuttingDown || this.reconnectInFlight || this.reconnectTimer) return;

		const delay = nextReconnectDelayMs(this.reconnectAttempt);

		this.setRealtimeStatus('reconnecting');
		this.logger.info(
			`Scheduling Instagram realtime reconnect in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt + 1})`,
		);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.attemptReconnect();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	/**
	 * Rebuilds the MQTT connection on top of the existing authenticated session.
	 * Never re-logs in: repeated full logins are what trigger Instagram challenges.
	 */
	private async attemptReconnect(): Promise<boolean> {
		if (this.reconnectInFlight || this.shuttingDown) return false;
		this.reconnectInFlight = true;

		try {
			await this.teardownRealtime();
			await this.initializeRealtime();
			this.reconnectAttempt = 0;
			this.logger.info('Instagram realtime reconnected');
			this.emit('realtimeReconnected');
			return true;
		} catch (error) {
			this.reconnectAttempt++;
			this.logger.error(
				`Instagram realtime reconnect failed (attempt ${this.reconnectAttempt}, ${(error as Error)?.name ?? 'unknown'})`,
			);
			this.reconnectInFlight = false;
			this.scheduleReconnect();
			return false;
		} finally {
			this.reconnectInFlight = false;
		}
	}

	/**
	 * Called when the connection drops. The status change is emitted once per
	 * transition, so a burst of low-level MQTT errors does not produce a burst of
	 * notifications downstream.
	 */
	private handleRealtimeLoss(status: 'error' | 'disconnected'): void {
		if (this.shuttingDown) return;
		if (this.realtimeStatus === 'reconnecting' || this.reconnectInFlight) return;

		this.setRealtimeStatus(status);
		this.scheduleReconnect();
	}

	private async initializeRealtime(): Promise<void> {
		this.setRealtimeStatus('connecting');
		this.realtime = new RealtimeClient(this.ig);
		const realtime = this.realtime;

		realtime.on('error', (error: Error) => {
			this.logger.error(`Realtime error (${error?.name ?? 'unknown'})`);
			this.emit('error', error);
			this.handleRealtimeLoss('error');
		});

		realtime.on('close', () => {
			this.handleRealtimeLoss('disconnected');
		});

		realtime.on('disconnect', () => {
			this.handleRealtimeLoss('disconnected');
		});

		realtime.on('message', (wrapper: any) => {
			this.lastRealtimeEventAt = new Date();
			// Deliberately does NOT log the payload: an MQTT message wrapper contains
			// the full message text and media URLs.
			this.logger.debug(
				`MQTT event delta_type=${wrapper?.delta_type ?? 'unknown'} item_type=${wrapper?.message?.item_type ?? 'none'}`,
			);

			if (
				wrapper.delta_type === 'deltaCreateReaction' &&
				wrapper.message?.action_type !== 'action_log'
			) {
				const reactionData = parseReactionEvent(wrapper.message);
				if (reactionData) {
					this.emit('reaction', reactionData);
				}
			} else if (wrapper.delta_type === 'deltaNewMessage') {
				const threadId =
					wrapper?.message?.thread_id ?? wrapper?.message?.thread_v2_id;
				if (!threadId) return;

				const parsedMessage = parseMessageItem(wrapper.message, threadId, {
					userCache: this.userCache,
					currentUserId: this.ig.state.cookieUserId,
				});
				if (parsedMessage) {
					this.emit('message', parsedMessage);
				}
			} else if (wrapper.delta_type === 'deltaReadReceipt') {
				const seenData = parseSeenEvent(wrapper.message);
				const currentUserId = this.ig.state.cookieUserId;
				if (
					seenData?.threadId &&
					seenData?.userId &&
					currentUserId !== seenData.userId
				) {
					this.emit('threadSeen', seenData);
				}
			}
		});

		await realtime.connect({
			graphQlSubs: [
				GraphQLSubscriptions.getAppPresenceSubscription(),
				GraphQLSubscriptions.getZeroProvisionSubscription(
					this.ig.state.phoneId,
				),
				GraphQLSubscriptions.getDirectStatusSubscription(),
				GraphQLSubscriptions.getDirectTypingSubscription(
					this.ig.state.cookieUserId,
				),
				GraphQLSubscriptions.getAsyncAdSubscription(this.ig.state.cookieUserId),
			],
			skywalkerSubs: [
				SkywalkerSubscriptions.directSub(this.ig.state.cookieUserId),
				SkywalkerSubscriptions.liveSub(this.ig.state.cookieUserId),
			],
			irisData: await this.ig.feed.directInbox().request(),
			// The bridge owns reconnection so that every reconnect also re-subscribes
			// with fresh iris data and triggers missed-message reconciliation.
			autoReconnect: false,
		});

		this.setRealtimeStatus('connected');
	}

	private async saveSessionState(): Promise<void> {
		if (!this.sessionManager) {
			return;
		}

		try {
			const serialized = await this.ig.state.serialize();
			await this.sessionManager.saveSession(serialized);
		} catch (error) {
			this.logger.error('Error saving session state', error);
		}
	}

	private getThreadTitle(thread: DirectInboxFeedResponseThreadsItem): string {
		if (thread.thread_title) {
			return thread.thread_title;
		}

		const users = thread.users || [];
		const otherUsers = users.filter(
			(user: DirectInboxFeedResponseUsersItem) =>
				user.pk.toString() !== this.ig.state.cookieUserId,
		);

		if (otherUsers.length === 0) {
			return 'You';
		}

		if (otherUsers.length === 1) {
			return (
				otherUsers[0]?.username ?? otherUsers[0]?.full_name ?? 'Unknown User'
			);
		}

		return otherUsers
			.map(
				(user: DirectInboxFeedResponseUsersItem) =>
					user.username || user.full_name,
			)
			.join(', ');
	}

	private getThreadUsers(thread: DirectInboxFeedResponseThreadsItem): User[] {
		const users = thread.users || [];
		return users.map((user: DirectInboxFeedResponseUsersItem) => ({
			pk: user.pk.toString(),
			username: user.username || '',
			fullName: user.full_name || '',
			profilePicUrl: user.profile_pic_url,
			isVerified: user.is_verified || false,
		}));
	}

	private getLastMessage(
		thread: DirectInboxFeedResponseThreadsItem,
	): Message | undefined {
		const items = thread.items || [];
		const lastItem = items[0];

		if (!lastItem) {
			return undefined;
		}

		return parseMessageItem(
			lastItem as any,
			thread.thread_id,
			{
				userCache: this.userCache,
				currentUserId: this.ig.state.cookieUserId,
			},
			{
				isPreview: true,
			},
		);
	}

	private async preLoginFlow(): Promise<boolean> {
		try {
			await this.ig.launcher.preLoginSync();
			return true;
		} catch (error) {
			this.logger.error('Pre login flow failed', error);
			return false;
		}
	}

	private async postLoginFlow(): Promise<boolean> {
		try {
			await this.ig.feed.reelsTray('cold_start').request();
			await this.ig.feed.timeline('cold_start_fetch').request();
			return true;
		} catch (error) {
			this.logger.error('Post login flow failed', error);
			return false;
		}
	}
}
