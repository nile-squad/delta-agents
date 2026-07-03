import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq, desc } from "drizzle-orm";
import type { Checkpoint } from "../../shared/types";
import { checkpoints } from "../../../db/models/schema";
import type { DB } from "./db";
import { toCheckpoint } from "./converters";

// ── Checkpoints ──────────────────────────────────────────────────────────

export const checkpointMethods = (db: DB) => ({
  saveCheckpoint: async (ckpt: Checkpoint): Promise<Result<Checkpoint, string>> => {
    try {
      await db.insert(checkpoints).values({
        id:        ckpt.id,
        taskId:    ckpt.taskId,
        phase:     ckpt.phase ?? null,
        state:     JSON.stringify(ckpt.state),
        createdAt: ckpt.createdAt.getTime(),
      });
      return Ok(ckpt);
    } catch (e) {
      return Err(`failed to save checkpoint "${ckpt.id}": ${String(e)}`);
    }
  },

  getLatestCheckpoint: async (taskId: string): Promise<Result<Checkpoint | null, string>> => {
    try {
      const rows = await db.select().from(checkpoints)
        .where(eq(checkpoints.taskId, taskId))
        .orderBy(desc(checkpoints.createdAt))
        .limit(1);
      const row = rows[0];
      return Ok(row ? toCheckpoint(row) : null);
    } catch (e) {
      return Err(`failed to get latest checkpoint for task "${taskId}": ${String(e)}`);
    }
  },
});
