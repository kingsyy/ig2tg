import type {Bot, Context} from 'grammy';
import type {ReactionTypeEmoji} from '@grammyjs/types';
import type Database from 'better-sqlite3';
import type {InstagramClient} from '../client.js';
import type {Message as IGMessage, ReactionEvent} from '../types/instagram.js';
import type {BridgeConfig} from './config.js';
import {
	messageExists,
	logMessage,
	logTag,
	getMessageByIgId,
	getMessageByTgId,
	getThreadByTopicId,
	setThreadIsGroup,
	hasRecentBridgeSend,
	isOwnOutboundEcho,
	type ThreadMapping,
} from './db.js';
import {ensureTopicForThread} from './mapper.js';
import {forwardMediaToTelegram} from './media.js';
import {enqueue, processRecord, type OutboundPayload, type ProcessDeps} from './outbound.js';
import {createLogger} from './logger.js';
import {describeError, errorClass, logFields} from '../utils/redact.js';

const logger = createLogger('sync');

/**
 * Fallback echo window for payload types where the bridge cannot choose the
 * client_context (photo, video, voice) and Instagram's echo carries a different
 * item ID than the broadcast response. Text sends are matched exactly on
 * client_context instead, so they do not need this.
 */
const MEDIA_ECHO_WINDOW_SECONDS = 45;

export type InboundOutcome = 'forwarded' | 'skipped' | 'failed';

export type InboundOptions = {
	/** Where the message came from. Only used for logging. */
	source?: 'realtime' | 'reconcile';
};

// ─── IG → Telegram ──────────────────────────────────────

/**
 * Routes an incoming Instagram message to Telegram.
 *
 * Returns `failed` rather than throwing when delivery does not succeed. A failed
 * message is deliberately *not* written to `message_log`, which is what lets
 * reconciliation find and re-deliver it later.
 */
export async function routeIncomingIGMessage(
	message: IGMessage,
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
	options: InboundOptions = {},
): Promise<InboundOutcome> {
	const myUserId = ig.getUserId();
	const messageId = message.id;
	const threadId = message.threadId;
	const source = options.source ?? 'realtime';

	const baseLog = {
		direction: 'ig_to_tg',
		source,
		content_type: message.itemType,
		thread_hash: logTag(threadId),
		message_hash: logTag(messageId),
	};

	// STEP 1: Dedup — already delivered?
	if (messageExists(db, messageId)) {
		logger.debug(`Dedup: already seen ${logFields(baseLog)}`);
		return 'skipped';
	}

	const isSelf = message.userId === myUserId;

	// STEP 2: Echo suppression for messages the bridge itself sent.
	if (isSelf && isBridgeEcho(db, message)) {
		logMessage(db, {
			ig_message_id: messageId,
			tg_message_id: 0,
			ig_thread_id: threadId,
			direction: 'tg_to_ig',
			content_type: message.itemType,
			client_context: message.client_context ?? null,
		});
		logger.debug(`Echo suppressed: ${logFields(baseLog)}`);
		return 'skipped';
	}

	if (isSelf && !config.bridge.forward_own_messages) {
		logger.debug(`Own message not forwarded (disabled): ${logFields(baseLog)}`);
		return 'skipped';
	}

	try {
		// STEP 3: Ensure a topic exists for this thread.
		const username = message.username || 'unknown';
		const mapping = await ensureTopicForThread(
			bot, db, config, threadId,
			username, '', message.userId,
		);

		// Auto-detect group: if the stored user differs from the sender, it's a group.
		if (
			!mapping.is_group &&
			!isSelf &&
			mapping.ig_user_id &&
			message.userId !== mapping.ig_user_id
		) {
			setThreadIsGroup(db, threadId);
			mapping.is_group = 1;
			logger.info(`Thread ${logTag(threadId)} detected as group (multiple senders)`);
		}

		// STEP 4: Forward.
		const prefix = isSelf
			? '📤 You'
			: mapping.is_group
				? `@${username}`
				: null;

		await forwardToTelegram(
			bot, ig, db, config, message, mapping.tg_topic_id,
			isSelf ? 'ig_self_to_tg' : 'ig_to_tg',
			prefix,
		);

		return 'forwarded';
	} catch (error) {
		logger.error(
			`Inbound delivery failed: ${logFields({
				...baseLog,
				result: 'failed',
				error_class: errorClass(error),
			})} detail=${describeError(error)}`,
		);
		return 'failed';
	}
}

/**
 * True when this self-authored Instagram message is the echo of a send the
 * bridge made.
 *
 * Exact client_context matching handles text. Photo, video and voice go through
 * Instagram's upload flow, where the bridge cannot supply a client_context and
 * the echoed item ID differs from the broadcast response, so those fall back to
 * a short per-thread time window.
 */
function isBridgeEcho(db: Database.Database, message: IGMessage): boolean {
	if (message.client_context && isOwnOutboundEcho(db, message.client_context)) {
		return true;
	}

	if (message.itemType === 'text') return false;

	return hasRecentBridgeSend(db, message.threadId, MEDIA_ECHO_WINDOW_SECONDS);
}

