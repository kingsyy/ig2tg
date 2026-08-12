import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {loadBridgeConfig} from '../source/bridge/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	try {
		run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const requiredEnv = {
	TG_BOT_TOKEN: 'test-token',
	TG_SUPERGROUP_ID: '-1001234567890',
	TG_OWNER_ID: '123456789',
};

/**
 * The shipped config.yaml is what the container actually loads, so a key added
 * to the schema but not to the file — or vice versa — has to fail here rather
 * than at startup on the NAS.
 */
test('the shipped config.yaml loads with only the required env vars set', () => {
	withEnv(
		{
			...requiredEnv,
			BRIDGE_RECONCILE_THREAD_COUNT: undefined,
			BRIDGE_RECONCILE_MESSAGE_COUNT: undefined,
			BRIDGE_DISCONNECT_WARN_AFTER_SECONDS: undefined,
			BRIDGE_OUTBOUND_MAX_ATTEMPTS: undefined,
			BRIDGE_OUTBOUND_RETENTION_DAYS: undefined,
			BRIDGE_FORWARD_OWN_MESSAGES: undefined,
			BRIDGE_LOG_LEVEL: undefined,
		},
		() => {
			const config = loadBridgeConfig(path.join(repoRoot, 'config.yaml'));

			assert.equal(config.telegram.supergroup_id, -1_001_234_567_890);
			assert.equal(config.telegram.owner_id, 123_456_789);
			assert.equal(config.bridge.reconcile_thread_count, 10);
			assert.equal(config.bridge.reconcile_message_count, 30);
			assert.equal(config.bridge.disconnect_warn_after_seconds, 45);
			assert.equal(config.bridge.outbound_max_attempts, 4);
			assert.equal(config.bridge.outbound_retention_days, 7);
			assert.equal(config.bridge.forward_own_messages, true);
		},
	);
});

test('log_level defaults to info, not debug', () => {
	withEnv({...requiredEnv, BRIDGE_LOG_LEVEL: undefined}, () => {
		const config = loadBridgeConfig(path.join(repoRoot, 'config.yaml'));
		assert.equal(
			config.bridge.log_level,
			'info',
			'debug output reaches the log file on the persistent volume',
		);
	});
});

test('reliability settings can be overridden by environment', () => {
	withEnv(
		{
			...requiredEnv,
			BRIDGE_RECONCILE_THREAD_COUNT: '3',
			BRIDGE_FORWARD_OWN_MESSAGES: 'false',
			BRIDGE_OUTBOUND_MAX_ATTEMPTS: '2',
		},
		() => {
			const config = loadBridgeConfig(path.join(repoRoot, 'config.yaml'));
			assert.equal(config.bridge.reconcile_thread_count, 3);
			assert.equal(config.bridge.forward_own_messages, false);
			assert.equal(config.bridge.outbound_max_attempts, 2);
		},
	);
});

test('a missing bot token is rejected rather than defaulted', () => {
	withEnv({...requiredEnv, TG_BOT_TOKEN: undefined}, () => {
		assert.throws(() => loadBridgeConfig(path.join(repoRoot, 'config.yaml')));
	});
});
