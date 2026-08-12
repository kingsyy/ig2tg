import path from 'node:path';
import type {Bot, Context} from 'grammy';
import type Database from 'better-sqlite3';
import {InstagramClient, type RealtimeStatus} from '../client.js';
import {ConfigManager} from '../config.js';
import {initializeLogger} from '../utils/logger.js';
import type {Message as IGMessage, ReactionEvent} from '../types/instagram.js';
import {loadBridgeConfig, type BridgeConfig} from './config.js';
import {initDatabase, logTag} from './db.js';
import {createBot} from './telegram.js';
import {routeIncomingIGMessage, routeIGReaction} from './sync.js';
import {ensureTopicForThread} from './mapper.js';
import {
	cancelInboundRetries,
	collectRecentThreads,
	reconcileRecentMessages,
	scheduleInboundRetry,
} from './reconcile.js';
import {OutboundWorker, type ProcessDeps} from './outbound.js';
import {bridgeHealth} from './health.js';
import {ConnectionNotifier} from './connection.js';
import {NOTICES, ThrottledNotice} from './notifier.js';
import {createLogger, setLogLevel} from './logger.js';
import {describeError, errorClass, logFields} from '../utils/redact.js';

const logger = createLogger('main');

/**
 * Shared mutable state for the Instagram client.
 * The bot starts without an IG connection; the user logs in via /login.
 */
export const igState: {client: InstagramClient | null} = {client: null};

/** At most one inbound-failure notice every 10 minutes. */
const inboundFailureNotice = new ThrottledNotice(NOTICES.inboundFailure, 10 * 60 * 1000);

export const outboundWorker = new OutboundWorker(() => outboundDeps);
let outboundDeps: ProcessDeps | undefined;

let connectionNotifier: ConnectionNotifier | undefined;

/**
 * Hooks the IG realtime events into the message router.
 */
export function hookIGEvents(
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): void {
	connectionNotifier?.dispose();
	connectionNotifier = new ConnectionNotifier({
		bot,
		config,
		isDegraded: () => bridgeHealth.isDegraded(),
		reconcile: async () => reconcileRecentMessages(ig, bot, db, config),
	});
	outboundDeps = {db, ig, api: bot.api, bot, config};
	inboundFailureNotice.reset();

	// Realtime usually connects during login, before these listeners exist, so seed
	// the health state from the client rather than assuming 'disconnected'.
	bridgeHealth.reset();
	bridgeHealth.setRealtimeStatus(ig.getRealtimeStatus());

	ig.on('message', (message: IGMessage) => {
		bridgeHealth.markRealtimeEvent();
		void (async () => {
			try {
				const outcome = await routeIncomingIGMessage(message, ig, bot, db, config);
				if (outcome !== 'failed') return;

				// Not written to message_log, so reconciliation can still find it.
				bridgeHealth.markInboundFailure();
				scheduleInboundRetry(message.threadId, ig, bot, db, config);
				await inboundFailureNotice.maybeSend(bot, config);
			} catch (error) {
				logger.error(`Error routing IG message: ${describeError(error)}`);
			}
		})();
	});

	ig.on('reaction', (reaction: ReactionEvent) => {
		bridgeHealth.markRealtimeEvent();
		routeIGReaction(reaction, ig, bot, db, config).catch(error => {
			logger.error(`Error routing IG reaction: ${describeError(error)}`);
		});
	});

	ig.on('error', (error: Error) => {
		logger.error(`Instagram client error: ${errorClass(error)}`);
	});

	ig.on('realtimeStatus', (status: RealtimeStatus) => {
		bridgeHealth.setRealtimeStatus(status);
		bridgeHealth.reconnectAttempts = ig.getReconnectAttempt();
		logger.info(`Instagram realtime status: ${status}`);
		connectionNotifier?.onStatus(status);
	});

	ig.on('realtimeReconnected', () => {
		void connectionNotifier?.onReconnected();
	});
}

