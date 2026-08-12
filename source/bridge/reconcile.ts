import type {Bot, Context} from 'grammy';
import type Database from 'better-sqlite3';
import type {InstagramClient} from '../client.js';
import type {Thread} from '../types/instagram.js';
import type {BridgeConfig} from './config.js';
import {getThreadByIgId, logTag} from './db.js';
import {ensureTopicForThread} from './mapper.js';
import {routeIncomingIGMessage} from './sync.js';
import {bridgeHealth, type ReconciliationResult} from './health.js';
import {createLogger} from './logger.js';
import {describeError, logFields} from '../utils/redact.js';

const logger = createLogger('reconcile');

/** Pause between per-thread REST calls, so a reconnect is not a polling burst. */
const THREAD_PACING_MS = 1200;

/** Backoff for retrying a single thread after an inbound forwarding failure. */
const INBOUND_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Only one reconciliation runs at a time; concurrent callers get the same pass. */
let inFlight: Promise<ReconciliationResult> | undefined;

const emptyResult = (): ReconciliationResult => ({
	threadsChecked: 0,
	forwarded: 0,
	failures: 0,
	skipped: 0,
});

/**
 * Compares a bounded window of recent Instagram messages against `message_log`
 * and forwards whatever is missing, oldest-first.
 *
 * This is the bridge's answer to a realtime gap: anything that never reached
 * Telegram — because MQTT was down, because topic creation failed, or because
 * the Telegram send failed — was never logged, so it is still discoverable here.
 *
 * Bounded by `reconcile_thread_count` and `reconcile_message_count` and paced
 * between threads. It restores nothing beyond that window by design.
 */
export async function reconcileRecentMessages(
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): Promise<ReconciliationResult> {
	if (inFlight) {
		logger.info('Reconciliation already running; joining the in-flight pass');
		return inFlight;
	}

	inFlight = runReconciliation(ig, bot, db, config);
	try {
		return await inFlight;
	} finally {
		inFlight = undefined;
	}
}

async function runReconciliation(
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): Promise<ReconciliationResult> {
	const result = emptyResult();
	const threads = await collectRecentThreads(ig, config.bridge.reconcile_thread_count);

	logger.info(`Reconciling ${threads.length} recent thread(s)`);

	for (const [index, thread] of threads.entries()) {
		if (index > 0) await sleep(THREAD_PACING_MS);

		try {
			await ensureThreadMapping(ig, bot, db, config, thread);
			const threadResult = await reconcileThread(ig, bot, db, config, thread.id);
			result.threadsChecked++;
			result.forwarded += threadResult.forwarded;
			result.failures += threadResult.failures;
			result.skipped += threadResult.skipped;
		} catch (error) {
			result.failures++;
			logger.error(
				`Reconciliation failed for a thread: ${logFields({
					thread_hash: logTag(thread.id),
					error_class: describeError(error),
				})}`,
			);
		}
	}

	bridgeHealth.recordReconciliation(db, result);
	logger.info(
		`Reconciliation complete: ${logFields({
			threads_checked: result.threadsChecked,
			forwarded: result.forwarded,
			skipped: result.skipped,
			failures: result.failures,
		})}`,
	);

	return result;
}

/**
 * Reconciles one thread. Kept separate so an inbound failure can retry just the
 * affected thread instead of sweeping the whole inbox again.
 */
async function reconcileThread(
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
	threadId: string,
): Promise<{forwarded: number; failures: number; skipped: number}> {
	const counts = {forwarded: 0, failures: 0, skipped: 0};

	const messages = await ig.getRecentMessages(
		threadId,
		config.bridge.reconcile_message_count,
	);

	// Oldest-first, so a recovered conversation reads in the right order.
	for (const message of messages) {
		const outcome = await routeIncomingIGMessage(message, ig, bot, db, config, {
			source: 'reconcile',
		});

		if (outcome === 'forwarded') counts.forwarded++;
		else if (outcome === 'failed') counts.failures++;
		else counts.skipped++;
	}

	return counts;
}

/**
 * Reconciles a single thread after a failed inbound forward, with bounded
 * retries. The message was never written to `message_log`, so a later successful
 * pass still delivers it.
 */
const inboundRetryTimers = new Map<string, NodeJS.Timeout>();
const inboundRetryAttempts = new Map<string, number>();

export function scheduleInboundRetry(
	threadId: string,
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): void {
	// A retry already pending for this thread will pick up every message that is
	// still missing, so a second failure does not need a second timer.
	if (inboundRetryTimers.has(threadId)) return;

	const attempt = inboundRetryAttempts.get(threadId) ?? 0;
	if (attempt >= INBOUND_RETRY_DELAYS_MS.length) {
		logger.warn(
			`Inbound retries exhausted for thread ${logTag(threadId)}; run /sync to retry`,
		);
		return;
	}

	const delay = INBOUND_RETRY_DELAYS_MS[attempt]!;
	const timer = setTimeout(() => {
		inboundRetryTimers.delete(threadId);
		inboundRetryAttempts.set(threadId, attempt + 1);

		void reconcileThread(ig, bot, db, config, threadId)
			.then(counts => {
				if (counts.failures > 0) {
					scheduleInboundRetry(threadId, ig, bot, db, config);
					return;
				}

				inboundRetryAttempts.delete(threadId);
				logger.info(
					`Inbound retry recovered thread ${logTag(threadId)}: ${logFields({forwarded: counts.forwarded})}`,
				);
			})
			.catch(error => {
				logger.error(`Inbound retry failed: ${describeError(error)}`);
				scheduleInboundRetry(threadId, ig, bot, db, config);
			});
	}, delay);
	timer.unref?.();

	inboundRetryTimers.set(threadId, timer);
	logger.info(
		`Scheduled inbound retry for thread ${logTag(threadId)} in ${Math.round(delay / 1000)}s (attempt ${attempt + 1})`,
	);
}

/** Cancels every pending inbound retry. Used on shutdown. */
export function cancelInboundRetries(): void {
	for (const timer of inboundRetryTimers.values()) clearTimeout(timer);
	inboundRetryTimers.clear();
	inboundRetryAttempts.clear();
}

/**
 * Reads the most recently active threads from the Instagram inbox, bounded by
 * `limit`. Paging stops as soon as the limit is reached.
 */
export async function collectRecentThreads(
	ig: InstagramClient,
	limit: number,
): Promise<Thread[]> {
	const collected: Thread[] = [];
	let hasMore = true;
	let isFirst = true;

	while (collected.length < limit && hasMore) {
		const page = await ig.getThreads(!isFirst);
		isFirst = false;
		hasMore = page.hasMore;

		for (const thread of page.threads) {
			if (collected.length >= limit) break;
			collected.push(thread);
		}
	}

	return collected;
}

/**
 * Makes sure a Telegram topic exists for a thread before its messages are
 * reconciled, so a previously failed topic creation is repaired here.
 */
async function ensureThreadMapping(
	ig: InstagramClient,
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
	thread: Thread,
): Promise<void> {
	if (getThreadByIgId(db, thread.id)) return;

	const otherUsers = thread.users.filter(u => u.pk !== ig.getUserId());
	const user = otherUsers[0];
	if (!user) return;

	const isGroup = otherUsers.length > 1;
	await ensureTopicForThread(
		bot,
		db,
		config,
		thread.id,
		user.username || thread.title,
		user.fullName || '',
		user.pk,
		isGroup,
		isGroup ? thread.title : undefined,
	);
}
