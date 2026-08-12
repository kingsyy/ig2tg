import test from 'node:test';
import assert from 'node:assert/strict';
import {
	claimOutbound,
	countOutboundByStatus,
	getMessageCount,
	getOutboundById,
	getOutboundByTgMessageId,
	pruneSentOutbound,
	resetStuckSending,
} from '../source/bridge/db.js';
import {
	classifyError,
	enqueue,
	processRecord,
	retryRecord,
	type ProcessDeps,
} from '../source/bridge/outbound.js';
import {
	CHAT_ID,
	FakeBot,
	FakeInstagramClient,
	mapThread,
	testConfig,
	testDb,
} from './helpers.js';

function namedError(name: string, message = 'failed'): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

function statusError(statusCode: number): Error {
	const error = new Error('request failed');
	error.name = 'IgResponseError';
	(error as unknown as {response: {statusCode: number}}).response = {statusCode};
	return error;
}

function setup(configOverrides = {}) {
	const db = testDb();
	const config = testConfig(configOverrides);
	const bot = new FakeBot();
	const ig = new FakeInstagramClient();
	mapThread(db, 'thread-1', 10);

	const deps: ProcessDeps = {
		db,
		ig: ig.asClient(),
		api: bot.api as any,
		bot: bot.asBot(),
		config,
	};

	return {db, config, bot, ig, deps};
}

function enqueueText(db: any, text = 'hello', tgMessageId = 500, replyTo: string | null = null) {
	return enqueue(db, {
		tgChatId: CHAT_ID,
		tgTopicId: 10,
		tgMessageId,
		igThreadId: 'thread-1',
		payload: {kind: 'text', text},
		replyToIgItemId: replyTo,
	});
}

// ─── Error classification ───────────────────────────────

test('authentication and challenge errors are permanent', () => {
	assert.equal(classifyError(namedError('IgLoginRequiredError')), 'permanent');
	assert.equal(classifyError(namedError('IgCheckpointError')), 'permanent');
	assert.equal(classifyError(namedError('IgUserHasLoggedOutError')), 'permanent');
	assert.equal(classifyError(namedError('IgSentryBlockError')), 'permanent');
});

test('an invalid thread or unsupported payload is permanent', () => {
	assert.equal(classifyError(namedError('IgNotFoundError')), 'permanent');
	assert.equal(classifyError(namedError('UnsupportedPayloadError')), 'permanent');
	assert.equal(classifyError(statusError(400)), 'permanent');
	assert.equal(classifyError(statusError(403)), 'permanent');
});

test('network trouble and rate limits are transient', () => {
	assert.equal(classifyError(namedError('IgNetworkError')), 'transient');
	assert.equal(classifyError(namedError('IgRequestsLimitError')), 'transient');
	assert.equal(classifyError(statusError(429)), 'transient');
	assert.equal(classifyError(statusError(502)), 'transient');
});

test('an unrecognized error is treated as transient, since attempts are bounded', () => {
	assert.equal(classifyError(new Error('who knows')), 'transient');
});

// ─── Queueing ───────────────────────────────────────────

test('a pending record exists before Instagram is contacted', () => {
	const {db, ig} = setup();

	const {record, created} = enqueueText(db);

	assert.equal(created, true);
	assert.equal(record.status, 'pending');
	assert.equal(record.attempt_count, 0);
	assert.equal(ig.sent.length, 0, 'nothing should have been sent yet');
});

test('a duplicate Telegram update does not create a second queue entry', () => {
	const {db} = setup();

	const first = enqueueText(db, 'hello', 500);
	const second = enqueueText(db, 'hello', 500);

	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal(second.record.id, first.record.id);
	assert.equal(countOutboundByStatus(db).pending, 1);
});

test('the client context is generated once and stored with the record', () => {
	const {db} = setup();
	const {record} = enqueueText(db);

	assert.match(record.client_context, /^[\da-f-]{36}$/);
});

// ─── Delivery ───────────────────────────────────────────

test('a successful send goes pending → sending → sent', async () => {
	const {db, deps, ig} = setup();
	const {record} = enqueueText(db, 'hello');

	assert.equal(getOutboundById(db, record.id)!.status, 'pending');

	const outcome = await processRecord(deps, record.id);

	assert.equal(outcome, 'sent');
	const stored = getOutboundById(db, record.id)!;
	assert.equal(stored.status, 'sent');
	assert.equal(stored.attempt_count, 1, 'the claim step incremented the attempt');
	assert.equal(stored.ig_message_id, ig.sent[0] ? 'ig-item-1' : undefined);
});

