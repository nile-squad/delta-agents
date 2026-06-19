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
  Message,
  Queue,
} from "../shared/types";

export type StoragePort = {
  // Tasks
  saveTask: (task: Task) => Promise<Result<Task, string>>;
  getTask: (id: string) => Promise<Result<Task, string>>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<Result<Task, string>>;

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

  // Messages — all attributable to a TaskID (invariant 9)
  saveMessage: (message: Message) => Promise<Result<Message, string>>;
  getMessages: (taskId: string) => Promise<Result<Message[], string>>;

  // Queues
  saveQueue: (queue: Queue) => Promise<Result<Queue, string>>;
  getQueue: (id: string) => Promise<Result<Queue, string>>;
  updateQueue: (id: string, patch: Partial<Queue>) => Promise<Result<Queue, string>>;
};
