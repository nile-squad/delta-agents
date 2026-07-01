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

import { Ok, Err, option } from "slang-ts";
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
  Commit,
  CommitQuery,
  Queue,
  ExecutionStatus,
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
  const commitsByAgent = new Map<string, Commit[]>();
  const queues = new Map<string, Queue>();

  return {
    // Tasks
    saveTask: async (task) => {
      tasks.set(task.id, task);
      return Ok(task);
    },
    getTask: async (id) => {
      const opt = option(tasks.get(id));
      return opt.isSome ? Ok(opt.value) : Err(`task "${id}" not found`);
    },
    updateTask: async (id, patch) => {
      const existing = option(tasks.get(id));
      if (existing.isNone) return Err(`task "${id}" not found`);
      const updated: Task = { ...existing.value, ...patch };
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
      const opt = option(taskTrees.get(rootTaskId));
      return opt.isSome ? Ok(opt.value) : Err(`task tree "${rootTaskId}" not found`);
    },
    updateTaskTree: async (rootTaskId, patch) => {
      const existing = option(taskTrees.get(rootTaskId));
      if (existing.isNone) return Err(`task tree "${rootTaskId}" not found`);
      const updated: TaskTree = { ...existing.value, ...patch };
      taskTrees.set(rootTaskId, updated);
      return Ok(updated);
    },

    // Executions
    saveExecution: async (execution) => {
      executions.set(execution.id, execution);
      return Ok(execution);
    },
    getExecution: async (id) => {
      const opt = option(executions.get(id));
      return opt.isSome ? Ok(opt.value) : Err(`execution "${id}" not found`);
    },
    updateExecution: async (id, patch) => {
      const existing = option(executions.get(id));
      if (existing.isNone) return Err(`execution "${id}" not found`);
      const updated: Execution = { ...existing.value, ...patch };
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
      const opt = option(approvals.get(id));
      return opt.isSome ? Ok(opt.value) : Err(`approval "${id}" not found`);
    },
    updateApprovalRequest: async (id, patch) => {
      const existing = option(approvals.get(id));
      if (existing.isNone) return Err(`approval "${id}" not found`);
      const updated: ApprovalRequest = { ...existing.value, ...patch };
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
    getMessagesByReceiver: async (receiver) => {
      const all = [...messagesByTask.values()].flat().filter((m) => m.receiver === receiver);
      return Ok(all);
    },
    markMessageConsumed: async (id) => {
      for (const [taskId, msgs] of messagesByTask.entries()) {
        const idx = msgs.findIndex((m) => m.id === id);
        if (idx !== -1) {
          const updated = [...msgs];
          updated[idx] = { ...msgs[idx]!, consumed: true };
          messagesByTask.set(taskId, updated);
          return Ok(undefined);
        }
      }
      return Err(`message "${id}" not found`);
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

    // Commits — agent-driven checkpoint annotations, newest-first per agent
    saveCommit: async (commit) => {
      const existing = commitsByAgent.get(commit.agentName) ?? [];
      commitsByAgent.set(commit.agentName, [...existing, commit]);
      return Ok(commit);
    },
    getCommitsByAgent: async (agentName, limit) => {
      const all = [...(commitsByAgent.get(agentName) ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return Ok(limit !== undefined ? all.slice(0, limit) : all);
    },
    searchCommits: async (query, currentAgent) => {
      const scope = query.allAgents === true
        ? [...commitsByAgent.values()].flat()
        : commitsByAgent.get(currentAgent) ?? [];
      const filtered = scope.filter((c) => {
        if (query.workflowName !== undefined && c.workflowName !== query.workflowName) return false;
        if (query.query !== undefined) {
          if (c.notes === null) return false;
          if (!c.notes.toLowerCase().includes(query.query.toLowerCase())) return false;
        }
        return true;
      });
      const sorted = [...filtered].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return Ok(sorted.slice(0, query.limit ?? 20));
    },

    // Queues
    saveQueue: async (queue) => {
      queues.set(queue.id, queue);
      return Ok(queue);
    },
    getQueue: async (id) => {
      const opt = option(queues.get(id));
      return opt.isSome ? Ok(opt.value) : Err(`queue "${id}" not found`);
    },
    updateQueue: async (id, patch) => {
      const existing = option(queues.get(id));
      if (existing.isNone) return Err(`queue "${id}" not found`);
      const updated: Queue = { ...existing.value, ...patch };
      queues.set(id, updated);
      return Ok(updated);
    },

    // Cleanup — destructive operations the engine uses for retention pruning.
    // The cascade is in-process and synchronous; safe because all data lives
    // in the same closure.
    deleteTask: async (id) => {
      const existed = tasks.delete(id);
      // Cascade to related buckets so a deleted task leaves no orphans. A
      // re-insert of the same id would otherwise surface stale messages.
      checkpointsByTask.delete(id);
      messagesByTask.delete(id);
      escalationsByTask.delete(id);
      const execsToRemove = [...executions.values()].filter((e) => e.taskId === id);
      for (const e of execsToRemove) executions.delete(e.id);
      return existed ? Ok(undefined) : Err(`task "${id}" not found`);
    },
    deleteMessages: async (taskId, olderThan) => {
      // Only CONSUMED messages are pruned — unconsumed mentions may still
      // need delivery to their receiver. `olderThan` further restricts to
      // consumed messages created before that date.
      const existing = messagesByTask.get(taskId) ?? [];
      const toKeep = olderThan !== undefined
        ? existing.filter((m) => !(m.consumed === true && m.createdAt < olderThan))
        : existing.filter((m) => m.consumed !== true);
      const removed = existing.length - toKeep.length;
      if (toKeep.length === 0) messagesByTask.delete(taskId);
      else messagesByTask.set(taskId, toKeep);
      return Ok(removed);
    },

    // Cleanup scan helpers — feed the retention prune without forcing the
    // caller to know the in-memory shape. Both run synchronously since the
    // data is already in-process.
    getTasksOlderThan: async (statuses: ExecutionStatus[], olderThan: Date) => {
      const statusSet = new Set(statuses);
      const matched = [...tasks.values()].filter(
        (t) => statusSet.has(t.status) && t.updatedAt < olderThan,
      );
      return Ok(matched);
    },
    getTaskIds: async () => {
      return Ok([...tasks.keys()]);
    },
  };
};
