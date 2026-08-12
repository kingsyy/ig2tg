import Database from 'better-sqlite3';
import type {Bot, Context} from 'grammy';
import type {BridgeConfig} from '../source/bridge/config.js';
import {createThreadMapping, runMigrations} from '../source/bridge/db.js';
import {setLogLevel} from '../source/bridge/logger.js';
import type {Message as IGMessage, Thread} from '../source/types/instagram.js';
import type {InstagramClient} from '../source/client.js';

// Keep expected-path warnings out of the test output; failures still print.
setLogLevel('error');

export const CHAT_ID = -1_001_234_567_890;
export const OWNER_ID = 42;
export const MY_USER_ID = '1000';
export const PEER_USER_ID = '2000';

/** An in-memory database with the production schema applied. */
export function testDb(): Database.Database {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	runMigrations(db);
	return db;
}

export function testConfig(overrides: Partial<BridgeConfig['bridge']> = {}): BridgeConfig {
	return {
		telegram: {
			bot_token: 'test-token',
			supergroup_id: CHAT_ID,
			owner_id: OWNER_ID,
		},
		bridge: {
			db_path: ':memory:',
			media_timeout_ms: 15_000,
			backfill_on_start: false,
			backfill_count: 20,
			topic_name_format: '@{username}',
			log_level: 'error',
			reconcile_thread_count: 5,
			reconcile_message_count: 10,
			forward_own_messages: true,
			disconnect_warn_after_seconds: 45,
			outbound_max_attempts: 4,
			outbound_retention_days: 7,
			...overrides,
		},
	};
}

export function mapThread(
	db: Database.Database,
	igThreadId: string,
	tgTopicId: number,
	options: {username?: string; userId?: string; isGroup?: boolean} = {},
) {
	return createThreadMapping(db, {
		ig_thread_id: igThreadId,
		ig_username: options.username ?? 'peer',
		ig_full_name: '',
		ig_user_id: options.userId ?? PEER_USER_ID,
		tg_topic_id: tgTopicId,
		is_group: options.isGroup ? 1 : 0,
	});
}

// ─── Telegram fake ──────────────────────────────────────

export type SentMessage = {
	method: string;
	chatId: number;
	text?: string;
	topicId?: number;
	replyToMessageId?: number;
};

/**
 * A minimal grammY `Bot` stand-in. Only the methods the bridge actually calls
 * are implemented; anything else surfaces as a test failure rather than silently
 * passing.
 */
export class FakeBot {
	readonly sent: SentMessage[] = [];
	readonly createdTopics: string[] = [];

	/** Queue of errors to throw, one per `sendMessage`/`createForumTopic` call. */
	sendFailures: Array<Error | undefined> = [];
	topicFailures: Array<Error | undefined> = [];

	private nextMessageId = 1000;
	private nextTopicId = 10;

	readonly api = {
		token: 'test-token',
		sendMessage: async (chatId: number, text: string, options?: any) => {
			const failure = this.sendFailures.shift();
			if (failure) throw failure;

			this.sent.push({
				method: 'sendMessage',
				chatId,
				text,
				topicId: options?.message_thread_id,
				replyToMessageId: options?.reply_parameters?.message_id,
			});
			return {message_id: this.nextMessageId++};
		},
		sendPhoto: async (chatId: number, _file: unknown, options?: any) => {
			this.sent.push({method: 'sendPhoto', chatId, topicId: options?.message_thread_id});
			return {message_id: this.nextMessageId++};
		},
		sendVideo: async (chatId: number, _file: unknown, options?: any) => {
			this.sent.push({method: 'sendVideo', chatId, topicId: options?.message_thread_id});
			return {message_id: this.nextMessageId++};
		},
		sendVoice: async (chatId: number, _file: unknown, options?: any) => {
			this.sent.push({method: 'sendVoice', chatId, topicId: options?.message_thread_id});
			return {message_id: this.nextMessageId++};
		},
		createForumTopic: async (_chatId: number, name: string) => {
			const failure = this.topicFailures.shift();
			if (failure) throw failure;

			this.createdTopics.push(name);
			return {message_thread_id: this.nextTopicId++};
		},
		unpinChatMessage: async () => true,
		setMessageReaction: async () => true,
		getFile: async (fileId: string) => ({file_path: `files/${fileId}`}),
	};

	texts(): string[] {
		return this.sent.filter(s => s.text !== undefined).map(s => s.text!);
	}

	asBot(): Bot<Context> {
		return this as unknown as Bot<Context>;
	}
}

// ─── Instagram fake ─────────────────────────────────────

