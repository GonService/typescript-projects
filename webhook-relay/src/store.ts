import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface Delivery {
  id: number;
  source: string;
  eventId: string;
  target: string;
  payload: string;
  contentType: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  source: string;
  event_id: string;
  target: string;
  payload: string;
  content_type: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const toDelivery = (r: Row): Delivery => ({
  id: r.id,
  source: r.source,
  eventId: r.event_id,
  target: r.target,
  payload: r.payload,
  contentType: r.content_type,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Durable queue of deliveries in SQLite (WAL mode). Survives restarts; one row per event. */
export class Store {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        content_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (source, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries (status, next_attempt_at);
    `);
  }

  /** Inserts a delivery. Returns false when the same event was already received (idempotency). */
  enqueue(d: { source: string; eventId: string; target: string; payload: string; contentType: string }, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (source, event_id, target, payload, content_type, next_attempt_at, created_at, updated_at)
         VALUES (@source, @eventId, @target, @payload, @contentType, @now, @now, @now)`,
      )
      .run({ ...d, now });
    return result.changes === 1;
  }

  due(now = Date.now(), limit = 20): Delivery[] {
    const rows = this.db
      .prepare(`SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`)
      .all(now, limit) as Row[];
    return rows.map(toDelivery);
  }

  markDelivered(id: number, now = Date.now()): void {
    this.db
      .prepare(`UPDATE deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(now, id);
  }

  markFailedAttempt(id: number, error: string, nextAttemptAt: number | null, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE deliveries
           SET attempts = attempts + 1, last_error = ?, updated_at = ?,
               status = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END,
               next_attempt_at = COALESCE(?, next_attempt_at)
         WHERE id = ?`,
      )
      .run(error.slice(0, 500), now, nextAttemptAt, nextAttemptAt, id);
  }

  /** Puts a failed delivery back in the queue (manual replay). */
  retry(id: number, now = Date.now()): boolean {
    const result = this.db
      .prepare(`UPDATE deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'failed'`)
      .run(now, now, id);
    return result.changes === 1;
  }

  get(id: number): Delivery | undefined {
    const row = this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id) as Row | undefined;
    return row ? toDelivery(row) : undefined;
  }

  list(status?: DeliveryStatus, limit = 50): Delivery[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM deliveries WHERE status = ? ORDER BY id DESC LIMIT ?`).all(status, limit)
        : this.db.prepare(`SELECT * FROM deliveries ORDER BY id DESC LIMIT ?`).all(limit)
    ) as Row[];
    return rows.map(toDelivery);
  }

  counts(): Record<DeliveryStatus, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status`).all() as { status: DeliveryStatus; n: number }[];
    const out: Record<DeliveryStatus, number> = { pending: 0, delivered: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  close(): void {
    this.db.close();
  }
}
