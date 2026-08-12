import {randomUUID} from 'node:crypto';
import type {Api, Bot, Context} from 'grammy';
import type Database from 'better-sqlite3';
import type {InstagramClient} from '../client.js';
import type {BridgeConfig} from './config.js';
import {
	claimOutbound,
	enqueueOutbound,
	getDueOutbound,
	logMessage,
	logTag,
	markOutboundFailed,
	markOutboundSent,
	pruneSentOutbound,
	requeueOutbound,
	resetStuckSending,
	scheduleOutboundRetry,
	setOutboundFailureNotice,
	type NewOutboundRecord,
	type OutboundRecord,
} from './db.js';
import {downloadTelegramFile} from './media.js';
import {NOTICES} from './notifier.js';
import {createLogger} from './logger.js';
import {describeError, errorClass, logFields} from '../utils/redact.js';

const logger = createLogger('outbound');

/** Backoff between automatic attempts. Index = attempt number already made. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000];

/** How often the worker looks for records whose retry time has come. */
const WORKER_INTERVAL_MS = 30_000;

export type OutboundContentType = 'text' | 'photo' | 'video' | 'voice';

export type OutboundPayload =
	| {kind: 'text'; text: string}
	| {kind: 'photo'; file_id: string}
	| {kind: 'video'; file_id: string}
	| {kind: 'voice'; file_id: string};

/**
 * Instagram failures that must not be retried automatically: retrying cannot
 * help, and hammering an authentication or challenge error risks the account.
 * The record is left `failed` and available for manual `/retry`.
 */
const PERMANENT_ERROR_NAMES = new Set([
	'IgLoginRequiredError',
	'IgCheckpointError',
	'IgChallengeWrongCodeError',
	'IgUserHasLoggedOutError',
	'IgCookieNotFoundError',
	'IgLoginBadPasswordError',
	'IgLoginInvalidUserError',
	'IgInactiveUserError',
	'IgSentryBlockError',
	'IgActionSpamError',
	'IgNotFoundError',
	'UnsupportedPayloadError',
]);

/** Errors worth retrying: transport trouble and server-side rate limiting. */
const TRANSIENT_ERROR_NAMES = new Set([
	'IgNetworkError',
	'IgRequestsLimitError',
	'RequestError',
	'TimeoutError',
	'AbortError',
	'FetchError',
]);

export class UnsupportedPayloadError extends Error {
	override name = 'UnsupportedPayloadError';
}

/**
 * Decides whether a failed send should be retried automatically.
 *
 * Unknown errors are treated as transient. Bounded attempts make that safe, and
 * the alternative — giving up on a recoverable blip — is the failure mode that
 * actually loses messages.
 */
export function classifyError(error: unknown): 'transient' | 'permanent' {
	const name = errorClass(error);
	if (PERMANENT_ERROR_NAMES.has(name)) return 'permanent';
	if (TRANSIENT_ERROR_NAMES.has(name)) return 'transient';

	const status = (error as {response?: {statusCode?: number}} | null)?.response?.statusCode;
	if (typeof status === 'number') {
		if (status === 429 || status >= 500) return 'transient';
		if (status === 401 || status === 403) return 'permanent';
		// Other 4xx responses are the server rejecting this specific request.
		if (status >= 400) return 'permanent';
	}

	return 'transient';
}

export type EnqueueInput = {
	tgChatId: number;
	tgTopicId: number;
	tgMessageId: number;
	igThreadId: string;
	payload: OutboundPayload;
	replyToIgItemId: string | null;
};

/**
 * Records an outgoing message as `pending` before Instagram is contacted, so a
 * crash between the Telegram update and the Instagram send cannot lose it.
 *
 * The `client_context` generated here is the idempotency token: it is stored with
 * the record and reused on every retry.
 */
export function enqueue(
	db: Database.Database,
	input: EnqueueInput,
): {record: OutboundRecord; created: boolean} {
	const newRecord: NewOutboundRecord = {
		tg_chat_id: input.tgChatId,
		tg_topic_id: input.tgTopicId,
		tg_message_id: input.tgMessageId,
		ig_thread_id: input.igThreadId,
		content_type: input.payload.kind,
		payload_json: JSON.stringify(input.payload),
		reply_to_ig_item_id: input.replyToIgItemId,
		client_context: randomUUID(),
	};

	const result = enqueueOutbound(db, newRecord);

	if (!result.created) {
		logger.info(
			`Duplicate Telegram update ignored: ${logFields({
				tg_message_id: input.tgMessageId,
				queue_id: result.record.id,
				status: result.record.status,
			})}`,
		);
	}

	return result;
}

export type ProcessOutcome = 'sent' | 'retrying' | 'failed' | 'skipped';

export type ProcessDeps = {
	db: Database.Database;
	ig: InstagramClient;
	api: Api;
	bot: Bot<Context>;
	config: BridgeConfig;
	/** Set when this attempt came from an explicit /retry, so success is announced. */
	announceSuccess?: boolean;
};

/**
 * Attempts one delivery of a queued record.
 *
 * Nothing is reported as delivered until Instagram returns an item ID. On
 * success the real Instagram item ID is written to `message_log` so the MQTT
 * echo of our own send is recognized and not forwarded back.
 */
