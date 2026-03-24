import {GrammyError} from 'grammy';
import type {Bot, Context} from 'grammy';
import type Database from 'better-sqlite3';
import type {BridgeConfig} from './config.js';
import {
	getThreadByIgId,
	createThreadMapping,
	type ThreadMapping,
} from './db.js';
import {createLogger} from './logger.js';

const logger = createLogger('mapper');

const MAX_RETRIES = 3;

async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Formats a topic name from the config template.
 */
function formatTopicName(
	format: string,
	username: string,
	fullName: string,
): string {
	return format
		.replace('{username}', username)
		.replace('{full_name}', fullName);
}

/**
 * Ensures a Telegram forum topic exists for the given IG thread.
 * Creates one if it doesn't exist yet.
 */
export async function ensureTopicForThread(
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
	threadId: string,
	username: string,
	fullName: string,
	userId: string,
	isGroup = false,
	groupTitle?: string,
): Promise<ThreadMapping> {
	// Check if mapping already exists
	const existing = getThreadByIgId(db, threadId);
	if (existing) return existing;

	// Create a new forum topic in the supergroup
	const topicName = isGroup && groupTitle
		? `👥 ${groupTitle}`
		: formatTopicName(config.bridge.topic_name_format, username, fullName);

	logger.info(`Creating topic for ${isGroup ? `group "${groupTitle}"` : `@${username}`}: "${topicName}"`);

	let topic: Awaited<ReturnType<typeof bot.api.createForumTopic>>;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			topic = await bot.api.createForumTopic(
				config.telegram.supergroup_id,
				topicName,
			);
			break;
		} catch (error) {
			if (error instanceof GrammyError && error.error_code === 429) {
				const retryAfter = (error.parameters as any)?.retry_after ?? 30;
				logger.warn(`Rate-limited creating topic for @${username}, retrying in ${retryAfter}s (attempt ${attempt}/${MAX_RETRIES})`);
				if (attempt < MAX_RETRIES) {
					await sleep(retryAfter * 1000);
					continue;
				}
			}
			throw error;
		}
	}

	// Safety — if loop ended without setting topic, the throw above handles it
	topic = topic!;

	const mapping = createThreadMapping(db, {
		ig_thread_id: threadId,
		ig_username: isGroup ? (groupTitle || username) : username,
		ig_full_name: fullName,
		ig_user_id: userId,
		tg_topic_id: topic.message_thread_id,
		is_group: isGroup ? 1 : 0,
	});

	logger.info(`Mapped IG thread ${threadId} → TG topic ${topic.message_thread_id}`);
	return mapping;
}
