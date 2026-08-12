import type {Bot, Context} from 'grammy';
import type {BridgeConfig} from './config.js';
import {createLogger} from './logger.js';
import {describeError} from '../utils/redact.js';

const logger = createLogger('notifier');

export const NOTICES = {
	realtimeDown:
		'⚠️ Instagram realtime disconnected. Messages may be delayed until the bridge reconnects.',
	realtimeUp:
		'✅ Instagram realtime reconnected. Checking for messages received during the interruption…',
	reconciliationOk: '✅ Instagram message check complete.',
	reconciliationFailed:
		'⚠️ Instagram reconnected, but the missed-message check failed. Open Instagram if you expect a message.',
	inboundFailure:
		'⚠️ An Instagram message could not be delivered to Telegram. The bridge will retry; run /sync to retry now.',
	outboundFailure: '❌ Not delivered to Instagram. The message has been kept for retry.',
	outboundRetried: '✅ Delivered to Instagram after retry.',
} as const;

/**
 * Sends an operational notice to the supergroup's General topic.
 *
 * Notices never contain message bodies. Delivery failure is logged and
 * swallowed: a notice that cannot be sent must not take down the caller.
 */
export async function sendNotice(
	bot: Bot<Context>,
	config: BridgeConfig,
	text: string,
): Promise<number | undefined> {
	try {
		const sent = await bot.api.sendMessage(config.telegram.supergroup_id, text);
		return sent.message_id;
	} catch (error) {
		logger.error(`Failed to send Telegram notice: ${describeError(error)}`);
		return undefined;
	}
}

/**
 * Rate-limits a repeating notice so a burst of low-level failures produces one
 * message rather than one per event.
 */
export class ThrottledNotice {
	private lastSentAt = 0;

	constructor(
		private readonly text: string,
		private readonly minIntervalMs: number,
	) {}

	async maybeSend(bot: Bot<Context>, config: BridgeConfig): Promise<boolean> {
		const now = Date.now();
		if (now - this.lastSentAt < this.minIntervalMs) return false;
		this.lastSentAt = now;
		await sendNotice(bot, config, this.text);
		return true;
	}

	reset(): void {
		this.lastSentAt = 0;
	}
}
