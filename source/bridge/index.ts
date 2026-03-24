import path from 'node:path';
import type {Bot, Context} from 'grammy';
import type Database from 'better-sqlite3';
import {InstagramClient} from '../client.js';
import {ConfigManager} from '../config.js';
import {initializeLogger} from '../utils/logger.js';
import type {Message as IGMessage, ReactionEvent} from '../types/instagram.js';
import {loadBridgeConfig, type BridgeConfig} from './config.js';
import {initDatabase} from './db.js';
import {createBot} from './telegram.js';
import {routeIncomingIGMessage, routeIGReaction} from './sync.js';
import {ensureTopicForThread} from './mapper.js';
import {createLogger, setLogLevel} from './logger.js';

const logger = createLogger('main');

/**
 * Shared mutable state for the Instagram client.
 * The bot starts without an IG connection; the user logs in via /login.
 */
export const igState: {client: InstagramClient | null} = {client: null};

/**
 * Hooks the IG realtime events into the message router.
 */
export function hookIGEvents(
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): void {
	ig.on('message', (message: IGMessage) => {
		routeIncomingIGMessage(message, ig, bot, db, config).catch(error => {
			logger.error('Error routing IG message', error);
		});
	});

	ig.on('reaction', (reaction: ReactionEvent) => {
		routeIGReaction(reaction, ig, bot, db, config).catch(error => {
			logger.error('Error routing IG reaction', error);
		});
	});

	ig.on('error', (error: Error) => {
		logger.error('Instagram client error', error);
	});

	ig.on('realtimeStatus', (status: string) => {
		logger.info(`Instagram MQTT status: ${status}`);
	});
}

/**
 * Backfills recent IG threads to ensure topics exist in Telegram.
 */
export async function backfillRecentThreads(
	ig: InstagramClient,
	db: Database.Database,
	bot: Bot<Context>,
	config: BridgeConfig,
): Promise<void> {
	logger.info(`Backfilling last ${config.bridge.backfill_count} threads...`);

	// Collect threads first, then create topics oldest-first so the most
	// recently active thread is created last and appears at the top in Telegram.
	type ThreadInfo = {
		thread: import('../types/instagram.js').Thread;
		user: import('../types/instagram.js').User;
		isGroup: boolean;
	};
	const collected: ThreadInfo[] = [];

	let hasMore = true;
	let isFirst = true;

	while (collected.length < config.bridge.backfill_count && hasMore) {
		const result = await ig.getThreads(!isFirst);
		isFirst = false;
		hasMore = result.hasMore;

		for (const thread of result.threads) {
			if (collected.length >= config.bridge.backfill_count) break;

			const otherUsers = thread.users.filter(u => u.pk !== ig.getUserId());
			const user = otherUsers[0];
			if (!user) continue;

			collected.push({thread, user, isGroup: otherUsers.length > 1});
		}
	}

	// Reverse: create oldest threads first so newest end up on top
	collected.reverse();

	for (const {thread, user, isGroup} of collected) {
		try {
			await ensureTopicForThread(
				bot, db, config,
				thread.id,
				user.username || thread.title,
				user.fullName || '',
				user.pk,
				isGroup,
				isGroup ? thread.title : undefined,
			);
			// Pace API calls to avoid Telegram rate limits
			await new Promise(r => setTimeout(r, 500));
		} catch (error) {
			logger.error(`Backfill: failed to ensure topic for thread ${thread.id}`, error);
		}
	}

	logger.info(`Backfill complete: ${collected.length} threads processed`);
}


async function main(): Promise<void> {
	// 1. Load config
	const configPath = process.argv[2] || './config.yaml';
	const config = loadBridgeConfig(configPath);

	setLogLevel(config.bridge.log_level);
	logger.info('Config loaded');

	// 2. Initialize internal config manager (for session/IG client)
	const configManager = ConfigManager.getInstance();
	await configManager.initialize();
	await initializeLogger();

	// 3. Initialize SQLite
	const dbDir = path.dirname(config.bridge.db_path);
	const fs = await import('node:fs');
	fs.mkdirSync(dbDir, {recursive: true});
	const db = initDatabase(config.bridge.db_path);

	// 4. Initialize Telegram bot (starts without IG connection)
	const bot = createBot(config, db);

	// 5. Try auto-reconnect from saved session
	const savedUsername = configManager.get('login.currentUsername');
	if (savedUsername) {
		logger.info(`Found saved session for @${savedUsername}, attempting auto-login...`);
		try {
			const ig = new InstagramClient(savedUsername);
			const result = await ig.loginBySession();
			if (result.success) {
				igState.client = ig;
				hookIGEvents(ig, bot, db, config);
				logger.info(`Auto-logged in as @${result.username}`);

				if (config.bridge.backfill_on_start) {
					try {
						await backfillRecentThreads(ig, db, bot, config);
					} catch (error) {
						logger.error('Backfill failed (non-fatal)', error);
					}
				}
			} else {
				logger.warn(`Session login failed: ${result.error}. Use /login in Telegram to authenticate.`);
			}
		} catch (error) {
			logger.warn(`Session auto-login error: ${(error as Error).message}. Use /login in Telegram.`);
		}
	} else {
		logger.info('No saved session. Use /login in the Telegram supergroup to connect Instagram.');
	}

	// 6. Start Telegram polling
	logger.info('Starting Telegram bot polling...');
	bot.start({
		allowed_updates: ['message'],
		onStart: () => {
			logger.info('Bridge is running. Press Ctrl+C to stop.');
		},
	});

	// 7. Graceful shutdown
	const shutdown = async () => {
		logger.info('Shutting down...');
		if (igState.client) {
			await igState.client.shutdown();
		}
		bot.stop();
		db.close();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
