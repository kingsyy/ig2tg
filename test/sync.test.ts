import test from 'node:test';
import assert from 'node:assert/strict';
import {GrammyError} from 'grammy';
import {
	countOutboundByStatus,
	getMessageCount,
	getThreadByIgId,
	logMessage,
	messageExists,
} from '../source/bridge/db.js';
import {
	buildOutboundPayload,
	resolveReplyTarget,
	routeIncomingIGMessage,
	routeTelegramToIG,
} from '../source/bridge/sync.js';
import {enqueue, processRecord} from '../source/bridge/outbound.js';
import {DISAPPEARING_MEDIA_NOTICE} from '../source/utils/message-parser.js';
import {
	CHAT_ID,
	FakeBot,
	FakeInstagramClient,
	MY_USER_ID,
	PEER_USER_ID,
	igPlaceholderMessage,
	igTextMessage,
	mapThread,
	tgContext,
	tgMessage,
	testConfig,
	testDb,
} from './helpers.js';

function setup(configOverrides = {}) {
	const db = testDb();
	const config = testConfig(configOverrides);
	const bot = new FakeBot();
	const ig = new FakeInstagramClient();
	return {db, config, bot, ig};
}

function grammyError(code: number, description: string): GrammyError {
	return new GrammyError(
		`Call to 'createForumTopic' failed!`,
		{ok: false, error_code: code, description},
		'createForumTopic',
		{},
	);
}

// ─── Inbound routing ────────────────────────────────────

test('an incoming message is forwarded and logged', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);

	const outcome = await routeIncomingIGMessage(
		igTextMessage(),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'forwarded');
	assert.equal(bot.texts()[0], 'hello');
	assert.ok(messageExists(db, 'ig-msg-1'));
});

test('an already-delivered message is skipped', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	logMessage(db, {
		ig_message_id: 'ig-msg-1',
		tg_message_id: 900,
		ig_thread_id: 'thread-1',
		direction: 'ig_to_tg',
		content_type: 'text',
	});

	const outcome = await routeIncomingIGMessage(
		igTextMessage(),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'skipped');
	assert.equal(bot.sent.length, 0);
});

test('a topic is created when the thread has no mapping yet', async () => {
	const {db, config, bot, ig} = setup();

	await routeIncomingIGMessage(igTextMessage(), ig.asClient(), bot.asBot(), db, config);

	assert.deepEqual(bot.createdTopics, ['@peer']);
	assert.ok(getThreadByIgId(db, 'thread-1'));
});

test('a permission failure creating the topic leaves the message unlogged for retry', async () => {
	const {db, config, bot, ig} = setup();
	bot.topicFailures = [grammyError(400, 'Bad Request: not enough rights to create a topic')];

	const outcome = await routeIncomingIGMessage(
		igTextMessage(),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'failed');
	assert.equal(
		messageExists(db, 'ig-msg-1'),
		false,
		'reconciliation must still be able to find it',
	);
});

test('topic creation failing then succeeding delivers the message on the retry', async () => {
	const {db, config, bot, ig} = setup();
	bot.topicFailures = [grammyError(400, 'Bad Request: not enough rights to create a topic')];

	assert.equal(
		await routeIncomingIGMessage(igTextMessage(), ig.asClient(), bot.asBot(), db, config),
		'failed',
	);

	// The Telegram permission is fixed; the same message is retried.
	assert.equal(
		await routeIncomingIGMessage(igTextMessage(), ig.asClient(), bot.asBot(), db, config),
		'forwarded',
	);
	assert.equal(bot.texts()[0], 'hello');
});

test('a failing Telegram send leaves the message unlogged for retry', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	bot.sendFailures = [grammyError(429, 'Too Many Requests')];

	const outcome = await routeIncomingIGMessage(
		igTextMessage(),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'failed');
	assert.equal(messageExists(db, 'ig-msg-1'), false);
	assert.equal(getMessageCount(db), 0);
});

test('a group thread prefixes the sender', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10, {isGroup: true});

	await routeIncomingIGMessage(
		igTextMessage({username: 'someone'}),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(bot.texts()[0], '@someone: hello');
});

// ─── Disappearing media ─────────────────────────────────

test('disappearing media is announced without downloading anything', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);

	const outcome = await routeIncomingIGMessage(
		igPlaceholderMessage(DISAPPEARING_MEDIA_NOTICE, {id: 'ig-raven-1'}),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'forwarded');
	assert.equal(bot.texts()[0], DISAPPEARING_MEDIA_NOTICE);
	assert.deepEqual(ig.downloadedMedia, [], 'no media download function was called');
	assert.equal(
		bot.sent.every(s => s.method === 'sendMessage'),
		true,
		'it is sent as text, never as a photo or video',
	);
});

// ─── Own messages and echo suppression ──────────────────

