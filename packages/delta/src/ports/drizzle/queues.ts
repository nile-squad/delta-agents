import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq } from "drizzle-orm";
import type { Queue } from "../../shared/types";
import { queues } from "../../../db/models/schema";
import type { DB } from "./db";
import { toQueue } from "./converters";

// ── Queues ───────────────────────────────────────────────────────────────

export const queueMethods = (db: DB) => ({
  saveQueue: async (queue: Queue): Promise<Result<Queue, string>> => {
    try {
      await db.insert(queues).values({
        id:        queue.id,
        taskId:    queue.taskId,
        pending:   JSON.stringify(queue.pending),
        active:    JSON.stringify(queue.active),
        completed: JSON.stringify(queue.completed),
      });
      return Ok(queue);
    } catch (e) {
      return Err(`failed to save queue "${queue.id}": ${String(e)}`);
    }
  },

  getQueue: async (id: string): Promise<Result<Queue, string>> => {
    try {
      const rows = await db.select().from(queues).where(eq(queues.id, id));
      const row = rows[0];
      if (!row) return Err(`queue "${id}" not found`);
      return Ok(toQueue(row));
    } catch (e) {
      return Err(`failed to get queue "${id}": ${String(e)}`);
    }
  },

  updateQueue: async (id: string, patch: Partial<Queue>): Promise<Result<Queue, string>> => {
    try {
      const vals: Record<string, unknown> = {};
      if (patch.pending   !== undefined) vals["pending"]   = JSON.stringify(patch.pending);
      if (patch.active    !== undefined) vals["active"]    = JSON.stringify(patch.active);
      if (patch.completed !== undefined) vals["completed"] = JSON.stringify(patch.completed);

      await db.update(queues).set(vals).where(eq(queues.id, id));

      const rows = await db.select().from(queues).where(eq(queues.id, id));
      const row = rows[0];
      if (!row) return Err(`queue "${id}" not found after update`);
      return Ok(toQueue(row));
    } catch (e) {
      return Err(`failed to update queue "${id}": ${String(e)}`);
    }
  },
});
