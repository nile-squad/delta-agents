/**
 * Team roster — a derived read-model of "who is doing what, and how loaded".
 *
 * Agents collaborate by delegating and mentioning teammates, but a bare list of
 * teammate names tells an agent nothing about whether a teammate is idle or
 * buried. Humans in a workspace route work by knowing who is busy; this gives
 * agents (and developers, via `engine.roster()`) the same awareness.
 *
 * It is intentionally a *derived* view, not a separate live cache: each entry is
 * computed from the store's own task/message state, so it is always consistent
 * with reality and survives restarts (no bookkeeping to drift). The concurrency
 * model it reports mirrors the engine's own rule — 1 major task + up to 2 active
 * subtasks + an unbounded queue (invariant 26 / binary supervision tree).
 */

import type { StoragePort } from "../ports/storage-port";
import type { ExecutionStatus, RosterEntry } from "../shared/types";

export type { RosterEntry };

// A task counts toward load while it is pending or running. Completed/failed/
// aborted/paused/pendingCommit tasks are not active work.
const ACTIVE_STATUSES = new Set<ExecutionStatus>(["running", "pending"]);

// Total slots an agent can hold at once: 1 major + 2 subtasks.
const MAX_SLOTS = 3;

/**
 * Compute roster entries for a specific set of agent names. This is the shared
 * core: the scheduler calls it for an agent's teammates (to enrich reasoning
 * context), and `engine.roster()` calls it for the whole engine or a team.
 *
 * Best-effort and non-throwing: a store read failure for one agent degrades that
 * agent's line (treated as idle/unknown) rather than sinking the whole roster —
 * awareness is advisory, never a correctness gate.
 */
export const computeRosterEntries = async ({
  store,
  agentNames,
}: {
  store: StoragePort;
  agentNames: string[];
}): Promise<RosterEntry[]> => {
  const entries: RosterEntry[] = [];
  for (const agent of agentNames) {
    entries.push(await computeOne({ store, agent }));
  }
  return entries;
};

const computeOne = async ({ store, agent }: { store: StoragePort; agent: string }): Promise<RosterEntry> => {
  // Active tasks: prefer the dedicated query; degrade to "latest task only" when
  // the adapter does not implement it (subtasks then read as 0 — a floor, not a
  // wrong number).
  const active = await activeTasksFor({ store, agent });
  const majorTasks = active.filter((t) => t.parentId === undefined);
  const subtasks = active.filter((t) => t.parentId !== undefined);

  // Queued goals: unread caller messages addressed to this agent. When an agent
  // is busy, new sends are queued as caller messages (invariant 26), so their
  // unread count is the agent's backlog depth.
  let queued = 0;
  const inbound = await store.getMessagesByReceiver(agent);
  if (inbound.isOk) {
    queued = inbound.value.filter((m) => m.sender === "caller" && m.consumed !== true && m.recalledAt === undefined).length;
  }

  const major = majorTasks.length;
  const subs = subtasks.length;
  const used = Math.min(major + subs, MAX_SLOTS);
  const overloaded = used >= MAX_SLOTS || queued > 0;

  // "doing" prefers the major task (the agent's headline work); falls back to the
  // first active subtask so a delegate-only agent still shows activity.
  const headline = majorTasks[0] ?? subtasks[0];
  const doing = headline === undefined
    ? null
    : {
        taskId: headline.id,
        goal: headline.goal,
        ...(headline.currentPhase !== undefined ? { phase: headline.currentPhase } : {}),
      };

  return {
    agent,
    status: active.length > 0 ? "busy" : "idle",
    doing,
    load: { major, subtasks: subs, queued, capacity: `${used}/${MAX_SLOTS}`, overloaded },
  };
};

const activeTasksFor = async ({ store, agent }: { store: StoragePort; agent: string }) => {
  if (store.getActiveTasksByAgent !== undefined) {
    const res = await store.getActiveTasksByAgent(agent);
    return res.isOk ? res.value : [];
  }
  // Fallback: only the latest task is queryable, so we can see the major task but
  // not sibling subtasks. Report what we can.
  const latest = await store.getLatestTaskByAgent(agent);
  if (latest.isErr || latest.value === null) return [];
  return ACTIVE_STATUSES.has(latest.value.status) ? [latest.value] : [];
};