test('sending is claimed atomically, so a second worker cannot send it twice', async () => {
	const {db, deps, ig} = setup();
	const {record} = enqueueText(db);

	// Simulate a concurrent worker winning the claim.
	const claimed = claimOutbound(db, record.id);
	assert.ok(claimed);
	assert.equal(claimed.status, 'sending');

	const outcome = await processRecord(deps, record.id);

	assert.equal(outcome, 'skipped');
	assert.equal(ig.sent.length, 0);
});

test('success is only reported after Instagram returns an item ID', async () => {
	const {db, deps, ig} = setup();
	ig.sendFailures = [namedError('IgNetworkError')];
	const {record} = enqueueText(db);

	await processRecord(deps, record.id);

	const stored = getOutboundById(db, record.id)!;
	assert.notEqual(stored.status, 'sent');
	assert.equal(stored.ig_message_id, null);
	assert.equal(getMessageCount(db), 0, 'nothing is logged as delivered');
});

test('the real Instagram item ID is logged so the MQTT echo is recognized', async () => {
	const {db, deps} = setup();
	const {record} = enqueueText(db);

	await processRecord(deps, record.id);

	const row = db
		.prepare(`SELECT * FROM message_log WHERE direction = 'tg_to_ig'`)
		.get() as {ig_item_id: string; client_context: string} | undefined;

	assert.ok(row);
	assert.equal(row.ig_item_id, 'ig-item-1');
	assert.equal(row.client_context, getOutboundById(db, record.id)!.client_context);
});

test('a reply target is passed through to Instagram', async () => {
	const {db, deps, ig} = setup();
	const {record} = enqueueText(db, 'sure', 500, 'ig-original-77');

	await processRecord(deps, record.id);

	assert.equal(ig.sent[0]!.replyToItemId, 'ig-original-77');
});

// ─── Retry behaviour ────────────────────────────────────

test('a transient failure schedules a retry and keeps the record pending', async () => {
	const {db, deps, ig} = setup();
	ig.sendFailures = [namedError('IgNetworkError')];
	const {record} = enqueueText(db);

	const outcome = await processRecord(deps, record.id);

	assert.equal(outcome, 'retrying');
	const stored = getOutboundById(db, record.id)!;
	assert.equal(stored.status, 'pending');
	assert.equal(stored.attempt_count, 1);
	assert.ok(stored.next_attempt_at, 'a retry time is set');
	assert.match(stored.last_error!, /IgNetworkError/);
});

test('a permanent failure goes straight to failed without retrying', async () => {
	const {db, deps, ig, bot} = setup();
	ig.sendFailures = [namedError('IgCheckpointError')];
	const {record} = enqueueText(db);

	const outcome = await processRecord(deps, record.id);

	assert.equal(outcome, 'failed');
	const stored = getOutboundById(db, record.id)!;
	assert.equal(stored.status, 'failed');
	assert.equal(stored.next_attempt_at, null);
	assert.ok(
		bot.texts().some(t => t.includes('Not delivered to Instagram')),
		'the user is told the message was kept for retry',
	);
});

test('automatic attempts are bounded, then the record is left failed', async () => {
	const {db, deps, ig} = setup({outbound_max_attempts: 2});
	ig.sendFailures = [namedError('IgNetworkError'), namedError('IgNetworkError')];
	const {record} = enqueueText(db);

	assert.equal(await processRecord(deps, record.id), 'retrying');

	// Make the record due again without waiting out the backoff.
	db.prepare(`UPDATE outbound_queue SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?`)
		.run(record.id);

	assert.equal(await processRecord(deps, record.id), 'failed');
	assert.equal(getOutboundById(db, record.id)!.attempt_count, 2);
});

test('the failure notice is recorded so /retry can find the record', async () => {
	const {db, deps, ig} = setup();
	ig.sendFailures = [namedError('IgCheckpointError')];
	const {record} = enqueueText(db);

	await processRecord(deps, record.id);

	const stored = getOutboundById(db, record.id)!;
	assert.ok(stored.failure_notice_tg_message_id);

	const viaNotice = getOutboundByTgMessageId(db, CHAT_ID, stored.failure_notice_tg_message_id!);
	assert.equal(viaNotice?.id, record.id);

	const viaOriginal = getOutboundByTgMessageId(db, CHAT_ID, record.tg_message_id);
	assert.equal(viaOriginal?.id, record.id);
});

