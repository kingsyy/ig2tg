import test from 'node:test';
import assert from 'node:assert/strict';
import {logMessage, messageExists} from '../source/bridge/db.js';
import {reconcileRecentMessages} from '../source/bridge/reconcile.js';
import {BridgeHealth, bridgeHealth} from '../source/bridge/health.js';
import type {Thread} from '../source/types/instagram.js';
import {
	FakeBot,
	FakeInstagramClient,
	MY_USER_ID,
	PEER_USER_ID,
	igTextMessage,
	mapThread,
	testConfig,
	testDb,
} from './helpers.js';

function thread(id: string): Thread {
	return {
		id,
		title: 'peer',
		users: [
			{pk: MY_USER_ID, username: 'me', fullName: '', isVerified: false},
			{pk: PEER_USER_ID, username: 'peer', fullName: 'Peer', isVerified: false},
		],
		lastActivity: new Date('2026-08-11T10:00:00Z'),
		unread: false,
	};
}

function setup(configOverrides = {}) {
	const db = testDb();
	const config = testConfig(configOverrides);
	const bot = new FakeBot();
	const ig = new FakeInstagramClient();
	return {db, config, bot, ig};
}

test('reconciliation forwards messages missed during an outage, oldest first', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [
		igTextMessage({id: 'missed-1', text: 'first'}),
		igTextMessage({id: 'missed-2', text: 'second'}),
		igTextMessage({id: 'missed-3', text: 'third'}),
	]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(result.threadsChecked, 1);
	assert.equal(result.forwarded, 3);
	assert.equal(result.failures, 0);
	assert.deepEqual(bot.texts(), ['first', 'second', 'third']);
});

test('reconciliation skips Instagram items that are already known', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	logMessage(db, {
		ig_message_id: 'missed-1',
		tg_message_id: 900,
		ig_thread_id: 'thread-1',
		direction: 'ig_to_tg',
		content_type: 'text',
	});

	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [
		igTextMessage({id: 'missed-1', text: 'already delivered'}),
		igTextMessage({id: 'missed-2', text: 'new'}),
	]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(result.forwarded, 1);
	assert.equal(result.skipped, 1);
	assert.deepEqual(bot.texts(), ['new']);
});

test('reconciliation does not forward own messages when the option is off', async () => {
	const {db, config, bot, ig} = setup({forward_own_messages: false});
	mapThread(db, 'thread-1', 10);
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [
		igTextMessage({id: 'own-1', userId: MY_USER_ID, username: 'me', text: 'mine'}),
		igTextMessage({id: 'peer-1', text: 'theirs'}),
	]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(result.forwarded, 1);
	assert.deepEqual(bot.texts(), ['theirs'], 'only the other side is replayed');
});

test('reconciliation forwards own messages when the option is on', async () => {
	const {db, config, bot, ig} = setup({forward_own_messages: true});
	mapThread(db, 'thread-1', 10);
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [
		igTextMessage({id: 'own-1', userId: MY_USER_ID, username: 'me', text: 'from my phone'}),
	]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(result.forwarded, 1);
	assert.deepEqual(bot.texts(), ['📤 You: from my phone']);
});

test('reconciliation creates a missing topic before replaying its messages', async () => {
	const {db, config, bot, ig} = setup();
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [igTextMessage({id: 'missed-1', text: 'hi'})]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.deepEqual(bot.createdTopics, ['@peer']);
	assert.equal(result.forwarded, 1);
});

test('a message that fails to deliver is counted and left unlogged', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	bot.sendFailures = [new Error('telegram is down')];
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [igTextMessage({id: 'missed-1', text: 'hi'})]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(result.failures, 1);
	assert.equal(result.forwarded, 0);
	assert.equal(messageExists(db, 'missed-1'), false, 'a later pass can still deliver it');
});

test('reconciliation is bounded by the configured message count', async () => {
	const {db, config, bot, ig} = setup({reconcile_message_count: 2});
	mapThread(db, 'thread-1', 10);
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [
		igTextMessage({id: 'old-1', text: 'oldest'}),
		igTextMessage({id: 'mid-1', text: 'middle'}),
		igTextMessage({id: 'new-1', text: 'newest'}),
	]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(result.forwarded, 2);
	assert.deepEqual(bot.texts(), ['middle', 'newest'], 'the most recent window only');
});

test('reconciliation is bounded by the configured thread count', async () => {
	const {db, config, bot, ig} = setup({reconcile_thread_count: 1});
	mapThread(db, 'thread-1', 10);
	mapThread(db, 'thread-2', 20);
	ig.threads = [thread('thread-1'), thread('thread-2')];
	ig.messagesByThread.set('thread-1', [igTextMessage({id: 'a', text: 'a'})]);
	ig.messagesByThread.set('thread-2', [
		igTextMessage({id: 'b', threadId: 'thread-2', text: 'b'}),
	]);

	const result = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(result.threadsChecked, 1);
	assert.deepEqual(bot.texts(), ['a']);
});

test('re-running reconciliation does not duplicate what it already forwarded', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [igTextMessage({id: 'missed-1', text: 'once'})]);

	await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);
	const second = await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);

	assert.equal(second.forwarded, 0);
	assert.equal(bot.texts().length, 1);
});

test('concurrent reconciliations share one pass instead of doubling up', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [igTextMessage({id: 'missed-1', text: 'once'})]);

	const [first, second] = await Promise.all([
		reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config),
		reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config),
	]);

	assert.deepEqual(first, second, 'both callers observe the same pass');
	assert.equal(bot.texts().length, 1);
});

test('the result is recorded for /status and survives a restart', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	ig.threads = [thread('thread-1')];
	ig.messagesByThread.set('thread-1', [igTextMessage({id: 'missed-1', text: 'hi'})]);

	await reconcileRecentMessages(ig.asClient(), bot.asBot(), db, config);
	assert.equal(bridgeHealth.lastReconciliation?.forwarded, 1);

	// A restart starts from a fresh health object, which knows nothing until it
	// re-reads the result from SQLite.
	const afterRestart = new BridgeHealth();
	afterRestart.restore(db);
	assert.equal(afterRestart.lastReconciliation?.forwarded, 1);
	assert.equal(afterRestart.lastReconciliation?.threadsChecked, 1);
	assert.ok(afterRestart.lastReconciliation?.at instanceof Date);
});
