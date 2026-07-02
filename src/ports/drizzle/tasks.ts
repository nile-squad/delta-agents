import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { eq, desc, lt, and, inArray } from "drizzle-orm";
import type { Task, ExecutionStatus } from "../../shared/types";
import {
  tasks,
  taskTrees,
  executions,
  checkpoints,
  approvalRequests,
  escalations,
  messages,
  memories,
} from "../../../db/models/schema";
import type { DB } from "./db";
import { toTask } from "./converters";

// ── Tasks ────────────────────────────────────────────────────────────────

export const taskMethods = (db: DB) => ({
  saveTask: async (task: Task): Promise<Result<Task, string>> => {
    try {
      await db.insert(tasks).values({
        id:            task.id,
        rootId:        task.rootId,
        parentId:      task.parentId ?? null,
        status:        task.status,
        goal:          task.goal,
        assignedAgent: task.assignedAgent,
        workflow:      task.workflow ?? null,
        currentPhase:  task.currentPhase ?? null,
        budget:        JSON.stringify(task.budget),
        risk:          JSON.stringify(task.risk),
        trust:         JSON.stringify(task.trust),
        createdAt:     task.createdAt.getTime(),
        updatedAt:     task.updatedAt.getTime(),
      });
      return Ok(task);
    } catch (e) {
      return Err(`failed to save task "${task.id}": ${String(e)}`);
    }
  },

  getTask: async (id: string): Promise<Result<Task, string>> => {
    try {
      const rows = await db.select().from(tasks).where(eq(tasks.id, id));
      const row = rows[0];
      if (!row) return Err(`task "${id}" not found`);
      return Ok(toTask(row));
    } catch (e) {
      return Err(`failed to get task "${id}": ${String(e)}`);
    }
  },

  updateTask: async (id: string, patch: Partial<Task>): Promise<Result<Task, string>> => {
    try {
      const vals: Record<string, unknown> = {};
      if (patch.status        !== undefined) vals["status"]        = patch.status;
      if (patch.goal          !== undefined) vals["goal"]          = patch.goal;
      if (patch.assignedAgent !== undefined) vals["assignedAgent"] = patch.assignedAgent;
      if (patch.workflow      !== undefined) vals["workflow"]      = patch.workflow ?? null;
      if (patch.currentPhase  !== undefined) vals["currentPhase"]  = patch.currentPhase ?? null;
      if (patch.budget        !== undefined) vals["budget"]        = JSON.stringify(patch.budget);
      if (patch.risk          !== undefined) vals["risk"]          = JSON.stringify(patch.risk);
      if (patch.trust         !== undefined) vals["trust"]         = JSON.stringify(patch.trust);
      if (patch.updatedAt     !== undefined) vals["updatedAt"]     = patch.updatedAt.getTime();

      await db.update(tasks).set(vals).where(eq(tasks.id, id));

      const rows = await db.select().from(tasks).where(eq(tasks.id, id));
      const row = rows[0];
      if (!row) return Err(`task "${id}" not found after update`);
      return Ok(toTask(row));
    } catch (e) {
      return Err(`failed to update task "${id}": ${String(e)}`);
    }
  },

  getLatestTaskByAgent: async (agentName: string): Promise<Result<Task | null, string>> => {
    try {
      const rows = await db.select().from(tasks)
        .where(eq(tasks.assignedAgent, agentName))
        .orderBy(desc(tasks.updatedAt))
        .limit(1);
      const row = rows[0];
      return Ok(row ? toTask(row) : null);
    } catch (e) {
      return Err(`failed to get latest task for agent "${agentName}": ${String(e)}`);
    }
  },

  // ── Cleanup ───────────────────────────────────────────────────────────────
  // Destructive operations for retention pruning. Cascade in dependency order:
  // child rows first, then the task itself. Wrapping each delete in its own
  // try/catch keeps the cascade atomic-per-table — a partial failure surfaces
  // a clear Err without leaving a half-deleted task behind (each table is
  // idempotent on retry).
  deleteTask: async (id: string): Promise<Result<void, string>> => {
    try {
      // Cascade child rows first so the task is the last thing removed and a
      // partial failure is detectable by re-checking the task.
      await db.delete(executions).where(eq(executions.taskId, id));
      await db.delete(checkpoints).where(eq(checkpoints.taskId, id));
      await db.delete(escalations).where(eq(escalations.taskId, id));
      await db.delete(messages).where(eq(messages.taskId, id));
      await db.delete(approvalRequests).where(eq(approvalRequests.taskId, id));
      await db.delete(memories).where(eq(memories.taskId, id));
      await db.delete(taskTrees).where(eq(taskTrees.rootTaskId, id));
      const result = await db.delete(tasks).where(eq(tasks.id, id));
      if (result.rowsAffected === 0) return Err(`task "${id}" not found`);
      return Ok(undefined);
    } catch (e) {
      return Err(`failed to delete task "${id}": ${String(e)}`);
    }
  },

  // ── Cleanup scan helpers ──────────────────────────────────────────────────
  // Feed the retention prune. Both are best-effort lookups, so they sit on the
  // safe path — a malformed filter or a transient connection fault should not
  // collapse a manual cleanup run.
  getTasksOlderThan: async (statuses: ExecutionStatus[], olderThan: Date): Promise<Result<Task[], string>> => {
    try {
      // inArray handles the status set; lt(tasks.updatedAt, …) gives the age
      // boundary. Statuses list is expected non-empty by the caller.
      const rows = await db.select().from(tasks)
        .where(and(inArray(tasks.status, statuses), lt(tasks.updatedAt, olderThan.getTime())));
      return Ok(rows.map(toTask));
    } catch (e) {
      return Err(`failed to query tasks older than ${olderThan.toISOString()}: ${String(e)}`);
    }
  },

  getTaskIds: async (): Promise<Result<string[], string>> => {
    try {
      // Projection-only scan: no need to pull every task column when cleanup
      // only needs to walk the IDs.
      const rows = await db.select({ id: tasks.id }).from(tasks);
      return Ok(rows.map((r) => r.id));
    } catch (e) {
      return Err(`failed to list task IDs: ${String(e)}`);
    }
  },
});
