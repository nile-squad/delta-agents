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
  Queue,
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
   * Return the most recently updated task for a given agent, or null if none exists.
   * Used for invariants 25 (always retrievable) and 26 (no duplicate task creation).
   */
  getLatestTaskByAgent: (agentName: string) => Promise<Result<Task | null, string>>;

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

  // Memories — retrieved on demand, not carried (spec principle 4). Each write is
  // TaskID-attributable (invariant 8); retrieval scopes by owning agent.
  saveMemory: (memory: Memory) => Promise<Result<Memory, string>>;
  /** Most-recent-first memories for an agent, optionally capped to `limit`. */
  getMemoriesByAgent: (agentName: string, limit?: number) => Promise<Result<Memory[], string>>;

  // Queues
  saveQueue: (queue: Queue) => Promise<Result<Queue, string>>;
  getQueue: (id: string) => Promise<Result<Queue, string>>;
  updateQueue: (id: string, patch: Partial<Queue>) => Promise<Result<Queue, string>>;
};
