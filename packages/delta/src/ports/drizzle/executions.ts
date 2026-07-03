import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq } from "drizzle-orm";
import type { Execution } from "../../shared/types";
import { executions } from "../../../db/models/schema";
import type { DB } from "./db";
import { toExecution } from "./converters";

// ── Executions ───────────────────────────────────────────────────────────

export const executionMethods = (db: DB) => ({
  saveExecution: async (exec: Execution): Promise<Result<Execution, string>> => {
    try {
      await db.insert(executions).values({
        id:        exec.id,
        taskId:    exec.taskId,
        action:    exec.action,
        startedAt: exec.startedAt.getTime(),
        endedAt:   exec.endedAt?.getTime() ?? null,
        status:    exec.status,
        cost:      JSON.stringify(exec.cost),
      });
      return Ok(exec);
    } catch (e) {
      return Err(`failed to save execution "${exec.id}": ${String(e)}`);
    }
  },

  getExecution: async (id: string): Promise<Result<Execution, string>> => {
    try {
      const rows = await db.select().from(executions).where(eq(executions.id, id));
      const row = rows[0];
      if (!row) return Err(`execution "${id}" not found`);
      return Ok(toExecution(row));
    } catch (e) {
      return Err(`failed to get execution "${id}": ${String(e)}`);
    }
  },

  updateExecution: async (id: string, patch: Partial<Execution>): Promise<Result<Execution, string>> => {
    try {
      const vals: Record<string, unknown> = {};
      if (patch.status   !== undefined) vals["status"]   = patch.status;
      if (patch.endedAt  !== undefined) vals["endedAt"]  = patch.endedAt?.getTime() ?? null;
      if (patch.cost     !== undefined) vals["cost"]     = JSON.stringify(patch.cost);

      await db.update(executions).set(vals).where(eq(executions.id, id));

      const rows = await db.select().from(executions).where(eq(executions.id, id));
      const row = rows[0];
      if (!row) return Err(`execution "${id}" not found after update`);
      return Ok(toExecution(row));
    } catch (e) {
      return Err(`failed to update execution "${id}": ${String(e)}`);
    }
  },

  getExecutionsByTask: async (taskId: string): Promise<Result<Execution[], string>> => {
    try {
      const rows = await db.select().from(executions).where(eq(executions.taskId, taskId));
      return Ok(rows.map(toExecution));
    } catch (e) {
      return Err(`failed to get executions for task "${taskId}": ${String(e)}`);
    }
  },
});
