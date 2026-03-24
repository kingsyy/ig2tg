import type {Bot, Context} from 'grammy';
import type {ReactionTypeEmoji} from '@grammyjs/types';
import type Database from 'better-sqlite3';
import type {InstagramClient} from '../client.js';
import type {Message as IGMessage, ReactionEvent} from '../types/instagram.js';
import type {BridgeConfig} from './config.js';
import {
	messageExists,
	logMessage,
	getMessageByIgId,
	getThreadByTopicId,
	setThreadIsGroup,
	hasRecentBridgeSend,
} from './db.js';
import {ensureTopicForThread} from './mapper.js';
import {forwardMediaToTelegram, downloadTelegramFile} from './media.js';
import {createLogger} from './logger.js';

const logger = createLogger('sync');

// ─── IG → Telegram ──────────────────────────────────────

/**
 * Routes an incoming Instagram MQTT message event.
 * Handles dedup, echo detection, and forwarding.
 */
export async function routeIncomingIGMessage(
	message: IGMessage,
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): Promise<void> {
	const myUserId = ig.getUserId();
	const messageId = message.id;
	const threadId = message.threadId;

	// STEP 1: Dedup — already processed?
	logger.debug(`Incoming IG message: id=${messageId} thread=${threadId} sender=${message.userId} type=${message.itemType}`);
	if (messageExists(db, messageId)) {
		logger.debug(`Dedup: skipping already-seen message ${messageId}`);
		return;
	}

	// STEP 2: Ensure topic exists for this thread
	const username = message.username || 'unknown';
	const mapping = await ensureTopicForThread(
		bot, db, config, threadId,
		username, '', message.userId,
	);

	// Auto-detect group: if stored user differs from sender, it's a group thread
	const isGroup = !!mapping.is_group;
	if (!isGroup && message.userId !== myUserId && mapping.ig_user_id && message.userId !== mapping.ig_user_id) {
		setThreadIsGroup(db, threadId);
		mapping.is_group = 1;
		logger.info(`Thread ${threadId} detected as group (multiple senders)`);
	}

	// STEP 3: Classify sender
	const isSelf = message.userId === myUserId;
	const groupPrefix = mapping.is_group ? `@${username}` : null;

	if (isSelf) {
		// Fallback echo prevention: if exact ID dedup didn't catch it (can happen
		// with media where broadcast response ID differs from MQTT echo ID),
		// check if we recently sent to this thread from the bridge.
		if (hasRecentBridgeSend(db, threadId)) {
			logMessage(db, {
				ig_message_id: messageId,
				tg_message_id: 0,
				ig_thread_id: threadId,
				direction: 'tg_to_ig',
				content_type: message.itemType,
			});
			logger.debug(`Echo suppressed (fallback): ${messageId} in thread ${threadId}`);
			return;
		}

		// Genuinely from the IG app → sync to TG with prefix
		// await forwardToTelegram(
		// 	bot, ig, db, config, message, mapping.tg_topic_id,
		// 	'ig_self_to_tg', '📤 You',
		// );
	} else {
		// Someone else messaged me — add sender name in group threads
		await forwardToTelegram(
			bot, ig, db, config, message, mapping.tg_topic_id,
			'ig_to_tg', groupPrefix,
		);
	}
}

/**
 * Forwards a single IG message to the corresponding Telegram topic.
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

	try {
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

		// Log for dedup and reply-chaining
		logMessage(db, {
			ig_message_id: message.id,
			tg_message_id: tgMessageId,
			ig_thread_id: message.threadId,
			direction,
			content_type: message.itemType,
		});

		logger.debug(`Forwarded IG→TG: ${message.id} → topic ${topicId} (msg ${tgMessageId})`);
	} catch (error) {
		logger.error(`Failed to forward IG→TG: ${message.id}`, error);
	}
}

// ─── Telegram → IG ──────────────────────────────────────

/**
 * Handles a message sent in a Telegram topic, routing it to IG.
 */
export async function routeTelegramToIG(
	ctx: Context,
	ig: InstagramClient,
	db: Database.Database,
	config: BridgeConfig,
): Promise<void> {
	const tgMessage = ctx.message;
	if (!tgMessage || !tgMessage.message_thread_id) return;

	// Only allow the owner to send via the bridge
	if (tgMessage.from?.id !== config.telegram.owner_id) return;

	const mapping = getThreadByTopicId(db, tgMessage.message_thread_id);
	if (!mapping) {
		logger.warn(`No IG thread mapping for topic ${tgMessage.message_thread_id}`);
		return;
	}

	const threadId = mapping.ig_thread_id;

	try {
		let igMessageId: string;

		if (tgMessage.text) {
			igMessageId = await ig.sendMessage(threadId, tgMessage.text);
		} else if (tgMessage.photo) {
			const photo = tgMessage.photo[tgMessage.photo.length - 1]!;
			const buffer = await downloadTelegramFile(ctx.api, photo.file_id);
			igMessageId = await ig.sendPhoto(threadId, buffer);
		} else if (tgMessage.video) {
			const buffer = await downloadTelegramFile(ctx.api, tgMessage.video.file_id);
			igMessageId = await ig.sendVideo(threadId, buffer);
		} else if (tgMessage.voice) {
			const buffer = await downloadTelegramFile(ctx.api, tgMessage.voice.file_id);
			igMessageId = await ig.sendVoice(threadId, buffer);
		} else {
			await ctx.reply('[Unsupported message type — only text, photo, video, voice are supported]', {
				message_thread_id: tgMessage.message_thread_id,
			});
			return;
		}

		// Log with the real IG message ID so the MQTT echo is caught by dedup
		logMessage(db, {
			ig_message_id: igMessageId,
			tg_message_id: tgMessage.message_id,
			ig_thread_id: threadId,
			direction: 'tg_to_ig',
			content_type: tgMessage.text ? 'text' : tgMessage.photo ? 'photo' : tgMessage.video ? 'video' : 'voice',
		});

		logger.debug(`Forwarded TG→IG: topic ${tgMessage.message_thread_id} → thread ${threadId} (ig_msg_id=${igMessageId})`);
	} catch (error) {
		logger.error(`Failed to forward TG→IG: ${(error as Error).message}`, error);
		try {
			await ctx.reply(`❌ Failed to send to Instagram: ${(error as Error).message}`, {
				message_thread_id: tgMessage.message_thread_id,
			});
		} catch {}
	}
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
	if (reaction.userId === myUserId) {
		logger.debug(`Ignoring own reaction on ${reaction.itemId}`);
		return;
	}

	// Find the TG message corresponding to this IG message
	const msgEntry = getMessageByIgId(db, reaction.itemId);
	if (!msgEntry) {
		logger.debug(`No TG message found for IG message ${reaction.itemId}, skipping reaction`);
		return;
	}

	if (msgEntry.tg_message_id === 0) {
		logger.debug(`TG message ID is 0 for IG message ${reaction.itemId}, skipping reaction`);
		return;
	}

	const tgEmoji = mapIGEmojiToTG(reaction.emoji);
	if (!tgEmoji) {
		logger.debug(`No TG equivalent for IG emoji "${reaction.emoji}", skipping`);
		return;
	}

	try {
		await bot.api.setMessageReaction(
			config.telegram.supergroup_id,
			msgEntry.tg_message_id,
			[{type: 'emoji', emoji: tgEmoji}],
		);
		logger.debug(`Reaction IG→TG: ${reaction.emoji} on msg ${msgEntry.tg_message_id}`);
	} catch (error) {
		logger.error(`Failed to set TG reaction: ${(error as Error).message}`, error);
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
