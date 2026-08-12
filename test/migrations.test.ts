import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {
	countOutboundByStatus,
	getMessageByTgId,
	getState,
	messageExists,
	runMigrations,
	setState,
} from '../source/bridge/db.js';
import {setLogLevel} from '../source/bridge/logger.js';

setLogLevel('error');

/**
 * The schema as it existed before this change: no `is_group`, no `ig_item_id`,
 * no `client_context`, no `migrations` table, and plaintext Instagram IDs.
 */
function legacyDb(): Database.Database {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE thread_map (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			ig_thread_id    TEXT    UNIQUE NOT NULL,
			ig_username     TEXT    NOT NULL,
			ig_full_name    TEXT    NOT NULL DEFAULT '',
			ig_user_id      TEXT    NOT NULL DEFAULT '',
			tg_topic_id     INTEGER UNIQUE NOT NULL,
			created_at      DATETIME DEFAULT (datetime('now')),
			is_active       BOOLEAN DEFAULT 1
		);

		CREATE TABLE message_log (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			ig_message_id   TEXT    NOT NULL,
			tg_message_id   INTEGER NOT NULL DEFAULT 0,
			ig_thread_id    TEXT    NOT NULL,
			direction       TEXT    NOT NULL CHECK(direction IN ('ig_to_tg', 'ig_self_to_tg', 'tg_to_ig')),
			content_type    TEXT    NOT NULL DEFAULT 'text',
			timestamp       DATETIME DEFAULT (datetime('now')),
			FOREIGN KEY (ig_thread_id) REFERENCES thread_map(ig_thread_id)
		);
	`);

	db.prepare(
		`INSERT INTO thread_map (ig_thread_id, ig_username, ig_full_name, ig_user_id, tg_topic_id)
		 VALUES ('thread-legacy', 'peer', 'Peer Person', '2000', 7)`,
	).run();

	db.prepare(
		`INSERT INTO message_log (ig_message_id, tg_message_id, ig_thread_id, direction, content_type)
		 VALUES ('plaintext-item-1', 901, 'thread-legacy', 'ig_to_tg', 'text')`,
	).run();

	return db;
}

test('migrating a legacy database preserves its thread mappings', () => {
	const db = legacyDb();

	runMigrations(db);

	const thread = db
		.prepare(`SELECT * FROM thread_map WHERE ig_thread_id = 'thread-legacy'`)
		.get() as Record<string, unknown>;

	assert.equal(thread['ig_username'], 'peer');
	assert.equal(thread['ig_full_name'], 'Peer Person');
	assert.equal(thread['tg_topic_id'], 7);
	assert.equal(thread['is_group'], 0, 'the new column gets its default');
});

test('migrating a legacy database preserves its message log and hashes the IDs', () => {
	const db = legacyDb();

	runMigrations(db);

	const rows = db.prepare('SELECT * FROM message_log').all() as Array<Record<string, unknown>>;
	assert.equal(rows.length, 1, 'no row was dropped');
	assert.equal(
		rows[0]!['ig_message_id'],
		createHash('sha256').update('plaintext-item-1').digest('hex'),
	);
	assert.ok(messageExists(db, 'plaintext-item-1'), 'dedup still recognizes the old message');
});

test('rows migrated from the legacy schema have no reversible item ID', () => {
	const db = legacyDb();

	runMigrations(db);

	// A hash cannot be reversed, so historic rows cannot serve as reply targets.
	// New messages get `ig_item_id` populated as they are forwarded.
	const entry = getMessageByTgId(db, 901);
	assert.ok(entry);
	assert.equal(entry.ig_item_id, null);
});

test('the new tables are created on a legacy database', () => {
	const db = legacyDb();

	runMigrations(db);

	assert.deepEqual(countOutboundByStatus(db), {pending: 0, sending: 0, sent: 0, failed: 0});
	setState(db, 'probe', 'value');
	assert.equal(getState(db, 'probe'), 'value');
});

test('running migrations repeatedly is a no-op', () => {
	const db = legacyDb();

	runMigrations(db);
	const afterFirst = db.prepare('SELECT * FROM message_log').all();

	runMigrations(db);
	runMigrations(db);

	assert.deepEqual(db.prepare('SELECT * FROM message_log').all(), afterFirst);
	assert.equal(
		(db.prepare('SELECT COUNT(*) as c FROM thread_map').get() as {c: number}).c,
		1,
	);
});

test('the ID hashing migration does not run twice and re-hash the hashes', () => {
	const db = legacyDb();

	runMigrations(db);
	const hashed = (
		db.prepare('SELECT ig_message_id FROM message_log').get() as {ig_message_id: string}
	).ig_message_id;

	runMigrations(db);

	const after = (
		db.prepare('SELECT ig_message_id FROM message_log').get() as {ig_message_id: string}
	).ig_message_id;
	assert.equal(after, hashed);
	assert.ok(messageExists(db, 'plaintext-item-1'));
});

test('migrating a fresh database produces the full schema', () => {
	const db = new Database(':memory:');

	runMigrations(db);

	const tables = (
		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{name: string}>
	).map(t => t.name);

	for (const expected of ['thread_map', 'message_log', 'outbound_queue', 'bridge_state', 'migrations']) {
		assert.ok(tables.includes(expected), `missing table ${expected}`);
	}
});

test('the outbound queue rejects an unknown status', () => {
	const db = new Database(':memory:');
	runMigrations(db);

	assert.throws(() => {
		db.prepare(`
			INSERT INTO outbound_queue (
				tg_chat_id, tg_topic_id, tg_message_id, ig_thread_id, content_type,
				payload_json, client_context, status
			) VALUES (1, 2, 3, 'thread-1', 'text', '{}', 'ctx', 'bogus')
		`).run();
	}, /CHECK constraint failed/);
});
