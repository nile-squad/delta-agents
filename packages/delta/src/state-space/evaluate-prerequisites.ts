/**
 * Prerequisite evaluation — pure function.
 *
 * An action with unsatisfied prerequisites does not exist in the current
 * state-space. It is not exposed, not discovered, and not executable
 * (spec §Action Prerequisites, invariant 20, prohibition 16).
 *
 * Only actions that previously returned Ok contribute to completedActions.
 * A failed action does not satisfy a prerequisite — the engine never infers
 * success from anything other than an explicit Ok result (invariant 19).
 */

import type { Action } from "../authoring/types";
import type { TaskStateSnapshot, PrerequisiteResult } from "./types";

export const evaluatePrerequisites = ({
  action,
  state,
}: {
  action: Action;
  state: TaskStateSnapshot;
}): PrerequisiteResult => {
  const prereqs = action.prerequisites;

  // No prerequisites declared — always satisfied.
  if (prereqs === undefined) return { satisfied: true };

  const completedActionsSet = new Set(state.completedActions);
  const completedWorkflowsSet = new Set(state.completedWorkflows);

  for (const required of prereqs.actions ?? []) {
    if (!completedActionsSet.has(required)) {
      return {
        satisfied: false,
        reason: `prerequisite action "${required}" has not completed successfully for task "${state.taskId}"`,
      };
    }
  }

  for (const required of prereqs.workflows ?? []) {
    if (!completedWorkflowsSet.has(required)) {
      return {
        satisfied: false,
        reason: `prerequisite workflow "${required}" has not completed successfully for task "${state.taskId}"`,
      };
    }
  }

  return { satisfied: true };
};
