import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createLogger} from './logger.js';

function hashId(id: string): string {
	return createHash('sha256').update(id).digest('hex');
}

const logger = createLogger('db');

export type ThreadMapping = {
	id: number;
	ig_thread_id: string;
	ig_username: string;
	ig_full_name: string;
	ig_user_id: string;
	tg_topic_id: number;
	created_at: string;
	is_active: number;
	is_group: number;
};

export type MessageLogEntry = {
	id: number;
	ig_message_id: string;
	tg_message_id: number;
	ig_thread_id: string;
	direction: 'ig_to_tg' | 'ig_self_to_tg' | 'tg_to_ig';
	content_type: string;
	timestamp: string;
};

export function initDatabase(dbPath: string): Database.Database {
	const db = new Database(dbPath);

	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	runMigrations(db);

	logger.info(`Database initialized at ${dbPath}`);
	return db;
}

function runMigrations(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS thread_map (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			ig_thread_id    TEXT    UNIQUE NOT NULL,
			ig_username     TEXT    NOT NULL,
			ig_full_name    TEXT    NOT NULL DEFAULT '',
			ig_user_id      TEXT    NOT NULL DEFAULT '',
			tg_topic_id     INTEGER UNIQUE NOT NULL,
			created_at      DATETIME DEFAULT (datetime('now')),
			is_active       BOOLEAN DEFAULT 1,
			is_group        BOOLEAN DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS message_log (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			ig_message_id   TEXT    NOT NULL,
			tg_message_id   INTEGER NOT NULL DEFAULT 0,
			ig_thread_id    TEXT    NOT NULL,
			direction       TEXT    NOT NULL CHECK(direction IN ('ig_to_tg', 'ig_self_to_tg', 'tg_to_ig')),
			content_type    TEXT    NOT NULL DEFAULT 'text',
			timestamp       DATETIME DEFAULT (datetime('now')),
			FOREIGN KEY (ig_thread_id) REFERENCES thread_map(ig_thread_id)
		);

		CREATE INDEX IF NOT EXISTS idx_message_log_ig_message_id ON message_log(ig_message_id);
		CREATE INDEX IF NOT EXISTS idx_thread_map_tg_topic_id ON thread_map(tg_topic_id);
	`);

	// Add is_group column for existing databases
	try {
		db.exec(`ALTER TABLE thread_map ADD COLUMN is_group BOOLEAN DEFAULT 0`);
	} catch {
		// Column already exists
	}

	// Migrate existing plaintext ig_message_ids to SHA-256 hashes
	db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)`);
	const hashDone = db.prepare(`SELECT 1 FROM migrations WHERE name = 'hash_ig_message_ids'`).get();
	if (!hashDone) {
		const rows = db.prepare('SELECT id, ig_message_id FROM message_log').all() as {id: number; ig_message_id: string}[];
		const update = db.prepare('UPDATE message_log SET ig_message_id = ? WHERE id = ?');
		const migrate = db.transaction(() => {
			for (const row of rows) {
				update.run(hashId(row.ig_message_id), row.id);
			}
			db.prepare(`INSERT INTO migrations VALUES ('hash_ig_message_ids')`).run();
		});
		migrate();
		if (rows.length > 0) logger.info(`Migrated ${rows.length} message IDs to hashes`);
	}

	logger.info('Database migrations complete');
}

// ─── Query helpers ──────────────────────────────────────

export function getThreadByIgId(db: Database.Database, igThreadId: string): ThreadMapping | undefined {
	return db.prepare('SELECT * FROM thread_map WHERE ig_thread_id = ?').get(igThreadId) as ThreadMapping | undefined;
}

export function getThreadByTopicId(db: Database.Database, tgTopicId: number): ThreadMapping | undefined {
	return db.prepare('SELECT * FROM thread_map WHERE tg_topic_id = ?').get(tgTopicId) as ThreadMapping | undefined;
}

export function createThreadMapping(
	db: Database.Database,
	mapping: Omit<ThreadMapping, 'id' | 'created_at' | 'is_active'>,
): ThreadMapping {
	const stmt = db.prepare(`
		INSERT INTO thread_map (ig_thread_id, ig_username, ig_full_name, ig_user_id, tg_topic_id, is_group)
		VALUES (?, ?, ?, ?, ?, ?)
	`);
	stmt.run(mapping.ig_thread_id, mapping.ig_username, mapping.ig_full_name, mapping.ig_user_id, mapping.tg_topic_id, mapping.is_group);
	return getThreadByIgId(db, mapping.ig_thread_id)!;
}

export function setThreadIsGroup(db: Database.Database, igThreadId: string): void {
	db.prepare('UPDATE thread_map SET is_group = 1 WHERE ig_thread_id = ?').run(igThreadId);
}

export function messageExists(db: Database.Database, igMessageId: string): boolean {
	const row = db.prepare('SELECT 1 FROM message_log WHERE ig_message_id = ?').get(hashId(igMessageId));
	return row !== undefined;
}

export function logMessage(
	db: Database.Database,
	entry: Omit<MessageLogEntry, 'id' | 'timestamp'>,
): void {
	db.prepare(`
		INSERT INTO message_log (ig_message_id, tg_message_id, ig_thread_id, direction, content_type)
		VALUES (?, ?, ?, ?, ?)
	`).run(hashId(entry.ig_message_id), entry.tg_message_id, entry.ig_thread_id, entry.direction, entry.content_type);
}

export function getMessageByIgId(db: Database.Database, igMessageId: string): MessageLogEntry | undefined {
	return db.prepare('SELECT * FROM message_log WHERE ig_message_id = ?').get(hashId(igMessageId)) as MessageLogEntry | undefined;
}

export function getAllActiveThreads(db: Database.Database): ThreadMapping[] {
	return db.prepare('SELECT * FROM thread_map WHERE is_active = 1 ORDER BY created_at DESC').all() as ThreadMapping[];
}

export function setThreadActive(db: Database.Database, igThreadId: string, active: boolean): void {
	db.prepare('UPDATE thread_map SET is_active = ? WHERE ig_thread_id = ?').run(active ? 1 : 0, igThreadId);
}

export function getMessageCount(db: Database.Database): number {
	const row = db.prepare('SELECT COUNT(*) as count FROM message_log').get() as {count: number};
	return row.count;
}

/**
 * Check if we recently sent a message to a thread from TG (within the last 60s).
 * Used as fallback echo prevention when the IG message ID doesn't match exactly.
 */
export function hasRecentBridgeSend(db: Database.Database, igThreadId: string): boolean {
	const row = db.prepare(
		`SELECT 1 FROM message_log WHERE ig_thread_id = ? AND direction = 'tg_to_ig' AND timestamp > datetime('now', '-60 seconds') LIMIT 1`,
	).get(igThreadId);
	return row !== undefined;
}

export function getAllThreads(db: Database.Database): ThreadMapping[] {
	return db.prepare('SELECT * FROM thread_map ORDER BY created_at DESC').all() as ThreadMapping[];
}

export function clearAllData(db: Database.Database): {threads: number; messages: number} {
	const threads = (db.prepare('SELECT COUNT(*) as count FROM thread_map').get() as {count: number}).count;
	const messages = (db.prepare('SELECT COUNT(*) as count FROM message_log').get() as {count: number}).count;
	db.prepare('DELETE FROM message_log').run();
	db.prepare('DELETE FROM thread_map').run();
	return {threads, messages};
}