/**
 * Forwards a single IG message to the corresponding Telegram topic.
 * Throws when delivery fails, so the caller can leave it unlogged for retry.
 */
async function forwardToTelegram(
	bot: Bot<Context>,
	ig: InstagramClient,
	db: Database.Database,
	config: BridgeConfig,
	message: IGMessage,
	topicId: number,
	direction: 'ig_to_tg' | 'ig_self_to_tg',
	prefix: string | null,
): Promise<void> {
	const chatId = config.telegram.supergroup_id;
	let tgMessageId = 0;

	// Resolve reply-to: if the IG message replies to another, find the TG message
	let replyTo: number | undefined;
	if (message.repliedTo?.id) {
		const repliedEntry = getMessageByIgId(db, message.repliedTo.id);
		if (repliedEntry && repliedEntry.tg_message_id > 0) {
			replyTo = repliedEntry.tg_message_id;
		}
	}
	const replyParams = replyTo
		? {reply_parameters: {message_id: replyTo, allow_sending_without_reply: true as const}}
		: {};

	switch (message.itemType) {
		case 'text': {
			const text = prefix ? `${prefix}: ${message.text}` : message.text;
			const sent = await bot.api.sendMessage(chatId, text, {
				message_thread_id: topicId,
				...replyParams,
			});
			tgMessageId = sent.message_id;
			break;
		}

		case 'media': {
			const caption = prefix ? `${prefix}:` : undefined;
			tgMessageId = await forwardMediaToTelegram(
				bot, ig, chatId, topicId, message, caption, replyTo,
			);
			break;
		}

		case 'voice': {
			const voiceBuffer = await ig.downloadMedia(message.voiceUrl);
			const {InputFile} = await import('grammy');
			const inputFile = new InputFile(voiceBuffer, 'voice.ogg');
			const sent = await bot.api.sendVoice(chatId, inputFile, {
				message_thread_id: topicId,
				caption: prefix ? `${prefix}:` : undefined,
				duration: Math.round(message.voiceDuration / 1000),
				...replyParams,
			});
			tgMessageId = sent.message_id;
			break;
		}

		case 'link': {
			const linkText = prefix
				? `${prefix}: ${message.link.text}\n${message.link.url}`
				: `${message.link.text}\n${message.link.url}`;
			const sent = await bot.api.sendMessage(chatId, linkText, {
				message_thread_id: topicId,
				...replyParams,
			});
			tgMessageId = sent.message_id;
			break;
		}

		case 'media_share': {
			const post = message.mediaSharePost;
			const shareText = prefix
				? `${prefix}: [Shared post by @${post.user.username}]`
				: `[Shared post by @${post.user.username}]`;
			const sent = await bot.api.sendMessage(chatId, shareText, {
				message_thread_id: topicId,
				...replyParams,
			});
			tgMessageId = sent.message_id;
			break;
		}

		case 'placeholder':
		default: {
			// Disappearing media arrives here as an explicit notice from the parser.
			// Nothing is downloaded, opened, or marked as viewed.
			const placeholderText = prefix
				? `${prefix}: ${message.text}`
				: message.text;
			const sent = await bot.api.sendMessage(chatId, placeholderText, {
				message_thread_id: topicId,
				...replyParams,
			});
			tgMessageId = sent.message_id;
			break;
		}
	}

	// Unpin — Telegram auto-pins the first message in a new topic
	try {
		await bot.api.unpinChatMessage(chatId, tgMessageId);
	} catch {
		// Not pinned or no permission — fine
	}

	// Log for dedup, reply-chaining, and native reply mapping.
	logMessage(db, {
		ig_message_id: message.id,
		tg_message_id: tgMessageId,
		ig_thread_id: message.threadId,
		direction,
		content_type: message.itemType,
		ig_item_id: message.id,
		client_context: message.client_context ?? null,
	});

	logger.debug(
		`Forwarded IG→TG: ${logFields({
			thread_hash: logTag(message.threadId),
			topic_id: topicId,
			tg_message_id: tgMessageId,
			content_type: message.itemType,
			direction,
		})}`,
	);
}

// ─── Telegram → IG ──────────────────────────────────────

export type ReplyResolution = {
	/** The Instagram item ID to reply to, when one could be resolved. */
	itemId: string | null;
	/** True when the user replied to something the bridge cannot map back to Instagram. */
	unmapped: boolean;
};

export type TelegramReplyContext = {
	message_id: number;
	forum_topic_created?: unknown;
};

/**
 * Turns a Telegram reply into an Instagram item ID.
 *
 * The quoted message must map to an Instagram item in the *same* thread —
 * replying across topics would attach the reply to a stranger's conversation, so
 * that is rejected. When nothing can be resolved, the caller sends an ordinary
 * message rather than refusing the text.
 */
