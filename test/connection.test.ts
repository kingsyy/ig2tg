import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionNotifier} from '../source/bridge/connection.js';
import {NOTICES} from '../source/bridge/notifier.js';
import {bridgeHealth, formatWhen} from '../source/bridge/health.js';
import {nextReconnectDelayMs, RECONNECT_DELAYS_MS} from '../source/client.js';
import {FakeBot, testConfig} from './helpers.js';

const WARN_AFTER_SECONDS = 0.02;

/** Waits past the warning delay so the scheduled notice has been sent. */
async function tick(ms = 120): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function setup(options: {degraded?: () => boolean; failures?: number} = {}) {
	const bot = new FakeBot();
	const config = testConfig({disconnect_warn_after_seconds: WARN_AFTER_SECONDS});
	let reconcileCalls = 0;

	const notifier = new ConnectionNotifier({
		bot: bot.asBot(),
		config,
		isDegraded: options.degraded ?? (() => true),
		reconcile: async () => {
			reconcileCalls++;
			return {
				threadsChecked: 1,
				forwarded: 0,
				failures: options.failures ?? 0,
				skipped: 0,
			};
		},
	});

	return {bot, notifier, reconcileCalls: () => reconcileCalls};
}

// ─── Disconnect warning ─────────────────────────────────

test('a sustained disconnect produces one warning', async () => {
	const {bot, notifier} = setup();

	notifier.onStatus('error');
	await tick();

	assert.deepEqual(bot.texts(), [NOTICES.realtimeDown]);
});

test('repeated MQTT errors emit one warning, not one per error', async () => {
	const {bot, notifier} = setup();

	// The production symptom: seven ClientDisconnectedError events in a day.
	for (let i = 0; i < 7; i++) {
		notifier.onStatus('error');
		notifier.onStatus('disconnected');
		notifier.onStatus('reconnecting');
	}

	await tick();

	assert.equal(
		bot.texts().filter(t => t === NOTICES.realtimeDown).length,
		1,
		'one warning for one outage',
	);
});

test('a blip that reconnects before the warning delay stays silent', async () => {
	let degraded = true;
	const {bot, notifier} = setup({degraded: () => degraded});

	notifier.onStatus('error');
	degraded = false;
	notifier.onStatus('connected');
	await tick();

	assert.deepEqual(bot.texts(), [], 'no notification for a self-healing blip');
});

test('a connecting status alone never warns', async () => {
	const {bot, notifier} = setup();

	notifier.onStatus('connecting');
	await tick();

	assert.deepEqual(bot.texts(), []);
});

// ─── Recovery ───────────────────────────────────────────

test('recovery after a warned outage announces reconnect and a completed check', async () => {
	const {bot, notifier, reconcileCalls} = setup();

	notifier.onStatus('error');
	await tick();
	await notifier.onReconnected();

	assert.deepEqual(bot.texts(), [
		NOTICES.realtimeDown,
		NOTICES.realtimeUp,
		NOTICES.reconciliationOk,
	]);
	assert.equal(reconcileCalls(), 1);
});

test('a failed missed-message check tells the user to open Instagram', async () => {
	const {bot, notifier} = setup({failures: 2});

	notifier.onStatus('error');
	await tick();
	await notifier.onReconnected();

	assert.deepEqual(bot.texts(), [
		NOTICES.realtimeDown,
		NOTICES.realtimeUp,
		NOTICES.reconciliationFailed,
	]);
});

test('an unannounced blip still reconciles, but silently', async () => {
	const {bot, notifier, reconcileCalls} = setup();

	await notifier.onReconnected();

	assert.equal(reconcileCalls(), 1, 'messages can be missed by a blip too');
	assert.deepEqual(bot.texts(), []);
});

test('a second outage warns again after a recovery', async () => {
	const {bot, notifier} = setup();

	notifier.onStatus('error');
	await tick();
	await notifier.onReconnected();

	notifier.onStatus('error');
	await tick();

	assert.equal(bot.texts().filter(t => t === NOTICES.realtimeDown).length, 2);
});

test('a reconciliation that throws still reports a failure to the user', async () => {
	const bot = new FakeBot();
	const notifier = new ConnectionNotifier({
		bot: bot.asBot(),
		config: testConfig({disconnect_warn_after_seconds: WARN_AFTER_SECONDS}),
		isDegraded: () => true,
		reconcile: async () => {
			throw new Error('instagram rest failed');
		},
	});

	notifier.onStatus('error');
	await tick();
	const result = await notifier.onReconnected();

	assert.equal(result, undefined);
	assert.ok(bot.texts().includes(NOTICES.reconciliationFailed));
});

test('dispose cancels a pending warning', async () => {
	const {bot, notifier} = setup();

	notifier.onStatus('error');
	notifier.dispose();
	await tick();

	assert.deepEqual(bot.texts(), []);
});

// ─── Reconnect backoff ──────────────────────────────────

test('reconnect delays climb and then hold at the cap', () => {
	// Jitter is ±20%, so each delay is checked as a band around its base.
	for (const [attempt, base] of RECONNECT_DELAYS_MS.entries()) {
		const delay = nextReconnectDelayMs(attempt);
		assert.ok(delay >= base * 0.8, `attempt ${attempt}: ${delay} >= ${base * 0.8}`);
		assert.ok(delay <= base * 1.2, `attempt ${attempt}: ${delay} <= ${base * 1.2}`);
	}
});

test('the cap is about five minutes and applies to every later attempt', () => {
	const cap = RECONNECT_DELAYS_MS.at(-1)!;
	assert.equal(cap, 300_000);

	for (const attempt of [RECONNECT_DELAYS_MS.length, 25, 500]) {
		const delay = nextReconnectDelayMs(attempt);
		assert.ok(delay <= cap * 1.2, `attempt ${attempt} stays at the cap`);
		assert.ok(delay >= cap * 0.8);
	}
});

test('jitter spreads retries rather than firing them in lockstep', () => {
	const delays = new Set(Array.from({length: 20}, () => nextReconnectDelayMs(3)));
	assert.ok(delays.size > 1, 'the delay is not a constant');
});

// ─── Health reporting ───────────────────────────────────

test('health tracks the degraded window and clears it on connect', () => {
	bridgeHealth.reset();

	bridgeHealth.setRealtimeStatus('error');
	assert.equal(bridgeHealth.isDegraded(), true);
	assert.ok(bridgeHealth.degradedSince);

	bridgeHealth.setRealtimeStatus('connected');
	assert.equal(bridgeHealth.isDegraded(), false);
	assert.equal(bridgeHealth.degradedSince, undefined);
	assert.ok(bridgeHealth.lastConnectedAt);
});

test('reconnecting counts as degraded, so /status does not claim delivery works', () => {
	bridgeHealth.reset();
	bridgeHealth.setRealtimeStatus('reconnecting');
	assert.equal(bridgeHealth.isDegraded(), true);
});

test('timestamps render as relative ages, and never as "just now" when absent', () => {
	assert.equal(formatWhen(undefined), 'never');
	assert.match(formatWhen(new Date(Date.now() - 5_000)), /^\d+s ago$/);
	assert.match(formatWhen(new Date(Date.now() - 300_000)), /^\d+m ago$/);
	assert.match(formatWhen(new Date(Date.now() - 7_200_000)), /^\d+h ago$/);
});