test('the echo of a bridge send is suppressed by client context', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);

	const {record} = enqueue(db, {
		tgChatId: CHAT_ID,
		tgTopicId: 10,
		tgMessageId: 500,
		igThreadId: 'thread-1',
		payload: {kind: 'text', text: 'sent from telegram'},
		replyToIgItemId: null,
	});
	await processRecord(
		{db, ig: ig.asClient(), api: bot.api as any, bot: bot.asBot(), config},
		record.id,
	);
	const sentCount = bot.sent.length;

	// Instagram echoes our own send back over MQTT with a different item ID.
	const outcome = await routeIncomingIGMessage(
		igTextMessage({
			id: 'ig-echo-999',
			userId: MY_USER_ID,
			username: 'me',
			text: 'sent from telegram',
			client_context: record.client_context,
		}),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'skipped');
	assert.equal(bot.sent.length, sentCount, 'nothing new was posted to Telegram');
});

test('a message sent from the Instagram app is forwarded with a "You" prefix', async () => {
	const {db, config, bot, ig} = setup({forward_own_messages: true});
	mapThread(db, 'thread-1', 10);

	const outcome = await routeIncomingIGMessage(
		igTextMessage({id: 'ig-self-1', userId: MY_USER_ID, username: 'me', text: 'from my phone'}),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'forwarded');
	assert.equal(bot.texts()[0], '📤 You: from my phone');

	const row = db
		.prepare('SELECT direction FROM message_log WHERE ig_item_id = ?')
		.get('ig-self-1') as {direction: string};
	assert.equal(row.direction, 'ig_self_to_tg');
});

test('own messages are not forwarded when the option is off', async () => {
	const {db, config, bot, ig} = setup({forward_own_messages: false});
	mapThread(db, 'thread-1', 10);

	const outcome = await routeIncomingIGMessage(
		igTextMessage({id: 'ig-self-2', userId: MY_USER_ID, username: 'me'}),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'skipped');
	assert.equal(bot.sent.length, 0);
});

test('an own media echo is suppressed by the recent-send window', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);

	// A photo the bridge just sent. Instagram's upload flow gives the bridge no
	// control over client_context, so the time window is the only signal.
	logMessage(db, {
		ig_message_id: 'ig-photo-broadcast',
		tg_message_id: 500,
		ig_thread_id: 'thread-1',
		direction: 'tg_to_ig',
		content_type: 'photo',
	});

	const outcome = await routeIncomingIGMessage(
		{
			...igTextMessage({id: 'ig-photo-echo', userId: MY_USER_ID, username: 'me'}),
			itemType: 'media',
			media: {
				id: 'm1',
				media_type: 1,
				original_width: 10,
				original_height: 10,
				image_versions2: {candidates: [{url: 'https://cdn/p.jpg', width: 10, height: 10}]},
			},
		} as any,
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(outcome, 'skipped');
	assert.deepEqual(ig.downloadedMedia, []);
});

// ─── Reply resolution ───────────────────────────────────

test('a Telegram reply resolves to the correct Instagram item ID', () => {
	const {db} = setup();
	const mapping = mapThread(db, 'thread-1', 10);
	logMessage(db, {
		ig_message_id: 'ig-original-1',
		tg_message_id: 900,
		ig_thread_id: 'thread-1',
		direction: 'ig_to_tg',
		content_type: 'text',
	});

	const resolution = resolveReplyTarget(db, {message_id: 900}, 10, mapping);

	assert.equal(resolution.itemId, 'ig-original-1');
	assert.equal(resolution.unmapped, false);
});

test('a reply to an unknown Telegram message falls back to an ordinary send', () => {
	const {db} = setup();
	const mapping = mapThread(db, 'thread-1', 10);

	const resolution = resolveReplyTarget(db, {message_id: 12_345}, 10, mapping);

	assert.equal(resolution.itemId, null);
	assert.equal(resolution.unmapped, true);
});

test('a reply target in another topic is rejected as a reply target', () => {
	const {db} = setup();
	const mapping = mapThread(db, 'thread-1', 10);
	mapThread(db, 'thread-2', 20);
	logMessage(db, {
		ig_message_id: 'ig-other-thread',
		tg_message_id: 950,
		ig_thread_id: 'thread-2',
		direction: 'ig_to_tg',
		content_type: 'text',
	});

	const resolution = resolveReplyTarget(db, {message_id: 950}, 10, mapping);

	assert.equal(resolution.itemId, null, 'the reply must not attach to another conversation');
	assert.equal(resolution.unmapped, true);
});

