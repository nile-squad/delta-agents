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
 */

import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, desc, lt, and, inArray, like } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { StoragePort } from "./storage-port";
import type {
  Task,
  TaskTree,
  Execution,
  Checkpoint,
  ApprovalRequest,
  EscalationRecord,
  EscalationTrigger,
  Message,
  Memory,
  Commit,
  CommitQuery,
  Queue,
  Cost,
  RiskState,
  TrustState,
  Json,
  JsonRecord,
  ExecutionStatus,
} from "../shared/types";
import {
  tasks,
  taskTrees,
  executions,
  checkpoints,
  approvalRequests,
  escalations,
  messages,
  memories,
  commits,
  queues,
} from "../../db/models/schema";
import { runMigrations } from "../../db/models/migrate";

// ── Row → domain type converters ──────────────────────────────────────────────

type DB = LibSQLDatabase<Record<string, never>>;

const toTask = (r: typeof tasks.$inferSelect): Task => ({
  id:            r.id,
  rootId:        r.rootId,
  parentId:      r.parentId ?? undefined,
  status:        r.status as ExecutionStatus,
  goal:          r.goal,
  assignedAgent: r.assignedAgent,
  workflow:      r.workflow ?? undefined,
  currentPhase:  r.currentPhase ?? undefined,
  budget:        JSON.parse(r.budget) as Cost,
  risk:          JSON.parse(r.risk) as RiskState,
  trust:         JSON.parse(r.trust) as TrustState,
  createdAt:     new Date(r.createdAt),
  updatedAt:     new Date(r.updatedAt),
});

const toTaskTree = (r: typeof taskTrees.$inferSelect): TaskTree => ({
  rootTaskId:     r.rootTaskId,
  activeChildren: JSON.parse(r.activeChildren) as string[],
  queuedChildren: JSON.parse(r.queuedChildren) as string[],
  maxConcurrency: 2,
});

const toExecution = (r: typeof executions.$inferSelect): Execution => ({
  id:        r.id,
  taskId:    r.taskId,
  action:    r.action,
  startedAt: new Date(r.startedAt),
  endedAt:   r.endedAt !== null && r.endedAt !== undefined ? new Date(r.endedAt) : undefined,
  status:    r.status as ExecutionStatus,
  cost:      JSON.parse(r.cost) as Cost,
});

const toCheckpoint = (r: typeof checkpoints.$inferSelect): Checkpoint => ({
  id:        r.id,
  taskId:    r.taskId,
  phase:     r.phase ?? undefined,
  state:     JSON.parse(r.state) as JsonRecord,
  createdAt: new Date(r.createdAt),
});

const toApprovalRequest = (r: typeof approvalRequests.$inferSelect): ApprovalRequest => ({
  id:        r.id,
  taskId:    r.taskId,
  action:    r.action,
  reason:    r.reason,
  status:    r.status as ApprovalRequest["status"],
  createdAt: new Date(r.createdAt),
});

const toEscalationRecord = (r: typeof escalations.$inferSelect): EscalationRecord => ({
  id:        r.id,
  taskId:    r.taskId,
  trigger:   r.trigger as EscalationTrigger,
  reason:    r.reason,
  createdAt: new Date(r.createdAt),
});

const toMessage = (r: typeof messages.$inferSelect): Message => ({
  id:        r.id,
  taskId:    r.taskId,
  sender:    r.sender,
  receiver:  r.receiver,
  payload:   JSON.parse(r.payload) as Json,
  createdAt: new Date(r.createdAt),
  consumed:  r.consumed === 1,
});

const toQueue = (r: typeof queues.$inferSelect): Queue => ({
  id:        r.id,
  taskId:    r.taskId,
  pending:   JSON.parse(r.pending) as string[],
  active:    JSON.parse(r.active) as string[],
  completed: JSON.parse(r.completed) as string[],
});

const toMemory = (r: typeof memories.$inferSelect): Memory => ({
  id:        r.id,
  taskId:    r.taskId,
  agentName: r.agentName,
  kind:      r.kind,
  content:   r.content,
  createdAt: new Date(r.createdAt),
});

const toCommit = (r: typeof commits.$inferSelect): Commit => ({
  id:           r.id,
  taskId:       r.taskId,
  agentName:    r.agentName,
  workflowName: r.workflowName,
  notes:        r.notes,
  checkpointId: r.checkpointId,
  createdAt:    new Date(r.createdAt),
});

