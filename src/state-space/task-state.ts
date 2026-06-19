/**
 * TaskStateSnapshot factory and transition helpers.
 *
 * The engine assembles a snapshot before every legality check and re-derives
 * it after every state change. Snapshots are never mutated in place — each
 * transition produces a new snapshot. This keeps the Markov property intact:
 * the current snapshot is always a complete description of the task's state.
 */

import type { Task } from "../shared/types";
import type { TaskStateSnapshot } from "./types";
import { zeroCost, addCosts } from "../shared/cost";

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
