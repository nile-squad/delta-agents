/**
 * Schema initialization — CREATE TABLE IF NOT EXISTS DDL for all tables.
 *
 * Runs against a libsql Client via executeMultiple so the engine can open
 * (or create) a database and immediately start issuing ORM queries without
 * a separate migration step. Safe to run on every startup; IF NOT EXISTS
 * makes it idempotent.
 *
 * The column layout here must exactly match the Drizzle schema in schema.ts
 * so ORM queries produce correct SQL.
 */

import type { Client } from "@libsql/client";

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT    PRIMARY KEY,
  root_id        TEXT    NOT NULL,
  parent_id      TEXT,
  status         TEXT    NOT NULL,
  goal           TEXT    NOT NULL,
  assigned_agent TEXT    NOT NULL,
  workflow       TEXT,
  current_phase  TEXT,
  budget         TEXT    NOT NULL,
  risk           TEXT    NOT NULL,
  trust          TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_trees (
  root_task_id     TEXT    PRIMARY KEY,
  active_children  TEXT    NOT NULL,
  queued_children  TEXT    NOT NULL,
  max_concurrency  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  action     TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  status     TEXT    NOT NULL,
  cost       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  phase      TEXT,
  state      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id               TEXT    PRIMARY KEY,
  task_id          TEXT    NOT NULL,
  action           TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  rejection_reason TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  trigger    TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT    PRIMARY KEY,
  task_id      TEXT    NOT NULL,
  sender       TEXT    NOT NULL,
  receiver     TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  read_at      INTEGER,
  recalled_at  INTEGER
);

CREATE TABLE IF NOT EXISTS queues (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  pending    TEXT    NOT NULL,
  active     TEXT    NOT NULL,
  completed  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  agent_name TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
  id            TEXT    PRIMARY KEY,
  task_id       TEXT    NOT NULL,
  agent_name    TEXT    NOT NULL,
  workflow_name TEXT,
  notes         TEXT,
  checkpoint_id TEXT,
  created_at    INTEGER NOT NULL
);
`;

/** Additive column migrations for databases created before the column existed.
 * CREATE TABLE IF NOT EXISTS never alters an existing table, so each new column
 * needs a best-effort ALTER: it fails harmlessly with "duplicate column name"
 * once applied, keeping startup idempotent. */
const COLUMN_MIGRATIONS = [
  `ALTER TABLE approval_requests ADD COLUMN rejection_reason TEXT`,
];

export const runMigrations = async (client: Client): Promise<void> => {
  await client.executeMultiple(DDL);
  for (const migration of COLUMN_MIGRATIONS) {
    try {
      await client.execute(migration);
    } catch {
      // Column already exists — expected on every startup after the first.
    }
  }
};
