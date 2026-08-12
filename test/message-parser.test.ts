import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageSyncMessageTypes} from 'instagram_mqtt';
import {
	DISAPPEARING_MEDIA_NOTICE,
	parseMessageItem,
	getBestMediaUrl,
} from '../source/utils/message-parser.js';

const context = {
	userCache: new Map([['2000', 'peer']]),
	currentUserId: '1000',
};

function item(overrides: Record<string, unknown>): any {
	return {
		item_id: 'item-1',
		user_id: 2000,
		timestamp: 1_754_900_000_000_000,
		...overrides,
	};
}

test('raven_media becomes the explicit "open Instagram" notice', () => {
	const parsed = parseMessageItem(
		item({item_type: MessageSyncMessageTypes.RavenMedia}),
		'thread-1',
		context,
	);

	assert.ok(parsed);
	assert.equal(parsed.itemType, 'placeholder');
	assert.equal(
		(parsed as {text: string}).text,
		'📷 You received a disappearing photo or video. Open Instagram to view it.',
	);
});

test('the notice tells the user to open Instagram', () => {
	assert.match(DISAPPEARING_MEDIA_NOTICE, /Open Instagram/);
	assert.doesNotMatch(DISAPPEARING_MEDIA_NOTICE, /\[Disappearing message]/);
});

test('a visual_media envelope is recognized even under another item type', () => {
	// Instagram also delivers disappearing media as a `visual_media` envelope,
	// sometimes carrying an item type that would otherwise be downloadable media.
	const parsed = parseMessageItem(
		item({
			item_type: MessageSyncMessageTypes.Media,
			visual_media: {
				media: {
					image_versions2: {candidates: [{url: 'https://cdn/secret.jpg', width: 1, height: 1}]},
				},
			},
		}),
		'thread-1',
		context,
	);

	assert.ok(parsed);
	assert.equal(parsed.itemType, 'placeholder');
	assert.equal((parsed as {text: string}).text, DISAPPEARING_MEDIA_NOTICE);
});

test('a visual_media item type is recognized', () => {
	const parsed = parseMessageItem(item({item_type: 'visual_media'}), 'thread-1', context);
	assert.equal(parsed?.itemType, 'placeholder');
	assert.equal((parsed as {text: string}).text, DISAPPEARING_MEDIA_NOTICE);
});

test('disappearing media exposes no media object, so nothing can be downloaded', () => {
	const parsed = parseMessageItem(
		item({
			item_type: MessageSyncMessageTypes.RavenMedia,
			media: {
				id: 'm1',
				media_type: 1,
				original_width: 100,
				original_height: 100,
				image_versions2: {candidates: [{url: 'https://cdn/one-time.jpg', width: 100, height: 100}]},
			},
		}),
		'thread-1',
		context,
	);

	assert.ok(parsed);
	// The media forwarding path requires itemType 'media' plus a `media` field.
	// A placeholder can never reach `forwardMediaToTelegram` or `downloadMedia`.
	assert.equal(parsed.itemType, 'placeholder');
	assert.equal((parsed as Record<string, unknown>)['media'], undefined);
	assert.equal(getBestMediaUrl((parsed as any).media ?? {}), undefined);
});

test('ordinary media is still parsed as downloadable media', () => {
	const parsed = parseMessageItem(
		item({
			item_type: MessageSyncMessageTypes.Media,
			media: {
				id: 'm1',
				media_type: 1,
				original_width: 100,
				original_height: 100,
				image_versions2: {candidates: [{url: 'https://cdn/photo.jpg', width: 100, height: 100}]},
			},
		}),
		'thread-1',
		context,
	);

	assert.equal(parsed?.itemType, 'media');
});

test('text messages are unaffected', () => {
	const parsed = parseMessageItem(
		item({item_type: MessageSyncMessageTypes.Text, text: 'hello'}),
		'thread-1',
		context,
	);

	assert.equal(parsed?.itemType, 'text');
	assert.equal((parsed as {text: string}).text, 'hello');
});