export function resolveReplyTarget(
	db: Database.Database,
	replyTo: TelegramReplyContext | undefined,
	topicId: number,
	mapping: ThreadMapping,
): ReplyResolution {
	if (!replyTo) return {itemId: null, unmapped: false};

	// In a forum topic, Telegram points the first messages at the topic's own
	// creation service message. That is not a user reply.
	if (replyTo.forum_topic_created !== undefined) return {itemId: null, unmapped: false};
	if (replyTo.message_id === topicId) return {itemId: null, unmapped: false};

	const entry = getMessageByTgId(db, replyTo.message_id);
	if (!entry?.ig_item_id) return {itemId: null, unmapped: true};

	if (entry.ig_thread_id !== mapping.ig_thread_id) {
		logger.warn(
			`Reply target belongs to another thread; sending without reply: ${logFields({
				tg_message_id: replyTo.message_id,
				topic_id: topicId,
			})}`,
		);
		return {itemId: null, unmapped: true};
	}

	return {itemId: entry.ig_item_id, unmapped: false};
}

/**
 * Builds the durable payload for an outgoing Telegram message.
 *
 * Media is stored as a Telegram `file_id` rather than bytes: the file can be
 * re-fetched on a retry, including after a container restart, without keeping a
 * copy of its contents.
 */
export function buildOutboundPayload(tgMessage: {
	text?: string;
	photo?: Array<{file_id: string}>;
	video?: {file_id: string};
	voice?: {file_id: string};
}): OutboundPayload | undefined {
	if (tgMessage.text) return {kind: 'text', text: tgMessage.text};

	if (tgMessage.photo && tgMessage.photo.length > 0) {
		const largest = tgMessage.photo[tgMessage.photo.length - 1]!;
		return {kind: 'photo', file_id: largest.file_id};
	}

	if (tgMessage.video) return {kind: 'video', file_id: tgMessage.video.file_id};
	if (tgMessage.voice) return {kind: 'voice', file_id: tgMessage.voice.file_id};

	return undefined;
}

/**
 * Handles a message sent in a Telegram topic, routing it to Instagram through the
 * durable outbound queue.
 */
export async function routeTelegramToIG(
	ctx: Context,
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): Promise<void> {
	const tgMessage = ctx.message;
	if (!tgMessage?.message_thread_id) return;

	// Only allow the owner to send via the bridge
	if (tgMessage.from?.id !== config.telegram.owner_id) return;

	const topicId = tgMessage.message_thread_id;
	const mapping = getThreadByTopicId(db, topicId);
	if (!mapping) {
		logger.warn(`No IG thread mapping for topic ${topicId}`);
		return;
	}

	const payload = buildOutboundPayload(tgMessage);
	if (!payload) {
		await ctx
			.reply('[Unsupported message type — only text, photo, video, voice are supported]', {
				message_thread_id: topicId,
			})
			.catch(() => {});
		return;
	}

	const reply = resolveReplyTarget(db, tgMessage.reply_to_message, topicId, mapping);
	if (reply.unmapped) {
		logger.info(
			`Reply relationship could not be preserved: ${logFields({
				thread_hash: logTag(mapping.ig_thread_id),
				tg_message_id: tgMessage.message_id,
			})}`,
		);
	}

	// Persist before contacting Instagram, so a crash here cannot lose the text.
	const {record, created} = enqueue(db, {
		tgChatId: tgMessage.chat.id,
		tgTopicId: topicId,
		tgMessageId: tgMessage.message_id,
		igThreadId: mapping.ig_thread_id,
		payload,
		replyToIgItemId: payload.kind === 'text' ? reply.itemId : null,
	});

	if (!created) return;

	const deps: ProcessDeps = {db, ig, api: ctx.api, bot, config};
	await processRecord(deps, record.id);
}

// ─── Reactions ──────────────────────────────────────────

/**
 * Routes an Instagram reaction to the corresponding Telegram message.
 */
export async function routeIGReaction(
	reaction: ReactionEvent,
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): Promise<void> {
	const myUserId = ig.getUserId();

	// Ignore own reactions from the bridge (echo prevention)
	if (reaction.userId === myUserId) return;

	// Find the TG message corresponding to this IG message
	const msgEntry = getMessageByIgId(db, reaction.itemId);
	if (!msgEntry || msgEntry.tg_message_id === 0) {
		logger.debug(`No TG message for reacted IG item ${logTag(reaction.itemId)}`);
		return;
	}

	const tgEmoji = mapIGEmojiToTG(reaction.emoji);
	if (!tgEmoji) return;

	try {
		await bot.api.setMessageReaction(
			config.telegram.supergroup_id,
			msgEntry.tg_message_id,
			[{type: 'emoji', emoji: tgEmoji}],
		);
	} catch (error) {
		logger.error(`Failed to set TG reaction: ${describeError(error)}`);
	}
}

/**
 * Telegram only allows a specific set of emojis for reactions.
 * Maps an IG emoji to a valid TG reaction emoji, or null if unsupported.
 */
const TG_ALLOWED_EMOJIS = new Set([
	'👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢',
	'🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳',
	'❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓',
	'🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈',
	'😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
	'🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

function mapIGEmojiToTG(emoji: string): ReactionTypeEmoji['emoji'] | null {
	// IG default "like" uses ❤ or ❤️, TG expects ❤
	if (emoji === '❤️' || emoji === '❤') return '❤';
	if (TG_ALLOWED_EMOJIS.has(emoji)) return emoji as ReactionTypeEmoji['emoji'];
	return null;
}