test('the forum topic service message is not treated as a reply', () => {
	const {db} = setup();
	const mapping = mapThread(db, 'thread-1', 10);

	assert.equal(
		resolveReplyTarget(db, {message_id: 10, forum_topic_created: {name: '@peer'}}, 10, mapping)
			.itemId,
		null,
	);
	assert.equal(
		resolveReplyTarget(db, {message_id: 10, forum_topic_created: {name: '@peer'}}, 10, mapping)
			.unmapped,
		false,
		'this is not a failed mapping, it is not a reply at all',
	);
});

test('no reply context means no reply target', () => {
	const {db} = setup();
	const mapping = mapThread(db, 'thread-1', 10);

	assert.deepEqual(resolveReplyTarget(db, undefined, 10, mapping), {
		itemId: null,
		unmapped: false,
	});
});

test('a message forwarded with tg_message_id 0 is not a usable reply target', () => {
	const {db} = setup();
	const mapping = mapThread(db, 'thread-1', 10);
	// Suppressed echoes are logged with tg_message_id 0.
	logMessage(db, {
		ig_message_id: 'ig-suppressed',
		tg_message_id: 0,
		ig_thread_id: 'thread-1',
		direction: 'tg_to_ig',
		content_type: 'text',
	});

	assert.equal(resolveReplyTarget(db, {message_id: 0}, 10, mapping).itemId, null);
});

// ─── Payload building ───────────────────────────────────

test('payloads are built for each supported content type', () => {
	assert.deepEqual(buildOutboundPayload({text: 'hi'}), {kind: 'text', text: 'hi'});
	assert.deepEqual(
		buildOutboundPayload({photo: [{file_id: 'small'}, {file_id: 'large'}]}),
		{kind: 'photo', file_id: 'large'},
	);
	assert.deepEqual(buildOutboundPayload({video: {file_id: 'v'}}), {kind: 'video', file_id: 'v'});
	assert.deepEqual(buildOutboundPayload({voice: {file_id: 'a'}}), {kind: 'voice', file_id: 'a'});
	assert.equal(buildOutboundPayload({}), undefined);
});

// ─── Telegram → Instagram end to end ────────────────────

test('a Telegram message is queued and delivered as a native reply', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	logMessage(db, {
		ig_message_id: 'ig-original-1',
		tg_message_id: 900,
		ig_thread_id: 'thread-1',
		direction: 'ig_to_tg',
		content_type: 'text',
	});

	const message = tgMessage({text: 'on it', reply_to_message: {message_id: 900}});
	await routeTelegramToIG(
		tgContext(bot, message),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(ig.sent.length, 1);
	assert.equal(ig.sent[0]!.text, 'on it');
	assert.equal(ig.sent[0]!.replyToItemId, 'ig-original-1');
	assert.equal(countOutboundByStatus(db).sent, 1);
});

test('a duplicate Telegram update does not send the message twice', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);
	const message = tgMessage({text: 'once'});

	await routeTelegramToIG(tgContext(bot, message), ig.asClient(), bot.asBot(), db, config);
	await routeTelegramToIG(tgContext(bot, message), ig.asClient(), bot.asBot(), db, config);

	assert.equal(ig.sent.length, 1);
	assert.equal(countOutboundByStatus(db).sent, 1);
});

test('a message from anyone other than the owner is ignored', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);

	await routeTelegramToIG(
		tgContext(bot, tgMessage({from: {id: 999}})),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(ig.sent.length, 0);
	assert.equal(countOutboundByStatus(db).pending, 0);
});

test('a message in an unmapped topic is not queued', async () => {
	const {db, config, bot, ig} = setup();

	await routeTelegramToIG(
		tgContext(bot, tgMessage({message_thread_id: 77})),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(ig.sent.length, 0);
	assert.equal(countOutboundByStatus(db).pending, 0);
});

test('an unsupported payload is refused before anything is queued', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);

	await routeTelegramToIG(
		tgContext(bot, tgMessage({text: undefined, sticker: {file_id: 's'}})),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(countOutboundByStatus(db).pending, 0);
	assert.ok(bot.texts().some(t => t.includes('Unsupported message type')));
});

test('a reply that cannot be mapped is still sent as an ordinary message', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10);

	await routeTelegramToIG(
		tgContext(bot, tgMessage({text: 'still send me', reply_to_message: {message_id: 4242}})),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(ig.sent.length, 1);
	assert.equal(ig.sent[0]!.text, 'still send me');
	assert.equal(ig.sent[0]!.replyToItemId, undefined);
});

test('the sender is identified by user ID, not username', async () => {
	const {db, config, bot, ig} = setup();
	mapThread(db, 'thread-1', 10, {userId: PEER_USER_ID});

	await routeIncomingIGMessage(
		igTextMessage({userId: PEER_USER_ID}),
		ig.asClient(),
		bot.asBot(),
		db,
		config,
	);

	assert.equal(getThreadByIgId(db, 'thread-1')!.is_group, 0, 'a single sender is not a group');
});
