import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createLogger} from './logger.js';

function hashId(id: string): string {
	return createHash('sha256').update(id).digest('hex');
}

/**
 * A short, non-reversible tag for an identifier, safe to put in logs.
 * Long enough to correlate lines, too short to be useful to anyone else.
 */
export function logTag(id: string): string {
	return hashId(id).slice(0, 10);
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
	/**
	 * The original (reversible) Instagram item ID.
	 *
	 * `ig_message_id` above is a SHA-256 hash used for dedup only. Native
	 * Instagram replies need the real item ID, which a hash cannot recover, so it
	 * is kept here as an opaque value in the permission-restricted database.
	 * Message bodies are never stored.
	 */
	ig_item_id: string | null;
	/** Instagram's client_context for this item, when known. Used for echo detection. */
	client_context: string | null;
};

export type OutboundStatus = 'pending' | 'sending' | 'sent' | 'failed';

export type OutboundRecord = {
	id: number;
	tg_chat_id: number;
	tg_topic_id: number;
	tg_message_id: number;
	ig_thread_id: string;
	content_type: string;
	payload_json: string;
	reply_to_ig_item_id: string | null;
	client_context: string;
	status: OutboundStatus;
	attempt_count: number;
	last_error: string | null;
	next_attempt_at: string | null;
	ig_message_id: string | null;
	failure_notice_tg_message_id: number | null;
	created_at: string;
	updated_at: string;
};

export function initDatabase(dbPath: string): Database.Database {
	const db = new Database(dbPath);

	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	runMigrations(db);

	logger.info(`Database initialized at ${dbPath}`);
	return db;
}

/**
 * Adds a column only when it is missing. Safe to run on every startup.
 */