export type SentToInstagram = {
	threadId: string;
	kind: 'text' | 'photo' | 'video' | 'voice';
	text?: string;
	replyToItemId?: string;
	clientContext?: string;
};

/**
 * A stand-in for `InstagramClient`. Records what was sent so tests can assert on
 * reply targets and idempotency tokens, and can be told to fail a given number
 * of times.
 */
export class FakeInstagramClient {
	readonly sent: SentToInstagram[] = [];
	readonly downloadedMedia: string[] = [];

	/** Errors thrown by the next sends, consumed one per call. */
	sendFailures: Array<Error | undefined> = [];

	threads: Thread[] = [];
	messagesByThread = new Map<string, IGMessage[]>();
	sessionValid = true;

	private nextItemId = 1;

	getUserId(): string {
		return MY_USER_ID;
	}

	getUsername(): string {
		return 'me';
	}

	getRealtimeStatus(): string {
		return 'connected';
	}

	getLastRealtimeEventAt(): Date | undefined {
		return undefined;
	}

	getReconnectAttempt(): number {
		return 0;
	}

	async checkSession(): Promise<boolean> {
		return this.sessionValid;
	}

	async sendMessage(
		threadId: string,
		text: string,
		options: {replyToItemId?: string; clientContext?: string} = {},
	): Promise<string> {
		const failure = this.sendFailures.shift();
		this.sent.push({
			threadId,
			kind: 'text',
			text,
			replyToItemId: options.replyToItemId,
			clientContext: options.clientContext,
		});
		if (failure) throw failure;
		return `ig-item-${this.nextItemId++}`;
	}

	async sendPhoto(threadId: string): Promise<string> {
		const failure = this.sendFailures.shift();
		this.sent.push({threadId, kind: 'photo'});
		if (failure) throw failure;
		return `ig-item-${this.nextItemId++}`;
	}

	async sendVideo(threadId: string): Promise<string> {
		const failure = this.sendFailures.shift();
		this.sent.push({threadId, kind: 'video'});
		if (failure) throw failure;
		return `ig-item-${this.nextItemId++}`;
	}

	async sendVoice(threadId: string): Promise<string> {
		const failure = this.sendFailures.shift();
		this.sent.push({threadId, kind: 'voice'});
		if (failure) throw failure;
		return `ig-item-${this.nextItemId++}`;
	}

	async getThreads(): Promise<{threads: Thread[]; hasMore: boolean}> {
		return {threads: this.threads, hasMore: false};
	}

	async getRecentMessages(threadId: string, limit: number): Promise<IGMessage[]> {
		const all = this.messagesByThread.get(threadId) ?? [];
		return limit > 0 && all.length > limit ? all.slice(-limit) : all;
	}

	/**
	 * Downloading disappearing media must never happen; tests assert this stays empty.
	 */
	async downloadMedia(url: string): Promise<Buffer> {
		this.downloadedMedia.push(url);
		return Buffer.from('media');
	}

	asClient(): InstagramClient {
		return this as unknown as InstagramClient;
	}
}

// ─── Message builders ───────────────────────────────────

export function igTextMessage(overrides: Partial<IGMessage> = {}): IGMessage {
	return {
		id: 'ig-msg-1',
		timestamp: new Date('2026-08-11T10:00:00Z'),
		userId: PEER_USER_ID,
		username: 'peer',
		isOutgoing: false,
		threadId: 'thread-1',
		itemType: 'text',
		text: 'hello',
		...overrides,
	} as IGMessage;
}

export function igPlaceholderMessage(text: string, overrides: Partial<IGMessage> = {}): IGMessage {
	return {
		id: 'ig-msg-placeholder',
		timestamp: new Date('2026-08-11T10:00:00Z'),
		userId: PEER_USER_ID,
		username: 'peer',
		isOutgoing: false,
		threadId: 'thread-1',
		itemType: 'placeholder',
		text,
		...overrides,
	} as IGMessage;
}

/** A Telegram message object shaped like the fields the bridge reads. */
export function tgMessage(overrides: Record<string, unknown> = {}): any {
	return {
		message_id: 500,
		chat: {id: CHAT_ID},
		from: {id: OWNER_ID},
		message_thread_id: 10,
		text: 'reply text',
		...overrides,
	};
}

/** A grammY `Context` stand-in carrying one message. */
export function tgContext(bot: FakeBot, message: any): Context {
	return {
		message,
		chat: message.chat,
		from: message.from,
		api: bot.api,
		async reply(text: string, options?: any) {
			return bot.api.sendMessage(message.chat.id, text, options);
		},
	} as unknown as Context;
}
