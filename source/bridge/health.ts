import type Database from 'better-sqlite3';
import {getState, setState} from './db.js';
import type {RealtimeStatus} from '../client.js';

/**
 * What the bridge knows about its own liveness.
 *
 * Container health says nothing about whether Instagram realtime delivery is
 * working — the container ran continuously through seven MQTT disconnects — so
 * this is tracked separately and surfaced through `/status`.
 */
export type ReconciliationResult = {
	threadsChecked: number;
	forwarded: number;
	failures: number;
	skipped: number;
};

const STATE_LAST_RECONCILIATION = 'last_reconciliation_at';
const STATE_LAST_RECONCILIATION_RESULT = 'last_reconciliation_result';

export class BridgeHealth {
	realtimeStatus: RealtimeStatus = 'disconnected';
	lastRealtimeEventAt: Date | undefined;
	lastConnectedAt: Date | undefined;
	degradedSince: Date | undefined;
	reconnectAttempts = 0;
	lastReconciliation: (ReconciliationResult & {at: Date}) | undefined;
	lastInboundFailureAt: Date | undefined;

	setRealtimeStatus(status: RealtimeStatus): void {
		this.realtimeStatus = status;

		if (status === 'connected') {
			this.lastConnectedAt = new Date();
			this.degradedSince = undefined;
			this.reconnectAttempts = 0;
		} else if (status !== 'connecting') {
			this.degradedSince ??= new Date();
		}
	}

	markRealtimeEvent(): void {
		this.lastRealtimeEventAt = new Date();
	}

	markInboundFailure(): void {
		this.lastInboundFailureAt = new Date();
	}

	/** True while Instagram realtime is not delivering messages. */
	isDegraded(): boolean {
		return this.realtimeStatus !== 'connected';
	}

	recordReconciliation(db: Database.Database, result: ReconciliationResult): void {
		const at = new Date();
		this.lastReconciliation = {...result, at};
		setState(db, STATE_LAST_RECONCILIATION, at.toISOString());
		setState(db, STATE_LAST_RECONCILIATION_RESULT, JSON.stringify(result));
	}

	/**
	 * Restores the last reconciliation from SQLite so `/status` stays truthful
	 * across container restarts.
	 */
	restore(db: Database.Database): void {
		const at = getState(db, STATE_LAST_RECONCILIATION);
		if (!at) return;

		const raw = getState(db, STATE_LAST_RECONCILIATION_RESULT);
		let result: ReconciliationResult = {threadsChecked: 0, forwarded: 0, failures: 0, skipped: 0};
		if (raw) {
			try {
				result = {...result, ...(JSON.parse(raw) as Partial<ReconciliationResult>)};
			} catch {
				// Corrupt value — the timestamp alone is still useful.
			}
		}

		this.lastReconciliation = {...result, at: new Date(at)};
	}

	/** Resets to the "no Instagram client" baseline, e.g. after /logout. */
	reset(): void {
		this.realtimeStatus = 'disconnected';
		this.lastRealtimeEventAt = undefined;
		this.lastConnectedAt = undefined;
		this.degradedSince = undefined;
		this.reconnectAttempts = 0;
	}
}

export const bridgeHealth = new BridgeHealth();

/**
 * Renders a timestamp for an operational summary. Never includes message content.
 */
export function formatWhen(date: Date | undefined): string {
	if (!date) return 'never';

	const seconds = Math.round((Date.now() - date.getTime()) / 1000);
	if (seconds < 0) return date.toISOString();
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86_400)}d ago`;
}
