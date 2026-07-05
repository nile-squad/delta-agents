/**
 * StoragePort — persistence boundary for all runtime state.
 *
 * The engine calls this interface exclusively. The implementation (in-memory for
 * tests, Drizzle+SQLite in production) is swapped without touching governance logic
 * (spec Decision: Stateless Governance Engine). All engine logic is pure against
 * this port; the adapter carries the I/O.
 *
 * Every operation returns a Result so callers in the governance layer handle
 * storage failures explicitly rather than letting exceptions bubble silently.
 */

import type { Result } from "slang-ts";
import type {
  Task,
  TaskTree,
  Execution,
  Checkpoint,
  ApprovalRequest,
  EscalationRecord,
  Message,
  Memory,
  Commit,
  CommitQuery,
  Queue,
  ExecutionStatus,
} from "../shared/types";

export type StoragePort = {
  /**
   * Optional readiness gate awaited once during engine construction. An adapter
   * that needs async warm-up before it can serve queries (open a connection,
   * run migrations, ping the database) implements this; the engine awaits it in
   * `createDeltaEngine` and refuses to construct if it returns Err. Adapters that
   * are ready the moment they are created (the in-memory store) omit it.
   */
  ready?: () => Promise<Result<void, string>>;

  // Tasks
  saveTask: (task: Task) => Promise<Result<Task, string>>;
  getTask: (id: string) => Promise<Result<Task, string>>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<Result<Task, string>>;
  /**
   * Compare-and-swap status transition: set the task's status to `to` only if
   * its current status is one of `from`; Err (naming the actual current status)
   * otherwise. The check and the write are atomic at the adapter level, so two
   * concurrent callers racing the same transition (e.g. two resume() calls on
   * one paused task) cannot both win — exactly one proceeds, the other gets Err.
   */
  transitionTaskStatus: (id: string, from: Task["status"][], to: Task["status"]) => Promise<Result<Task, string>>;
  /**
   * Return the most recently updated task for a given agent, or null if none exists.
   * Used for invariants 25 (always retrievable) and 26 (no duplicate task creation).
   */
  getLatestTaskByAgent: (agentName: string) => Promise<Result<Task | null, string>>;
  /**
   * Return all active (pending/running) tasks assigned to an agent, across trees.
   * Used by the team roster to report per-agent load (major task + active
   * subtasks). Optional — adapters that don't implement it degrade the roster to
   * "latest task only" (subtask count reads as a floor of 0), never an error.
   */
  getActiveTasksByAgent?: (agentName: string) => Promise<Result<Task[], string>>;
  /**
   * Return all tasks for a given agent, newest-first by updatedAt.
   * Used by the stats read-models (topAgents, agentStats) to compute
   * success rates, averages, and trust trajectories. Optional — adapters
   * that don't implement it cause stats queries to return Err.
   */
  getTasksByAgent?: (agentName: string, opts?: { statuses?: ExecutionStatus[]; limit?: number }) => Promise<Result<Task[], string>>;
  /**
   * Return all tasks for a given workflow, newest-first by updatedAt.
   * Used by the stats read-models (workflowStats) to compute workflow-level
   * success rates, costs, and phase durations. Optional — adapters that don't
   * implement it cause stats queries to return Err.
   */
  getTasksByWorkflow?: (workflowName: string, opts?: { statuses?: ExecutionStatus[]; limit?: number }) => Promise<Result<Task[], string>>;
  /**
   * Return all checkpoints for a given task, oldest-first by createdAt.
   * Used by the stats read-models (workflowStats) to derive phase durations
   * within a workflow run. Optional — adapters that don't implement it cause
   * stats queries to return Err.
   */
  getCheckpointsByTask?: (taskId: string) => Promise<Result<Checkpoint[], string>>;

  // Task trees — one per root task
  saveTaskTree: (tree: TaskTree) => Promise<Result<TaskTree, string>>;
  getTaskTree: (rootTaskId: string) => Promise<Result<TaskTree, string>>;
  updateTaskTree: (rootTaskId: string, patch: Partial<TaskTree>) => Promise<Result<TaskTree, string>>;

  // Executions
  saveExecution: (execution: Execution) => Promise<Result<Execution, string>>;
  getExecution: (id: string) => Promise<Result<Execution, string>>;
  updateExecution: (id: string, patch: Partial<Execution>) => Promise<Result<Execution, string>>;
  getExecutionsByTask: (taskId: string) => Promise<Result<Execution[], string>>;

  // Checkpoints — newest-first semantics; getLatestCheckpoint returns the most recent
  saveCheckpoint: (checkpoint: Checkpoint) => Promise<Result<Checkpoint, string>>;
  getLatestCheckpoint: (taskId: string) => Promise<Result<Checkpoint | null, string>>;

  // Approvals
  saveApprovalRequest: (req: ApprovalRequest) => Promise<Result<ApprovalRequest, string>>;
  getApprovalRequest: (id: string) => Promise<Result<ApprovalRequest, string>>;
  updateApprovalRequest: (id: string, patch: Partial<ApprovalRequest>) => Promise<Result<ApprovalRequest, string>>;
  getPendingApprovals: (taskId: string) => Promise<Result<ApprovalRequest[], string>>;
  /** Returns all approval requests for a task regardless of status (pending/approved/rejected). */
  getApprovalsByTask: (taskId: string) => Promise<Result<ApprovalRequest[], string>>;

  // Escalations — every escalation is TaskID-attributable and auditable (invariant 13)
  saveEscalation: (record: EscalationRecord) => Promise<Result<EscalationRecord, string>>;
  getEscalationsByTask: (taskId: string) => Promise<Result<EscalationRecord[], string>>;

  // Messages — all attributable to a TaskID (invariant 9)
  saveMessage: (message: Message) => Promise<Result<Message, string>>;
  getMessages: (taskId: string) => Promise<Result<Message[], string>>;
  /** All messages addressed to an agent (the `receiver`), across tasks. Used to
   *  deliver mentions to a teammate regardless of which task they were sent from,
   *  and to build the agent's inbox view. */
  getMessagesByReceiver: (receiver: string) => Promise<Result<Message[], string>>;
  /** All messages sent by an agent (the `sender`), across tasks. Backs the
   *  agent's outbox view (with read receipts). Optional — adapters that don't
   *  implement it disable the outbox (engine returns a clear Err). */
  getMessagesBySender?: (sender: string) => Promise<Result<Message[], string>>;
  /** Mark a message delivered so a mention is folded into its receiver's context
   *  exactly once (idempotent across the recipient's tasks and across restarts). */
  markMessageConsumed: (id: string) => Promise<Result<void, string>>;
  /**
   * Mark a message read at `at`: stamps `readAt` (the receipt, seen by both
   * sides), sets `deliveredAt` if unset, and keeps `consumed` true for
   * backward-compatible mention dedup. Idempotent. Optional — when absent the
   * engine falls back to `markMessageConsumed` (receipts then unavailable).
   */
  markMessageRead?: (id: string, at: Date) => Promise<Result<void, string>>;
  /**
   * Recall (unsend) a message: allowed only while it is unread (`readAt` unset).
   * Stamps `recalledAt` and returns the updated message. Returns Err if the
   * message is missing, already read, or already recalled. Optional — adapters
   * that don't implement it disable unsend.
   */
  recallMessage?: (id: string) => Promise<Result<Message, string>>;
  /**
   * Enforce a per-receiver inbox size cap by evicting the oldest READ,
   * non-recalled messages until at most `cap` non-recalled messages remain.
   * Unread messages are never evicted. Returns the count removed. Optional —
   * absent means no size-cap eviction.
   */
  evictReadMessages?: (receiver: string, cap: number) => Promise<Result<number, string>>;

  // Memories — retrieved on demand, not carried (spec principle 4). Each write is
  // TaskID-attributable (invariant 8); retrieval scopes by owning agent.
  saveMemory: (memory: Memory) => Promise<Result<Memory, string>>;
  /** Most-recent-first memories for an agent, optionally capped to `limit`. */
  getMemoriesByAgent: (agentName: string, limit?: number) => Promise<Result<Memory[], string>>;

  // Commits — agent-driven checkpoint annotations
  saveCommit: (commit: Commit) => Promise<Result<Commit, string>>;
  getCommitsByAgent: (agentName: string, limit?: number) => Promise<Result<Commit[], string>>;
  searchCommits: (query: CommitQuery, currentAgent: string) => Promise<Result<Commit[], string>>;

  // Queues
  saveQueue: (queue: Queue) => Promise<Result<Queue, string>>;
  getQueue: (id: string) => Promise<Result<Queue, string>>;
  updateQueue: (id: string, patch: Partial<Queue>) => Promise<Result<Queue, string>>;

  // Cleanup (optional) — adapters that support destructive cleanup implement
  // these. The cleanup feature (engine.cleanup) checks for presence before
  // calling. Marked optional so existing adapters keep compiling.
  /** Delete a task permanently along with its checkpoints, messages, executions, and escalations. */
  deleteTask?: (id: string) => Promise<Result<void, string>>;
  /**
   * Delete consumed messages for a task, optionally restricted to those older
   * than a given date. Returns the count removed. Unconsumed messages are
   * preserved — they may still need delivery.
   */
  deleteMessages?: (taskId: string, olderThan?: Date) => Promise<Result<number, string>>;
  /**
   * Return tasks matching any of the given statuses, with `updatedAt` strictly
   * older than `olderThan`. Used by `delta.cleanup()` to find completed/failed
   * tasks past the retention window. Optional — adapters that support cleanup
   * implement it; otherwise task pruning is skipped.
   */
  getTasksOlderThan?: (statuses: ExecutionStatus[], olderThan: Date) => Promise<Result<Task[], string>>;
  /**
   * Return all task IDs in the store. Optional — used by `delta.cleanup()` to
   * walk every task for message pruning. Adapters that support message
   * retention implement it; otherwise message pruning is skipped.
   */
  getTaskIds?: () => Promise<Result<string[], string>>;
};