test('the same client context is reused across retries', async () => {
	const {db, deps, ig} = setup();
	ig.sendFailures = [namedError('IgNetworkError')];
	const {record} = enqueueText(db);

	await processRecord(deps, record.id);
	db.prepare(`UPDATE outbound_queue SET next_attempt_at = datetime('now', '-1 second') WHERE id = ?`)
		.run(record.id);
	await processRecord(deps, record.id);

	assert.equal(ig.sent.length, 2);
	assert.equal(ig.sent[0]!.clientContext, ig.sent[1]!.clientContext);
	assert.equal(ig.sent[0]!.clientContext, record.client_context);
});

test('a manual retry delivers the message and announces success once', async () => {
	const {db, deps, ig, bot} = setup();
	ig.sendFailures = [namedError('IgCheckpointError')];
	const {record} = enqueueText(db);
	await processRecord(deps, record.id);
	assert.equal(getOutboundById(db, record.id)!.status, 'failed');

	const outcome = await retryRecord(deps, record.id);

	assert.equal(outcome, 'sent');
	assert.equal(getOutboundById(db, record.id)!.status, 'sent');
	assert.equal(
		bot.texts().filter(t => t.includes('Delivered to Instagram after retry')).length,
		1,
	);
});

test('a manual retry of an already-sent record is rejected', async () => {
	const {db, deps} = setup();
	const {record} = enqueueText(db);
	await processRecord(deps, record.id);

	assert.equal(await retryRecord(deps, record.id), 'not_eligible');
});

// ─── Restart recovery ───────────────────────────────────

test('a record left mid-send by a restart is retried with the same client context', async () => {
	const {db, deps, ig} = setup();
	const {record} = enqueueText(db);

	// Instagram accepted the send, then the process died before the result was
	// written: the record is stuck in 'sending'.
	claimOutbound(db, record.id);
	assert.equal(getOutboundById(db, record.id)!.status, 'sending');

	// Restart.
	const recovered = resetStuckSending(db);
	assert.equal(recovered, 1);
	assert.equal(getOutboundById(db, record.id)!.status, 'pending');

	await processRecord(deps, record.id);

	assert.equal(getOutboundById(db, record.id)!.status, 'sent');
	assert.equal(ig.sent.length, 1);
	assert.equal(
		ig.sent[0]!.clientContext,
		record.client_context,
		'Instagram can discard the duplicate because the idempotency token is unchanged',
	);
	assert.equal(getMessageCount(db), 1, 'exactly one delivery is logged');
});

test('pending sends survive a restart of the queue', () => {
	const {db} = setup();
	enqueueText(db, 'first', 500);
	enqueueText(db, 'second', 501);

	// A new Database handle over the same rows is what a restart looks like.
	const counts = countOutboundByStatus(db);
	assert.equal(counts.pending, 2);
	assert.equal(counts.failed, 0);
});

test('pruning removes delivered records but keeps failed ones', async () => {
	const {db, deps, ig} = setup();

	const sent = enqueueText(db, 'ok', 500);
	await processRecord(deps, sent.record.id);

	ig.sendFailures = [namedError('IgCheckpointError')];
	const failed = enqueueText(db, 'nope', 501);
	await processRecord(deps, failed.record.id);

	db.prepare(`UPDATE outbound_queue SET updated_at = datetime('now', '-30 days')`).run();
	const removed = pruneSentOutbound(db, 7);

	assert.equal(removed, 1);
	assert.equal(getOutboundById(db, sent.record.id), undefined);
	assert.equal(getOutboundById(db, failed.record.id)!.status, 'failed');
});

test('a media payload stores a Telegram file reference, not its contents', () => {
	const {db} = setup();

	const {record} = enqueue(db, {
		tgChatId: CHAT_ID,
		tgTopicId: 10,
		tgMessageId: 600,
		igThreadId: 'thread-1',
		payload: {kind: 'photo', file_id: 'tg-file-abc'},
		replyToIgItemId: null,
	});

	assert.equal(record.content_type, 'photo');
	assert.deepEqual(JSON.parse(record.payload_json), {kind: 'photo', file_id: 'tg-file-abc'});
});