function addColumnIfMissing(
	db: Database.Database,
	table: string,
	column: string,
	definition: string,
): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
	if (columns.some(c => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	logger.info(`Migration: added ${table}.${column}`);
}

/**
 * All migrations are idempotent: every statement is either `IF NOT EXISTS`,
 * guarded by a `migrations` marker row, or guarded by a column check. Running
 * them repeatedly against the existing production database is a no-op, and no
 * existing `thread_map` or `message_log` row is dropped or rewritten.
 */
export function runMigrations(db: Database.Database): void {
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

		CREATE TABLE IF NOT EXISTS outbound_queue (
			id                            INTEGER PRIMARY KEY AUTOINCREMENT,
			tg_chat_id                    INTEGER NOT NULL,
			tg_topic_id                   INTEGER NOT NULL,
			tg_message_id                 INTEGER NOT NULL,
			ig_thread_id                  TEXT    NOT NULL,
			content_type                  TEXT    NOT NULL,
			payload_json                  TEXT    NOT NULL,
			reply_to_ig_item_id           TEXT,
			client_context                TEXT    NOT NULL,
			status                        TEXT    NOT NULL
			                              CHECK(status IN ('pending', 'sending', 'sent', 'failed')),
			attempt_count                 INTEGER NOT NULL DEFAULT 0,
			last_error                    TEXT,
			next_attempt_at               DATETIME,
			ig_message_id                 TEXT,
			failure_notice_tg_message_id  INTEGER,
			created_at                    DATETIME DEFAULT (datetime('now')),
			updated_at                    DATETIME DEFAULT (datetime('now')),
			UNIQUE(tg_chat_id, tg_message_id)
		);

		CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_queue(status, next_attempt_at);
		CREATE INDEX IF NOT EXISTS idx_outbound_client_context ON outbound_queue(client_context);
		CREATE INDEX IF NOT EXISTS idx_outbound_notice ON outbound_queue(failure_notice_tg_message_id);

		CREATE TABLE IF NOT EXISTS bridge_state (
			key        TEXT PRIMARY KEY,
			value      TEXT,
			updated_at DATETIME DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
	`);

	// Older databases predate these columns.
	addColumnIfMissing(db, 'thread_map', 'is_group', 'BOOLEAN DEFAULT 0');
	addColumnIfMissing(db, 'message_log', 'ig_item_id', 'TEXT');
	addColumnIfMissing(db, 'message_log', 'client_context', 'TEXT');

	db.exec(`CREATE INDEX IF NOT EXISTS idx_message_log_tg_message_id ON message_log(tg_message_id)`);

	// Migrate existing plaintext ig_message_ids to SHA-256 hashes
	const hashDone = db.prepare(`SELECT 1 FROM migrations WHERE name = 'hash_ig_message_ids'`).get();
	if (!hashDone) {
		const rows = db.prepare('SELECT id, ig_message_id FROM message_log').all() as Array<{id: number; ig_message_id: string}>;
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

// ─── Thread mappings ────────────────────────────────────

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

export function getAllActiveThreads(db: Database.Database): ThreadMapping[] {
	return db.prepare('SELECT * FROM thread_map WHERE is_active = 1 ORDER BY created_at DESC').all() as ThreadMapping[];
}

export function setThreadActive(db: Database.Database, igThreadId: string, active: boolean): void {
	db.prepare('UPDATE thread_map SET is_active = ? WHERE ig_thread_id = ?').run(active ? 1 : 0, igThreadId);
}

export function getAllThreads(db: Database.Database): ThreadMapping[] {
	return db.prepare('SELECT * FROM thread_map ORDER BY created_at DESC').all() as ThreadMapping[];
}

// ─── Message log ────────────────────────────────────────

export function messageExists(db: Database.Database, igMessageId: string): boolean {
	const row = db.prepare('SELECT 1 FROM message_log WHERE ig_message_id = ?').get(hashId(igMessageId));
	return row !== undefined;
}

export function logMessage(
	db: Database.Database,
	entry: Omit<MessageLogEntry, 'id' | 'timestamp' | 'ig_item_id' | 'client_context'> & {
		ig_item_id?: string | null;
		client_context?: string | null;
	},
): void {
	db.prepare(`
		INSERT INTO message_log (ig_message_id, tg_message_id, ig_thread_id, direction, content_type, ig_item_id, client_context)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		hashId(entry.ig_message_id),
		entry.tg_message_id,
		entry.ig_thread_id,
		entry.direction,
		entry.content_type,
		entry.ig_item_id === undefined ? entry.ig_message_id : entry.ig_item_id,
		entry.client_context ?? null,
	);
}

export function getMessageByIgId(db: Database.Database, igMessageId: string): MessageLogEntry | undefined {
	return db.prepare('SELECT * FROM message_log WHERE ig_message_id = ?').get(hashId(igMessageId)) as MessageLogEntry | undefined;
}

/**
 * Looks up a forwarded message by its Telegram message ID.
 * Used to turn a Telegram reply into a native Instagram reply.
 */
export function getMessageByTgId(db: Database.Database, tgMessageId: number): MessageLogEntry | undefined {
	return db
		.prepare('SELECT * FROM message_log WHERE tg_message_id = ? AND tg_message_id > 0 ORDER BY id DESC LIMIT 1')
		.get(tgMessageId) as MessageLogEntry | undefined;
}

export function getMessageCount(db: Database.Database): number {
	const row = db.prepare('SELECT COUNT(*) as count FROM message_log').get() as {count: number};
	return row.count;
}

/**
 * Check if we recently sent a message to a thread from TG (within the last `windowSeconds`).
 * Fallback echo prevention for payload types where the bridge cannot choose the
 * client_context (photo, video, voice) and Instagram's echo carries a different item ID.
 */
export function hasRecentBridgeSend(
	db: Database.Database,
	igThreadId: string,
	windowSeconds = 60,
): boolean {
	const row = db.prepare(
		`SELECT 1 FROM message_log
		 WHERE ig_thread_id = ? AND direction = 'tg_to_ig' AND timestamp > datetime('now', ?)
		 LIMIT 1`,
	).get(igThreadId, `-${Math.max(1, Math.round(windowSeconds))} seconds`);
	return row !== undefined;
}

// ─── Outbound queue ─────────────────────────────────────

export type NewOutboundRecord = {
	tg_chat_id: number;
	tg_topic_id: number;
	tg_message_id: number;
	ig_thread_id: string;
	content_type: string;
	payload_json: string;
	reply_to_ig_item_id: string | null;
	client_context: string;
};

/**
 * Inserts a pending outbound record. The `UNIQUE(tg_chat_id, tg_message_id)`
 * constraint makes this idempotent, so a duplicate Telegram update returns the
 * record that already exists instead of queueing the message twice.
 */
export function enqueueOutbound(
	db: Database.Database,
	record: NewOutboundRecord,
): {record: OutboundRecord; created: boolean} {
	const result = db.prepare(`
		INSERT INTO outbound_queue (
			tg_chat_id, tg_topic_id, tg_message_id, ig_thread_id, content_type,
			payload_json, reply_to_ig_item_id, client_context, status, next_attempt_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
		ON CONFLICT(tg_chat_id, tg_message_id) DO NOTHING
	`).run(
		record.tg_chat_id,
		record.tg_topic_id,
		record.tg_message_id,
		record.ig_thread_id,
		record.content_type,
		record.payload_json,
		record.reply_to_ig_item_id,
		record.client_context,
	);

	const stored = db
		.prepare('SELECT * FROM outbound_queue WHERE tg_chat_id = ? AND tg_message_id = ?')
		.get(record.tg_chat_id, record.tg_message_id) as OutboundRecord;

	return {record: stored, created: result.changes === 1};
}

export function getOutboundById(db: Database.Database, id: number): OutboundRecord | undefined {
	return db.prepare('SELECT * FROM outbound_queue WHERE id = ?').get(id) as OutboundRecord | undefined;
}

/**
 * Atomically moves a record from `pending` to `sending` and increments its
 * attempt count. Returns undefined when something else already claimed it,
 * which is what keeps two workers from sending the same message twice.
 */
export function claimOutbound(db: Database.Database, id: number): OutboundRecord | undefined {
	const result = db.prepare(`
		UPDATE outbound_queue
		SET status = 'sending', attempt_count = attempt_count + 1, updated_at = datetime('now')
		WHERE id = ? AND status = 'pending'
	`).run(id);

	if (result.changes !== 1) return undefined;
	return getOutboundById(db, id);
}

export function markOutboundSent(db: Database.Database, id: number, igMessageId: string): void {
	db.prepare(`
		UPDATE outbound_queue
		SET status = 'sent', ig_message_id = ?, last_error = NULL, next_attempt_at = NULL,
		    updated_at = datetime('now')
		WHERE id = ?
	`).run(igMessageId, id);
}

/**
 * Schedules a bounded retry: back to `pending`, eligible again after `delayMs`.
 */
export function scheduleOutboundRetry(
	db: Database.Database,
	id: number,
	errorLabel: string,
	delayMs: number,
): void {
	db.prepare(`
		UPDATE outbound_queue
		SET status = 'pending', last_error = ?, updated_at = datetime('now'),
		    next_attempt_at = datetime('now', ?)
		WHERE id = ?
	`).run(errorLabel, `+${Math.max(1, Math.round(delayMs / 1000))} seconds`, id);
}

export function markOutboundFailed(db: Database.Database, id: number, errorLabel: string): void {
	db.prepare(`
		UPDATE outbound_queue
		SET status = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = datetime('now')
		WHERE id = ?
	`).run(errorLabel, id);
}

export function setOutboundFailureNotice(db: Database.Database, id: number, tgMessageId: number): void {
	db.prepare(`UPDATE outbound_queue SET failure_notice_tg_message_id = ?, updated_at = datetime('now') WHERE id = ?`)
		.run(tgMessageId, id);
}

/**
 * Pending records whose retry time has come, oldest first.
 */
export function getDueOutbound(db: Database.Database, limit = 10): OutboundRecord[] {
	return db.prepare(`
		SELECT * FROM outbound_queue
		WHERE status = 'pending'
		  AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
		ORDER BY id ASC
		LIMIT ?
	`).all(limit) as OutboundRecord[];
}

/**
 * Recovers records left mid-flight by a crash or container restart. The stable
 * `client_context` is preserved, so Instagram discards the duplicate if the
 * original send actually landed.
 */
export function resetStuckSending(db: Database.Database): number {
	const result = db.prepare(`
		UPDATE outbound_queue
		SET status = 'pending', next_attempt_at = datetime('now'), updated_at = datetime('now')
		WHERE status = 'sending'
	`).run();
	return result.changes;
}

export function countOutboundByStatus(db: Database.Database): Record<OutboundStatus, number> {
	const rows = db
		.prepare('SELECT status, COUNT(*) as count FROM outbound_queue GROUP BY status')
		.all() as Array<{status: OutboundStatus; count: number}>;

	const counts: Record<OutboundStatus, number> = {pending: 0, sending: 0, sent: 0, failed: 0};
	for (const row of rows) counts[row.status] = row.count;
	return counts;
}

/**
 * Resolves a `/retry` target: the Telegram message the user replied to is
 * either the original outgoing message or the bridge's failure notice.
 */
export function getOutboundByTgMessageId(
	db: Database.Database,
	tgChatId: number,
	tgMessageId: number,
): OutboundRecord | undefined {
	return db.prepare(`
		SELECT * FROM outbound_queue
		WHERE tg_chat_id = ? AND (tg_message_id = ? OR failure_notice_tg_message_id = ?)
		ORDER BY id DESC LIMIT 1
	`).get(tgChatId, tgMessageId, tgMessageId) as OutboundRecord | undefined;
}

export function getFailedOutbound(db: Database.Database, limit = 10): OutboundRecord[] {
	return db
		.prepare(`SELECT * FROM outbound_queue WHERE status = 'failed' ORDER BY id DESC LIMIT ?`)
		.all(limit) as OutboundRecord[];
}

/**
 * Marks a failed record eligible again. Attempt count resets so the manual
 * retry gets a full budget of bounded automatic attempts.
 */
export function requeueOutbound(db: Database.Database, id: number): boolean {
	const result = db.prepare(`
		UPDATE outbound_queue
		SET status = 'pending', attempt_count = 0, last_error = NULL,
		    next_attempt_at = datetime('now'), updated_at = datetime('now')
		WHERE id = ? AND status IN ('failed', 'pending')
	`).run(id);
	return result.changes === 1;
}

/**
 * True when this Instagram item is the echo of something the bridge sent,
 * matched on the client_context the bridge chose itself. Unlike the time-window
 * fallback this is exact, which is what makes forwarding your own
 * app-sent messages safe.
 */
export function isOwnOutboundEcho(db: Database.Database, clientContext: string): boolean {
	const row = db
		.prepare(`SELECT 1 FROM outbound_queue WHERE client_context = ? AND status IN ('sending', 'sent') LIMIT 1`)
		.get(clientContext);
	return row !== undefined;
}

/**
 * Keeps the queue from growing without bound. Only `sent` records are removed;
 * failed records stay available for manual retry.
 */
export function pruneSentOutbound(db: Database.Database, retentionDays: number): number {
	const result = db.prepare(`
		DELETE FROM outbound_queue
		WHERE status = 'sent' AND updated_at < datetime('now', ?)
	`).run(`-${Math.max(1, Math.round(retentionDays))} days`);
	return result.changes;
}

// ─── Bridge state ───────────────────────────────────────

export function setState(db: Database.Database, key: string, value: string): void {
	db.prepare(`
		INSERT INTO bridge_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
	`).run(key, value);
}

export function getState(db: Database.Database, key: string): string | undefined {
	const row = db.prepare('SELECT value FROM bridge_state WHERE key = ?').get(key) as {value: string} | undefined;
	return row?.value;
}

// ─── Maintenance ────────────────────────────────────────

export function clearAllData(db: Database.Database): {threads: number; messages: number} {
	const threads = (db.prepare('SELECT COUNT(*) as count FROM thread_map').get() as {count: number}).count;
	const messages = (db.prepare('SELECT COUNT(*) as count FROM message_log').get() as {count: number}).count;
	db.prepare('DELETE FROM message_log').run();
	db.prepare('DELETE FROM outbound_queue').run();
	db.prepare('DELETE FROM thread_map').run();
	return {threads, messages};
}
