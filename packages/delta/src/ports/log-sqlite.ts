/**
 * SQLite log drain — queryable log store, separate from the task store.
 *
 * Kept in `src/ports` so the engine can swap it out (file/sqlite/custom) without
 * touching the logger engine. The schema is intentionally minimal: one row per
 * entry, context as a JSON string. No indices — a log sink is write-heavy and
 * the engine never queries it during a run; analytics tools can add indices
 * later if they need them.
 *
 * The drain swallows every error. A log sink that throws is worse than a
 * missing entry: it can destabilize the very system it's auditing. Init and
 * insert are async but fire-and-forget from the caller's perspective; the
 * returned `drain` function is sync and never throws.
 */

import { createClient } from "@libsql/client";
import type { LogEntry } from "../shared/logger-types";

/** A sync function that takes a log entry and persists it. Never throws. */
export type SqliteLogDrain = (entry: LogEntry) => void;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    module TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT
  )
`;

const INSERT_SQL =
  "INSERT INTO logs (timestamp, level, module, message, context) VALUES (?, ?, ?, ?, ?)";

/**
 * Create a sqlite-backed log drain.
 *
 * @param path - filesystem path for the sqlite database file. The file is
 *   created on first insert if it does not exist; the parent directory must
 *   already exist.
 *
 * Returns the drain and a `close` function the caller can invoke to release
 * the libsql client. The engine does not currently expose `close` through the
 * public logger API; the file is released on process exit.
 */
export const createSqliteLogDrain = (
  path: string,
): { drain: SqliteLogDrain; close: () => void } => {
  const client = createClient({ url: `file:${path}` });

  // Lazy schema migration. The first drain call awaits this promise before
  // inserting, so the table is guaranteed to exist by the time rows land. We
  // keep the promise so concurrent first-callers don't issue duplicate
  // CREATE TABLE statements.
  let initPromise: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    if (initPromise === null) {
      initPromise = client
        .execute(SCHEMA_SQL)
        .then(() => undefined)
        .catch(() => {
          // Reset so a later caller can retry the migration rather than
          // silently dropping every entry forever.
          initPromise = null;
        });
    }
    return initPromise;
  };

  const drain: SqliteLogDrain = (entry) => {
    // Fire-and-forget: the caller's hot path must not wait on sqlite I/O.
    // Errors are swallowed so a transient db fault never bubbles into the
    // engine. A failed migration is retried on the next entry.
    ensureSchema()
      .then(() => {
        const contextJson = entry.context !== undefined ? JSON.stringify(entry.context) : null;
        return client.execute({
          sql: INSERT_SQL,
          args: [entry.timestamp, entry.level, entry.module, entry.message, contextJson],
        });
      })
      .catch(() => undefined);
  };

  const close = (): void => {
    client.close();
  };

  return { drain, close };
};
