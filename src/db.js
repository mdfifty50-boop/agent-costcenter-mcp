/**
 * SQLite database layer for agent-costcenter-mcp.
 * DB location: ~/.agent-costcenter-mcp/costs.db (overridable via COSTCENTER_DATA_DIR env var)
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let _db = null;

export function getDb() {
  if (_db) return _db;

  const DATA_DIR = process.env.COSTCENTER_DATA_DIR || join(homedir(), '.agent-costcenter-mcp');
  const DB_PATH = join(DATA_DIR, 'costs.db');

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS cost_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT    NOT NULL,
      department    TEXT    NOT NULL DEFAULT '',
      model         TEXT    NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      task_id       TEXT    NOT NULL DEFAULT '',
      timestamp     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budgets (
      agent_id           TEXT    PRIMARY KEY,
      monthly_limit_usd  REAL    NOT NULL DEFAULT 0,
      alert_threshold    REAL    NOT NULL DEFAULT 0.8,
      created_at         TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      agent_id         TEXT    PRIMARY KEY,
      team             TEXT    NOT NULL DEFAULT '',
      project          TEXT    NOT NULL DEFAULT '',
      default_model    TEXT    NOT NULL DEFAULT '',
      budget_cap_usd   REAL,
      registered_at    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT    NOT NULL,
      tool_name    TEXT    NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      cost_usd     REAL    NOT NULL DEFAULT 0,
      timestamp    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budget_alerts (
      agent_id      TEXT    PRIMARY KEY,
      threshold_usd REAL    NOT NULL,
      action        TEXT    NOT NULL DEFAULT 'warn'
    );

    CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_timestamp ON cost_entries(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id);
  `);

  return _db;
}

export function _resetDb() {
  const db = getDb();
  db.exec('DELETE FROM cost_entries; DELETE FROM budgets; DELETE FROM agents; DELETE FROM tool_calls; DELETE FROM budget_alerts;');
}

export function _closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
