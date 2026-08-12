import type {Bot, Context} from 'grammy';
import type {BridgeConfig} from './config.js';
import type {ReconciliationResult} from './health.js';
import {NOTICES, sendNotice} from './notifier.js';
import {createLogger} from './logger.js';
import {describeError} from '../utils/redact.js';

const logger = createLogger('connection');

export type ConnectionNotifierDeps = {
	bot: Bot<Context>;
	config: BridgeConfig;
	/** Whether Instagram realtime is currently not delivering messages. */
	isDegraded: () => boolean;
	/** Runs a bounded missed-message check. */
	reconcile: () => Promise<ReconciliationResult>;
};

/**
 * Turns Instagram realtime state changes into at most one Telegram warning per
 * outage, and one recovery notice per warning.
 *
 * A warning is held back until the connection has stayed down for
 * `disconnect_warn_after_seconds`. That is what separates a real outage from the
 * low-level MQTT blips that reconnect on their own — seven `ClientDisconnectedError`
 * events in a day must not become seven notifications.
 */
export class ConnectionNotifier {
	private warnTimer: NodeJS.Timeout | undefined;
	private warned = false;

	constructor(private readonly deps: ConnectionNotifierDeps) {}

	/** True once a disconnect has actually been announced to Telegram. */
	get hasWarned(): boolean {
		return this.warned;
	}

	onStatus(status: string): void {
		if (status === 'connected') {
			this.clearTimer();
			return;
		}

		// 'connecting' is part of a connection attempt, not evidence of an outage.
		if (status === 'connecting') return;

		// Already warned, or a warning is already pending: nothing more to schedule.
		if (this.warned || this.warnTimer) return;

		const delayMs = Math.max(0, this.deps.config.bridge.disconnect_warn_after_seconds) * 1000;
		this.warnTimer = setTimeout(() => {
			this.warnTimer = undefined;
			if (!this.deps.isDegraded()) return;

			this.warned = true;
			void sendNotice(this.deps.bot, this.deps.config, NOTICES.realtimeDown);
		}, delayMs);
		this.warnTimer.unref?.();
	}

	/**
	 * Announces recovery and reconciles the gap.
	 *
	 * Reconciliation runs either way — messages can be missed by a blip that was
	 * never announced — but the notices are only sent when the outage was
	 * announced, so a silent blip stays silent end to end.
	 */
	async onReconnected(): Promise<ReconciliationResult | undefined> {
		this.clearTimer();
		const announce = this.warned;
		this.warned = false;

		if (announce) {
			await sendNotice(this.deps.bot, this.deps.config, NOTICES.realtimeUp);
		}

		try {
			const result = await this.deps.reconcile();
			if (announce) {
				await sendNotice(
					this.deps.bot,
					this.deps.config,
					result.failures > 0 ? NOTICES.reconciliationFailed : NOTICES.reconciliationOk,
				);
			}

			return result;
		} catch (error) {
			logger.error(`Post-reconnect reconciliation failed: ${describeError(error)}`);
			if (announce) {
				await sendNotice(this.deps.bot, this.deps.config, NOTICES.reconciliationFailed);
			}

			return undefined;
		}
	}

	/** Cancels a pending warning. Used on shutdown and logout. */
	dispose(): void {
		this.clearTimer();
		this.warned = false;
	}

	private clearTimer(): void {
		if (this.warnTimer) clearTimeout(this.warnTimer);
		this.warnTimer = undefined;
	}
}
