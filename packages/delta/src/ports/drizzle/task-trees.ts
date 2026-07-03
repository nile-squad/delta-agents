import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq } from "drizzle-orm";
import type { TaskTree } from "../../shared/types";
import { taskTrees } from "../../../db/models/schema";
import type { DB } from "./db";
import { toTaskTree } from "./converters";

// ── Task Trees ───────────────────────────────────────────────────────────

export const taskTreeMethods = (db: DB) => ({
  saveTaskTree: async (tree: TaskTree): Promise<Result<TaskTree, string>> => {
    try {
      await db.insert(taskTrees).values({
        rootTaskId:     tree.rootTaskId,
        activeChildren: JSON.stringify(tree.activeChildren),
        queuedChildren: JSON.stringify(tree.queuedChildren),
        maxConcurrency: tree.maxConcurrency,
      });
      return Ok(tree);
    } catch (e) {
      return Err(`failed to save task tree for root "${tree.rootTaskId}": ${String(e)}`);
    }
  },

  getTaskTree: async (rootTaskId: string): Promise<Result<TaskTree, string>> => {
    try {
      const rows = await db.select().from(taskTrees).where(eq(taskTrees.rootTaskId, rootTaskId));
      const row = rows[0];
      if (!row) return Err(`task tree for root "${rootTaskId}" not found`);
      return Ok(toTaskTree(row));
    } catch (e) {
      return Err(`failed to get task tree for root "${rootTaskId}": ${String(e)}`);
    }
  },

  updateTaskTree: async (rootTaskId: string, patch: Partial<TaskTree>): Promise<Result<TaskTree, string>> => {
    try {
      const vals: Record<string, unknown> = {};
      if (patch.activeChildren !== undefined) vals["activeChildren"] = JSON.stringify(patch.activeChildren);
      if (patch.queuedChildren !== undefined) vals["queuedChildren"] = JSON.stringify(patch.queuedChildren);

      await db.update(taskTrees).set(vals).where(eq(taskTrees.rootTaskId, rootTaskId));

      const rows = await db.select().from(taskTrees).where(eq(taskTrees.rootTaskId, rootTaskId));
      const row = rows[0];
      if (!row) return Err(`task tree for root "${rootTaskId}" not found after update`);
      return Ok(toTaskTree(row));
    } catch (e) {
      return Err(`failed to update task tree for root "${rootTaskId}": ${String(e)}`);
    }
  },
});
