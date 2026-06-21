/**
 * In-memory StoragePort adapter.
 *
 * Used in tests and local development. Each createInMemoryStore() call produces
 * a fully isolated instance — no shared state between tests (Quality Bar: tests
 * are self-contained, never read from persistent DB state).
 *
 * Map-backed for O(1) lookups. Checkpoints and messages use per-task arrays
 * to preserve insertion order without a secondary sort.
 */

import { Ok, Err } from "slang-ts";
import type { StoragePort } from "./storage-port";
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

export const createInMemoryStore = (): StoragePort => {
  const tasks = new Map<string, Task>();
  const taskTrees = new Map<string, TaskTree>();
  const executions = new Map<string, Execution>();
  const checkpointsByTask = new Map<string, Checkpoint[]>();
  const approvals = new Map<string, ApprovalRequest>();
  const escalationsByTask = new Map<string, EscalationRecord[]>();
  const messagesByTask = new Map<string, Message[]>();
  const memoriesByAgent = new Map<string, Memory[]>();
  const queues = new Map<string, Queue>();

  return {
    // Tasks
    saveTask: async (task) => {
      tasks.set(task.id, task);
      return Ok(task);
    },
    getTask: async (id) => {
      const task = tasks.get(id);
      return task !== undefined ? Ok(task) : Err(`task "${id}" not found`);
    },
    updateTask: async (id, patch) => {
      const existing = tasks.get(id);
      if (existing === undefined) return Err(`task "${id}" not found`);
      const updated: Task = { ...existing, ...patch };
      tasks.set(id, updated);
      return Ok(updated);
    },
    getLatestTaskByAgent: async (agentName) => {
      const all = [...tasks.values()].filter((t) => t.assignedAgent === agentName);
      if (all.length === 0) return Ok(null);
      // Most recently updated is the "latest" by wall-clock time.
      const sorted = [...all].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return Ok(sorted[0] ?? null);
    },

    // Task trees
    saveTaskTree: async (tree) => {
      taskTrees.set(tree.rootTaskId, tree);
      return Ok(tree);
    },
    getTaskTree: async (rootTaskId) => {
      const tree = taskTrees.get(rootTaskId);
      return tree !== undefined ? Ok(tree) : Err(`task tree "${rootTaskId}" not found`);
    },
    updateTaskTree: async (rootTaskId, patch) => {
      const existing = taskTrees.get(rootTaskId);
      if (existing === undefined) return Err(`task tree "${rootTaskId}" not found`);
      const updated: TaskTree = { ...existing, ...patch };
      taskTrees.set(rootTaskId, updated);
      return Ok(updated);
    },

    // Executions
    saveExecution: async (execution) => {
      executions.set(execution.id, execution);
      return Ok(execution);
    },
    getExecution: async (id) => {
      const execution = executions.get(id);
      return execution !== undefined ? Ok(execution) : Err(`execution "${id}" not found`);
    },
    updateExecution: async (id, patch) => {
      const existing = executions.get(id);
      if (existing === undefined) return Err(`execution "${id}" not found`);
      const updated: Execution = { ...existing, ...patch };
      executions.set(id, updated);
      return Ok(updated);
    },
    getExecutionsByTask: async (taskId) => {
      const result = [...executions.values()].filter((e) => e.taskId === taskId);
      return Ok(result);
    },

    // Checkpoints — appended in order; latest is last
    saveCheckpoint: async (checkpoint) => {
      const existing = checkpointsByTask.get(checkpoint.taskId) ?? [];
      checkpointsByTask.set(checkpoint.taskId, [...existing, checkpoint]);
      return Ok(checkpoint);
    },
    getLatestCheckpoint: async (taskId) => {
      const list = checkpointsByTask.get(taskId) ?? [];
      const latest = list.length > 0 ? list[list.length - 1] : null;
      return Ok(latest ?? null);
    },

    // Approvals
    saveApprovalRequest: async (req) => {
      approvals.set(req.id, req);
      return Ok(req);
    },
    getApprovalRequest: async (id) => {
      const req = approvals.get(id);
      return req !== undefined ? Ok(req) : Err(`approval "${id}" not found`);
    },
    updateApprovalRequest: async (id, patch) => {
      const existing = approvals.get(id);
      if (existing === undefined) return Err(`approval "${id}" not found`);
      const updated: ApprovalRequest = { ...existing, ...patch };
      approvals.set(id, updated);
      return Ok(updated);
    },
    getPendingApprovals: async (taskId) => {
      const result = [...approvals.values()].filter(
        (a) => a.taskId === taskId && a.status === "pending",
      );
      return Ok(result);
    },
    getApprovalsByTask: async (taskId) => {
      const result = [...approvals.values()].filter((a) => a.taskId === taskId);
      return Ok(result);
    },

    // Escalations — appended in order; getEscalationsByTask returns all in insertion order
    saveEscalation: async (record) => {
      const existing = escalationsByTask.get(record.taskId) ?? [];
      escalationsByTask.set(record.taskId, [...existing, record]);
      return Ok(record);
    },
    getEscalationsByTask: async (taskId) => {
      return Ok(escalationsByTask.get(taskId) ?? []);
    },

    // Messages — appended in insertion order (FIFO)
    saveMessage: async (message) => {
      const existing = messagesByTask.get(message.taskId) ?? [];
      messagesByTask.set(message.taskId, [...existing, message]);
      return Ok(message);
    },
    getMessages: async (taskId) => {
      return Ok(messagesByTask.get(taskId) ?? []);
    },

    // Memories — newest-first retrieval scoped to the owning agent
    saveMemory: async (memory) => {
      const existing = memoriesByAgent.get(memory.agentName) ?? [];
      memoriesByAgent.set(memory.agentName, [...existing, memory]);
      return Ok(memory);
    },
    getMemoriesByAgent: async (agentName, limit) => {
      const all = [...(memoriesByAgent.get(agentName) ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return Ok(limit !== undefined ? all.slice(0, limit) : all);
    },

    // Queues
    saveQueue: async (queue) => {
      queues.set(queue.id, queue);
      return Ok(queue);
    },
    getQueue: async (id) => {
      const queue = queues.get(id);
      return queue !== undefined ? Ok(queue) : Err(`queue "${id}" not found`);
    },
    updateQueue: async (id, patch) => {
      const existing = queues.get(id);
      if (existing === undefined) return Err(`queue "${id}" not found`);
      const updated: Queue = { ...existing, ...patch };
      queues.set(id, updated);
      return Ok(updated);
    },
  };
};
