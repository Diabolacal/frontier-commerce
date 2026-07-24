/**
 * SQLite ledger schema (node:sqlite - zero native dependencies).
 *
 * `raw_events` is the append-only source of truth keyed by (tx_digest,
 * event_seq) so re-polling is idempotent; the typed tables are derived rows
 * for reporting. Everything can be rebuilt from chain at any time - the
 * database is a cache, never the authority.
 */
import { DatabaseSync } from 'node:sqlite';

export interface LedgerDb {
  db: DatabaseSync;
  insertRawEvent(e: RawEventRow): boolean;
  getCursor(key: string): string | null;
  setCursor(key: string, value: string): void;
  close(): void;
}

export interface RawEventRow {
  txDigest: string;
  eventSeq: number;
  eventType: string;
  eventName: string;
  merchantId: string | null;
  timestampMs: number | null;
  json: string;
}

export function openLedger(path: string): LedgerDb {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS raw_events (
      tx_digest TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_name TEXT NOT NULL,
      merchant_id TEXT,
      timestamp_ms INTEGER,
      json TEXT NOT NULL,
      PRIMARY KEY (tx_digest, event_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_raw_events_name ON raw_events(event_name);
    CREATE INDEX IF NOT EXISTS idx_raw_events_merchant ON raw_events(merchant_id);
    CREATE TABLE IF NOT EXISTS cursors (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO raw_events
     (tx_digest, event_seq, event_type, event_name, merchant_id, timestamp_ms, json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const getCursorStmt = db.prepare(`SELECT value FROM cursors WHERE key = ?`);
  const setCursorStmt = db.prepare(
    `INSERT INTO cursors (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  return {
    db,
    insertRawEvent(e: RawEventRow): boolean {
      const res = insertStmt.run(
        e.txDigest,
        e.eventSeq,
        e.eventType,
        e.eventName,
        e.merchantId,
        e.timestampMs,
        e.json,
      );
      return res.changes > 0;
    },
    getCursor(key: string): string | null {
      const row = getCursorStmt.get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setCursor(key: string, value: string): void {
      setCursorStmt.run(key, value);
    },
    close(): void {
      db.close();
    },
  };
}
