import {extname} from 'node:path';
import fs from 'node:fs';
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
	withRealtime,
	GraphQLSubscriptions,
	SkywalkerSubscriptions,
	type RealtimeClient,
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
	| 'error';

// eslint-disable-next-line unicorn/prefer-event-target
export class InstagramClient extends EventEmitter {
	private readonly ig: IgApiClientExt;
	private realtime: RealtimeClient | undefined;
	private realtimeStatus: RealtimeStatus = 'disconnected';

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
							`Realtime connection failed: ${(error as Error).message}`,
						),
					);
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
				error: error instanceof Error ? error.message : 'Unknown login error',
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
				error: error instanceof Error ? error.message : 'Unknown 2FA error',
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
							`Realtime connection failed: ${(error as Error).message}`,
						),
					);
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
				error: error instanceof Error ? error.message : 'Unknown session error',
			};
		}
	}

	public async shutdown(): Promise<void> {
		if (this.realtime) {
			await this.realtime.disconnect();
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

	public async sendMessage(threadId: string, text: string, replyToItemId?: string): Promise<string> {
		try {
			const replyTo = replyToItemId
				? {item_id: replyToItemId, client_context: replyToItemId} as any
				: undefined;
			const res = await this.ig.entity.directThread(threadId).broadcastText(text, replyTo);
			return 'payload' in res ? res.payload.item_id : res.item_id;
		} catch (error) {
			this.logger.error('Failed to send message', error);
			throw error;
		}
	}

	public async sendPhoto(threadId: string, photoBuffer: Buffer): Promise<string> {
		try {
			const res = await this.ig.entity.directThread(threadId).broadcastPhoto({
				file: photoBuffer,
			});
			return 'payload' in res ? res.payload.item_id : res.item_id;
		} catch (error) {
			this.logger.error('Failed to send photo', error);
			throw error;
		}
	}

	public async sendVideo(threadId: string, videoBuffer: Buffer): Promise<string> {
		try {
			const res = await this.ig.entity.directThread(threadId).broadcastVideo({
				video: videoBuffer,
			});
			return 'payload' in res ? res.payload.item_id : res.item_id;
		} catch (error) {
			this.logger.error('Failed to send video', error);
			throw error;
		}
	}

	public async sendVoice(threadId: string, voiceBuffer: Buffer): Promise<string> {
		try {
			const res = await this.ig.entity.directThread(threadId).broadcastVoice({
				file: voiceBuffer,
			});
			return 'payload' in res ? res.payload.item_id : res.item_id;
		} catch (error) {
			this.logger.error('Failed to send voice', error);
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

	private async initializeRealtime(): Promise<void> {
		this.setRealtimeStatus('connecting');
		this.realtime = withRealtime(this.ig).realtime;

		this.realtime.on('error', error => {
			this.logger.error('Realtime Error', error);
			this.setRealtimeStatus('error');
			this.emit('error', error);
		});

		this.realtime.on('close', () => {
			this.setRealtimeStatus('disconnected');
		});

		this.realtime.on('message', (wrapper: any) => {
			this.logger.debug(`Received MQTT "message": ${JSON.stringify(wrapper)}`);

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

		await this.realtime.connect({
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