export async function processRecord(
	deps: ProcessDeps,
	recordId: number,
): Promise<ProcessOutcome> {
	const {db, ig, api, bot, config} = deps;

	const claimed = claimOutbound(db, recordId);
	if (!claimed) return 'skipped';

	const logContext = {
		direction: 'tg_to_ig',
		content_type: claimed.content_type,
		thread_hash: logTag(claimed.ig_thread_id),
		tg_message_id: claimed.tg_message_id,
		attempt: claimed.attempt_count,
	};

	try {
		const igMessageId = await send(ig, api, claimed);

		markOutboundSent(db, claimed.id, igMessageId);
		logMessage(db, {
			ig_message_id: igMessageId,
			tg_message_id: claimed.tg_message_id,
			ig_thread_id: claimed.ig_thread_id,
			direction: 'tg_to_ig',
			content_type: claimed.content_type,
			client_context: claimed.client_context,
		});

		logger.info(`Outbound delivered: ${logFields({...logContext, result: 'sent'})}`);

		if (deps.announceSuccess) {
			await replyInTopic(bot, claimed, NOTICES.outboundRetried);
		}

		return 'sent';
	} catch (error) {
		const classification = classifyError(error);
		const label = describeError(error);
		const attemptsUsed = claimed.attempt_count;
		const exhausted = attemptsUsed >= Math.max(1, config.bridge.outbound_max_attempts);

		if (classification === 'transient' && !exhausted) {
			const delay = RETRY_DELAYS_MS[Math.min(attemptsUsed - 1, RETRY_DELAYS_MS.length - 1)]!;
			scheduleOutboundRetry(db, claimed.id, label, delay);
			logger.warn(
				`Outbound retry scheduled: ${logFields({
					...logContext,
					result: 'retrying',
					error_class: errorClass(error),
					retry_in_s: Math.round(delay / 1000),
				})}`,
			);
			return 'retrying';
		}

		markOutboundFailed(db, claimed.id, label);
		logger.error(
			`Outbound failed: ${logFields({
				...logContext,
				result: 'failed',
				error_class: errorClass(error),
				classification,
			})}`,
		);

		const noticeId = await replyInTopic(bot, claimed, NOTICES.outboundFailure);
		if (noticeId !== undefined) setOutboundFailureNotice(db, claimed.id, noticeId);

		return 'failed';
	}
}

async function send(
	ig: InstagramClient,
	api: Api,
	record: OutboundRecord,
): Promise<string> {
	const payload = JSON.parse(record.payload_json) as OutboundPayload;

	switch (payload.kind) {
		case 'text': {
			return ig.sendMessage(record.ig_thread_id, payload.text, {
				replyToItemId: record.reply_to_ig_item_id ?? undefined,
				clientContext: record.client_context,
			});
		}

		case 'photo': {
			const buffer = await downloadTelegramFile(api, payload.file_id);
			return ig.sendPhoto(record.ig_thread_id, buffer);
		}

		case 'video': {
			const buffer = await downloadTelegramFile(api, payload.file_id);
			return ig.sendVideo(record.ig_thread_id, buffer);
		}

		case 'voice': {
			const buffer = await downloadTelegramFile(api, payload.file_id);
			return ig.sendVoice(record.ig_thread_id, buffer);
		}

		default: {
			throw new UnsupportedPayloadError(
				`Unsupported outbound payload kind: ${(payload as {kind: string}).kind}`,
			);
		}
	}
}

/**
 * Replies to the original Telegram message inside its topic. Failure to deliver
 * a notice is logged rather than thrown: it must not mask the send result.
 */
async function replyInTopic(
	bot: Bot<Context>,
	record: OutboundRecord,
	text: string,
): Promise<number | undefined> {
	try {
		const sent = await bot.api.sendMessage(record.tg_chat_id, text, {
			message_thread_id: record.tg_topic_id,
			reply_parameters: {
				message_id: record.tg_message_id,
				allow_sending_without_reply: true,
			},
		});
		return sent.message_id;
	} catch (error) {
		logger.error(`Failed to send outbound notice: ${describeError(error)}`);
		return undefined;
	}
}

/**
 * Marks a failed record eligible again and attempts it immediately.
 */
export async function retryRecord(
	deps: ProcessDeps,
	recordId: number,
): Promise<ProcessOutcome | 'not_eligible'> {
	if (!requeueOutbound(deps.db, recordId)) return 'not_eligible';
	return processRecord({...deps, announceSuccess: true}, recordId);
}

/**
 * Periodically delivers records whose retry time has come.
 *
 * Also recovers records left in `sending` by a crash: their stable
 * `client_context` means Instagram discards the duplicate if the original send
 * actually landed.
 */
export class OutboundWorker {
	private timer: NodeJS.Timeout | undefined;
	private ticking = false;

	constructor(private readonly deps: () => ProcessDeps | undefined) {}

	start(db: Database.Database, config: BridgeConfig): void {
		const recovered = resetStuckSending(db);
		if (recovered > 0) {
			logger.info(`Recovered ${recovered} outbound record(s) left mid-send by a restart`);
		}

		const pruned = pruneSentOutbound(db, config.bridge.outbound_retention_days);
		if (pruned > 0) logger.info(`Pruned ${pruned} delivered outbound record(s)`);

		this.timer ??= setInterval(() => void this.tick(), WORKER_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async tick(): Promise<void> {
		if (this.ticking) return;
		const deps = this.deps();
		if (!deps) return;

		this.ticking = true;
		try {
			const due = getDueOutbound(deps.db);
			for (const record of due) {
				await processRecord(deps, record.id);
			}
		} catch (error) {
			logger.error(`Outbound worker tick failed: ${describeError(error)}`);
		} finally {
			this.ticking = false;
		}
	}
}
