/**
 * createDrizzleStore — libsql-backed implementation of StoragePort.
 *
 * Implements every StoragePort method against a libsql database via Drizzle
 * ORM. All complex object fields (Cost, RiskState, TrustState, JsonRecord)
 * are stored as JSON text; timestamps are stored as INTEGER millisecond
 * epochs. Serialization and deserialization happen explicitly in this file —
 * no Drizzle column modes are used so the mapping is always obvious.
 *
 * Usage:
 *   const store = await createDrizzleStore();           // in-memory
 *   const store = await createDrizzleStore("file:./delta.db");  // persistent
 *
 * The factory is async because DDL must run before the first ORM query.
 *
 * Method implementations are grouped by entity under `./drizzle/` (tasks,
 * task-trees, executions, checkpoints, approvals, escalations, messages,
 * queues, memories, commits) to keep each file under the project's LOC
 * limit. This file just wires the shared `DB` connection into every group
 * and assembles the final `StoragePort`.
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { StoragePort } from "./storage-port";
import { runMigrations } from "../../db/models/migrate";
import type { DB } from "./drizzle/db";
import { taskMethods } from "./drizzle/tasks";
import { taskTreeMethods } from "./drizzle/task-trees";
import { executionMethods } from "./drizzle/executions";
import { checkpointMethods } from "./drizzle/checkpoints";
import { approvalMethods } from "./drizzle/approvals";
import { escalationMethods } from "./drizzle/escalations";
import { messageMethods } from "./drizzle/messages";
import { queueMethods } from "./drizzle/queues";
import { memoryMethods } from "./drizzle/memories";
import { commitMethods } from "./drizzle/commits";

// ── Store factory ─────────────────────────────────────────────────────────────

const buildStore = (db: DB): StoragePort => ({
  ...taskMethods(db),
  ...taskTreeMethods(db),
  ...executionMethods(db),
  ...checkpointMethods(db),
  ...approvalMethods(db),
  ...escalationMethods(db),
  ...messageMethods(db),
  ...queueMethods(db),
  ...memoryMethods(db),
  ...commitMethods(db),
});

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Create a libsql-backed StoragePort.
 *
 * @param url - libsql database URL. Defaults to ":memory:" for an isolated
 *   in-memory database. Pass a file URL ("file:./delta.db") for persistence.
 *
 * The factory is async because schema initialization (CREATE TABLE IF NOT
 * EXISTS) must complete before any ORM query can run safely.
 */
export const createDrizzleStore = async (url = ":memory:"): Promise<StoragePort> => {
  const client = createClient({ url });
  await runMigrations(client);
  const db = drizzle(client) as DB;
  return buildStore(db);
};
