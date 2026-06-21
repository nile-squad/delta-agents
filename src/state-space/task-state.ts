/**
 * TaskStateSnapshot factory and transition helpers.
 *
 * The engine assembles a snapshot before every legality check and re-derives
 * it after every state change. Snapshots are never mutated in place — each
 * transition produces a new snapshot. This keeps the Markov property intact:
 * the current snapshot is always a complete description of the task's state.
 */

import type { Task, JsonRecord } from "../shared/types";
import type { TaskStateSnapshot } from "./types";
import { zeroCost, addCosts } from "../shared/cost";

/**
 * Serialise a TaskStateSnapshot to a plain JsonRecord for checkpoint storage.
 *
 * WHY: checkpoints must be stored as opaque JSON (storage portability — the
 * adapter may be in-memory, SQLite, or a remote DB). JSON.parse(JSON.stringify)
 * is the only reliable roundtrip; the type system cannot verify that the
 * resulting JsonRecord shape is correct at compile time, so the cast is
 * unavoidable at this single serialization boundary. Do NOT add new casts
 * elsewhere; route through this helper (L4 — centralised cast).
 */
export const snapshotToJson = (snapshot: TaskStateSnapshot): JsonRecord =>
  JSON.parse(JSON.stringify(snapshot)) as JsonRecord;

/**
 * Deserialise a checkpoint JsonRecord back into a TaskStateSnapshot.
 *
 * WHY: at recovery time the stored JSON is structurally identical to
 * TaskStateSnapshot but the type system cannot verify that at compile time —
 * this is the single documented serialization boundary shim (L4). The cast
 * is intentional and unavoidable: the storage layer uses JsonRecord for
 * portability, so every recovery path needs exactly one bridge here.
 * Do NOT add new `as unknown` casts elsewhere; import this function instead.
 */
export const snapshotFromJson = (json: JsonRecord): TaskStateSnapshot =>
  json as unknown as TaskStateSnapshot;

/**
 * Build an initial TaskStateSnapshot from a newly created Task.
 * No actions or workflows have completed yet; spent cost starts at zero.
 */
export const snapshotFromTask = (task: Task): TaskStateSnapshot => ({
  taskId: task.id,
  rootId: task.rootId,
  agentName: task.assignedAgent,
  status: task.status,
  completedActions: [],
  completedWorkflows: [],
  budget: task.budget,
  spent: zeroCost(),
  risk: task.risk,
  trust: task.trust,
  currentWorkflow: task.workflow,
  currentPhase: task.currentPhase,
});

/**
 * Produce a new snapshot recording that an action completed successfully.
 * Only Ok outcomes advance the state — Err outcomes do not add to completedActions
 * (spec invariant 19: engine never infers success from anything but explicit Ok).
 */
export const withCompletedAction = ({
  snapshot,
  actionName,
  cost,
}: {
  snapshot: TaskStateSnapshot;
  actionName: string;
  cost: { tokens: number; durationMs: number };
}): TaskStateSnapshot => ({
  ...snapshot,
  completedActions: snapshot.completedActions.includes(actionName)
    ? snapshot.completedActions
    : [...snapshot.completedActions, actionName],
  spent: addCosts(snapshot.spent, cost),
});

/**
 * Produce a new snapshot recording that a workflow completed successfully.
 */
export const withCompletedWorkflow = ({
  snapshot,
  workflowName,
}: {
  snapshot: TaskStateSnapshot;
  workflowName: string;
}): TaskStateSnapshot => ({
  ...snapshot,
  completedWorkflows: snapshot.completedWorkflows.includes(workflowName)
    ? snapshot.completedWorkflows
    : [...snapshot.completedWorkflows, workflowName],
});

/**
 * Produce a new snapshot with an updated status.
 * Used when the task transitions (running → paused, running → completed, etc.).
 */
export const withStatus = ({
  snapshot,
  status,
}: {
  snapshot: TaskStateSnapshot;
  status: TaskStateSnapshot["status"];
}): TaskStateSnapshot => ({ ...snapshot, status });

/**
 * Produce a new snapshot with updated cost spent.
 * Used when an execution's cost is known (e.g. after fn() returns).
 */
export const withSpent = ({
  snapshot,
  spent,
}: {
  snapshot: TaskStateSnapshot;
  spent: { tokens: number; durationMs: number };
}): TaskStateSnapshot => ({
  ...snapshot,
  spent: addCosts(snapshot.spent, spent),
});

/**
 * Produce a new snapshot with escalation flag set.
 * Once escalated, no actions are legal until oversight resolves it.
 */
export const withEscalation = ({
  snapshot,
  escalated,
}: {
  snapshot: TaskStateSnapshot;
  escalated: boolean;
}): TaskStateSnapshot => ({
  ...snapshot,
  risk: { ...snapshot.risk, escalated },
});