// ── Store factory ─────────────────────────────────────────────────────────────

const buildStore = (db: DB): StoragePort => ({

  // ── Tasks ────────────────────────────────────────────────────────────────

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

  // ── Task Trees ───────────────────────────────────────────────────────────

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

  // ── Executions ───────────────────────────────────────────────────────────

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

  // ── Checkpoints ──────────────────────────────────────────────────────────

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

  // ── Approvals ────────────────────────────────────────────────────────────

  saveApprovalRequest: async (req: ApprovalRequest): Promise<Result<ApprovalRequest, string>> => {
    try {
      await db.insert(approvalRequests).values({
        id:        req.id,
        taskId:    req.taskId,
        action:    req.action,
        reason:    req.reason,
        status:    req.status,
        createdAt: req.createdAt.getTime(),
      });
      return Ok(req);
    } catch (e) {
      return Err(`failed to save approval request "${req.id}": ${String(e)}`);
    }
  },

  getApprovalRequest: async (id: string): Promise<Result<ApprovalRequest, string>> => {
    try {
      const rows = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
      const row = rows[0];
      if (!row) return Err(`approval request "${id}" not found`);
      return Ok(toApprovalRequest(row));
    } catch (e) {
      return Err(`failed to get approval request "${id}": ${String(e)}`);
    }
  },

  updateApprovalRequest: async (id: string, patch: Partial<ApprovalRequest>): Promise<Result<ApprovalRequest, string>> => {
    try {
      const vals: Record<string, unknown> = {};
      if (patch.status !== undefined) vals["status"] = patch.status;

      await db.update(approvalRequests).set(vals).where(eq(approvalRequests.id, id));

      const rows = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
      const row = rows[0];
      if (!row) return Err(`approval request "${id}" not found after update`);
      return Ok(toApprovalRequest(row));
    } catch (e) {
      return Err(`failed to update approval request "${id}": ${String(e)}`);
    }
  },

  getPendingApprovals: async (taskId: string): Promise<Result<ApprovalRequest[], string>> => {
    try {
      const rows = await db.select().from(approvalRequests)
        .where(eq(approvalRequests.taskId, taskId));
      return Ok(rows.filter((r) => r.status === "pending").map(toApprovalRequest));
    } catch (e) {
      return Err(`failed to get pending approvals for task "${taskId}": ${String(e)}`);
    }
  },

  getApprovalsByTask: async (taskId: string): Promise<Result<ApprovalRequest[], string>> => {
    try {
      const rows = await db.select().from(approvalRequests)
        .where(eq(approvalRequests.taskId, taskId));
      return Ok(rows.map(toApprovalRequest));
    } catch (e) {
      return Err(`failed to get approvals for task "${taskId}": ${String(e)}`);
    }
  },

  // ── Escalations ──────────────────────────────────────────────────────────

  saveEscalation: async (record: EscalationRecord): Promise<Result<EscalationRecord, string>> => {
    try {
      await db.insert(escalations).values({
        id:        record.id,
        taskId:    record.taskId,
        trigger:   record.trigger,
        reason:    record.reason,
        createdAt: record.createdAt.getTime(),
      });
      return Ok(record);
    } catch (e) {
      return Err(`failed to save escalation "${record.id}": ${String(e)}`);
    }
  },

  getEscalationsByTask: async (taskId: string): Promise<Result<EscalationRecord[], string>> => {
    try {
      const rows = await db.select().from(escalations).where(eq(escalations.taskId, taskId));
      return Ok(rows.map(toEscalationRecord));
    } catch (e) {
      return Err(`failed to get escalations for task "${taskId}": ${String(e)}`);
    }
  },

  // ── Messages ─────────────────────────────────────────────────────────────

  saveMessage: async (msg: Message): Promise<Result<Message, string>> => {
    try {
      await db.insert(messages).values({
        id:        msg.id,
        taskId:    msg.taskId,
        sender:    msg.sender,
        receiver:  msg.receiver,
        payload:   JSON.stringify(msg.payload),
        createdAt: msg.createdAt.getTime(),
        consumed:  msg.consumed ? 1 : 0,
      });
      return Ok(msg);
    } catch (e) {
      return Err(`failed to save message "${msg.id}": ${String(e)}`);
    }
  },

  getMessages: async (taskId: string): Promise<Result<Message[], string>> => {
    try {
      const rows = await db.select().from(messages).where(eq(messages.taskId, taskId));
      return Ok(rows.map(toMessage));
    } catch (e) {
      return Err(`failed to get messages for task "${taskId}": ${String(e)}`);
    }
  },

  getMessagesByReceiver: async (receiver: string): Promise<Result<Message[], string>> => {
    try {
      const rows = await db.select().from(messages).where(eq(messages.receiver, receiver));
      return Ok(rows.map(toMessage));
    } catch (e) {
      return Err(`failed to get messages for receiver "${receiver}": ${String(e)}`);
    }
  },

  markMessageConsumed: async (id: string): Promise<Result<void, string>> => {
    try {
      await db.update(messages).set({ consumed: 1 }).where(eq(messages.id, id));
      return Ok(undefined);
    } catch (e) {
      return Err(`failed to mark message "${id}" consumed: ${String(e)}`);
    }
  },

  // ── Memories ─────────────────────────────────────────────────────────────

  saveMemory: async (memory: Memory): Promise<Result<Memory, string>> => {
    try {
      await db.insert(memories).values({
        id:        memory.id,
        taskId:    memory.taskId,
        agentName: memory.agentName,
        kind:      memory.kind,
        content:   memory.content,
        createdAt: memory.createdAt.getTime(),
      });
      return Ok(memory);
    } catch (e) {
      return Err(`failed to save memory "${memory.id}": ${String(e)}`);
    }
  },

  getMemoriesByAgent: async (agentName: string, limit?: number): Promise<Result<Memory[], string>> => {
    try {
      const base = db.select().from(memories).where(eq(memories.agentName, agentName)).orderBy(desc(memories.createdAt));
      const rows = limit !== undefined ? await base.limit(limit) : await base;
      return Ok(rows.map(toMemory));
    } catch (e) {
      return Err(`failed to get memories for agent "${agentName}": ${String(e)}`);
    }
  },

  // ── Commits ──────────────────────────────────────────────────────────────

  saveCommit: async (commit: Commit): Promise<Result<Commit, string>> => {
    try {
      await db.insert(commits).values({
        id:           commit.id,
        taskId:       commit.taskId,
        agentName:    commit.agentName,
        workflowName: commit.workflowName,
        notes:        commit.notes,
        checkpointId: commit.checkpointId,
        createdAt:    commit.createdAt.getTime(),
      });
      return Ok(commit);
    } catch (e) {
      return Err(`failed to save commit "${commit.id}": ${String(e)}`);
    }
  },

  getCommitsByAgent: async (agentName: string, limit?: number): Promise<Result<Commit[], string>> => {
    try {
      const base = db.select().from(commits).where(eq(commits.agentName, agentName)).orderBy(desc(commits.createdAt));
      const rows = limit !== undefined ? await base.limit(limit) : await base;
      return Ok(rows.map(toCommit));
    } catch (e) {
      return Err(`failed to get commits for agent "${agentName}": ${String(e)}`);
    }
  },

  searchCommits: async (query: CommitQuery, currentAgent: string): Promise<Result<Commit[], string>> => {
    try {
      const conditions = [];
      if (query.allAgents !== true) conditions.push(eq(commits.agentName, currentAgent));
      if (query.workflowName !== undefined) conditions.push(eq(commits.workflowName, query.workflowName));
      if (query.query !== undefined) conditions.push(like(commits.notes, `%${query.query}%`));
      const base = db.select().from(commits);
      const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
      const rows = await filtered.orderBy(desc(commits.createdAt)).limit(query.limit ?? 20);
      return Ok(rows.map(toCommit));
    } catch (e) {
      return Err(`failed to search commits: ${String(e)}`);
    }
  },

  // ── Queues ───────────────────────────────────────────────────────────────

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

  deleteMessages: async (taskId: string, olderThan?: Date): Promise<Result<number, string>> => {
    try {
      // Only CONSUMED messages are pruned; unconsumed mentions may still need
      // delivery. `olderThan` further restricts to consumed messages created
      // before that date.
      const whereClause = olderThan !== undefined
        ? and(eq(messages.taskId, taskId), eq(messages.consumed, 1), lt(messages.createdAt, olderThan.getTime()))
        : and(eq(messages.taskId, taskId), eq(messages.consumed, 1));
      const result = await db.delete(messages).where(whereClause);
      return Ok(Number(result.rowsAffected));
    } catch (e) {
      return Err(`failed to delete messages for task "${taskId}": ${String(e)}`);
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
