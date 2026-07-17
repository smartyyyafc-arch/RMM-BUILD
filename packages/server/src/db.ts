import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Opens (and migrates) the SQLite database.
 *
 * Uses the built-in `node:sqlite` module so the server has no native
 * dependencies to compile. WAL mode keeps reads and writes from blocking
 * each other under concurrent agent heartbeats.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id                TEXT PRIMARY KEY,
      machine_id        TEXT UNIQUE,
      agent_token_hash  TEXT NOT NULL,
      info_json         TEXT NOT NULL,
      enrolled_at       INTEGER NOT NULL,
      last_seen_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      timestamp   INTEGER NOT NULL,
      sample_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_device_ts
      ON metrics(device_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      type            TEXT NOT NULL,
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      dispatched_at   INTEGER,
      finished_at     INTEGER,
      result_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_device_status
      ON jobs(device_id, status);

    CREATE TABLE IF NOT EXISTS alert_rules (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      metric     TEXT NOT NULL,
      comparator TEXT NOT NULL,
      threshold  REAL NOT NULL,
      severity   TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      device_id  TEXT REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id              TEXT PRIMARY KEY,
      rule_id         TEXT,
      device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      severity        TEXT NOT NULL,
      message         TEXT NOT NULL,
      value           REAL,
      created_at      INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_device
      ON alerts(device_id, created_at DESC);
  `);
}

/** Deletes metric rows older than the retention window. Returns rows removed. */
export function pruneMetrics(db: DatabaseSync, retentionMs: number, now: number): number {
  const cutoff = now - retentionMs;
  const result = db.prepare("DELETE FROM metrics WHERE timestamp < ?").run(cutoff);
  return Number(result.changes);
}
