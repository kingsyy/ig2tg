import test from 'node:test';
import assert from 'node:assert/strict';
import {describeError, errorClass, logFields} from '../source/utils/redact.js';
import {logTag} from '../source/bridge/db.js';

test('the error class is reported', () => {
	const error = new Error('nope');
	error.name = 'IgNetworkError';

	assert.equal(errorClass(error), 'IgNetworkError');
	assert.match(describeError(error), /^IgNetworkError/);
});

test('a response body in the error message is dropped, not logged', () => {
	// This is what an Instagram send failure actually looks like: the request and
	// response bodies land in `error.message`, including the message text.
	const error = new Error(
		'POST /api/v1/direct_v2/threads/broadcast/text/ - 400 {"text":"my private message","status":"fail"}',
	);
	error.name = 'IgResponseError';
	(error as unknown as {response: {statusCode: number}}).response = {statusCode: 400};

	const described = describeError(error);

	assert.doesNotMatch(described, /my private message/);
	assert.equal(described, 'IgResponseError http_400');
});

test('an HTML error page is dropped too', () => {
	const error = new Error('<html><body>Too Many Requests</body></html>');
	assert.doesNotMatch(describeError(error), /html/);
});

test('a session cookie is redacted from a plain message', () => {
	const error = new Error('auth failed for sessionid=abc123XYZ; retry');
	const described = describeError(error);

	assert.doesNotMatch(described, /abc123XYZ/);
	assert.match(described, /sessionid=\[redacted]/);
});

test('a Telegram bot token is redacted', () => {
	const error = new Error('request to bot123456789:AAHfake-token-value failed');
	const described = describeError(error);

	assert.doesNotMatch(described, /AAHfake-token-value/);
	assert.match(described, /\[redacted-bot-token]/);
});

test('a password field is redacted', () => {
	const error = new Error('login rejected password=hunter2');
	assert.doesNotMatch(describeError(error), /hunter2/);
});

test('long details are truncated', () => {
	const error = new Error('x'.repeat(1000));
	assert.ok(describeError(error).length < 220);
});

test('a non-Error value never contributes free text', () => {
	assert.equal(describeError('a raw string that could be anything'), 'string');
	assert.equal(describeError(undefined), 'UnknownError');
	assert.equal(describeError({secret: 'value'}), 'object');
});

test('a grammY-style error contributes its code, not its payload', () => {
	const error = new Error(`Call to 'createForumTopic' failed!`);
	error.name = 'GrammyError';
	(error as unknown as {error_code: number}).error_code = 400;

	assert.equal(describeError(error), "GrammyError http_400 Call to 'createForumTopic' failed!");
});

test('log fields drop empty values and never quote', () => {
	assert.equal(
		logFields({direction: 'tg_to_ig', attempt: 2, missing: undefined, blank: ''}),
		'direction=tg_to_ig attempt=2',
	);
});

test('a log tag is short, stable, and not the identifier', () => {
	const id = '340282366841710300949128174822943265667';

	assert.equal(logTag(id).length, 10);
	assert.equal(logTag(id), logTag(id));
	assert.notEqual(logTag(id), id);
	assert.notEqual(logTag(id), logTag(`${id}1`));
});