/**
 * Detaches bridge state from the Instagram client. Called on /logout so a pending
 * disconnect warning does not fire for a connection the user closed deliberately,
 * and so the outbound worker stops attempting sends with no session.
 */
export function detachIGEvents(): void {
	connectionNotifier?.dispose();
	connectionNotifier = undefined;
	outboundDeps = undefined;
	cancelInboundRetries();
	bridgeHealth.reset();
}

/**
 * Ensures a Telegram topic exists for each recent IG thread.
 *
 * This creates mappings only. Recovering missed *messages* is
 * `reconcileRecentMessages`, which `/sync` runs after this.
 */
export async function backfillRecentThreads(
	ig: InstagramClient,
	db: Database.Database,
	bot: Bot<Context>,
	config: BridgeConfig,
): Promise<void> {
	logger.info(`Backfilling last ${config.bridge.backfill_count} threads...`);

	const threads = await collectRecentThreads(ig, config.bridge.backfill_count);

	// Reverse: create oldest threads first so the newest end up on top in Telegram.
	const ordered = [...threads].reverse();

	let processed = 0;
	for (const thread of ordered) {
		const otherUsers = thread.users.filter(u => u.pk !== ig.getUserId());
		const user = otherUsers[0];
		if (!user) continue;

		const isGroup = otherUsers.length > 1;

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
			processed++;
			// Pace API calls to avoid Telegram rate limits
			await new Promise(r => setTimeout(r, 500));
		} catch (error) {
			logger.error(
				`Backfill: failed to ensure topic: ${logFields({
					thread_hash: logTag(thread.id),
					error_class: errorClass(error),
				})}`,
			);
		}
	}

	logger.info(`Backfill complete: ${processed} thread(s) processed`);
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
	bridgeHealth.restore(db);

	// 4. Initialize Telegram bot (starts without IG connection)
	const bot = createBot(config, db);

	// 5. Recover any outgoing messages a restart interrupted, and start the
	//    retry worker. This runs even without Instagram: records stay queued
	//    until a connection exists.
	outboundWorker.start(db, config);

	// 6. Try auto-reconnect from saved session
	let startupReconciliation: InstagramClient | undefined;
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
						logger.error(`Backfill failed (non-fatal): ${describeError(error)}`);
					}
				}

				startupReconciliation = ig;
			} else {
				logger.warn(`Session login failed: ${result.error}. Use /login in Telegram to authenticate.`);
			}
		} catch (error) {
			logger.warn(`Session auto-login error: ${errorClass(error)}. Use /login in Telegram.`);
		}
	} else {
		logger.info('No saved session. Use /login in the Telegram supergroup to connect Instagram.');
	}

	// 7. Start Telegram polling
	logger.info('Starting Telegram bot polling...');
	bot.start({
		allowed_updates: ['message'],
		onStart: () => {
			logger.info('Bridge is running. Press Ctrl+C to stop.');
		},
	});

	// 8. A restart is itself a realtime gap: anything that arrived while the bridge
	//    was down was never forwarded. This runs after polling starts so Telegram
	//    stays responsive while the (paced) check works through recent threads.
	if (startupReconciliation) {
		const ig = startupReconciliation;
		void reconcileRecentMessages(ig, bot, db, config).catch(error => {
			logger.error(`Startup reconciliation failed (non-fatal): ${describeError(error)}`);
		});
	}

	// 9. Graceful shutdown
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info('Shutting down...');
		outboundWorker.stop();
		cancelInboundRetries();
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
	// Config-validation errors are reported by field path only. The parsed config
	// contains the Telegram bot token, so the raw error must never be printed.
	const issues = (error as {issues?: Array<{path?: unknown[]; message?: string}>} | null)?.issues;
	if (Array.isArray(issues)) {
		const paths = issues
			.map(issue => `${(issue.path ?? []).join('.') || '(root)'}: ${issue.message ?? 'invalid'}`)
			.join('; ');
		console.error(`Fatal config error: ${paths}`);
	} else {
		console.error(`Fatal error: ${describeError(error)}`);
	}

	process.exit(1);
});
