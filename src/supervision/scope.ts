/**
 * Subtask budget scope enforcement — pure functions.
 *
 * A subtask must never receive more budget than its parent has remaining.
 * This is a hard constraint: authority cannot flow upward in the tree
 * (spec invariant 18, prohibitions 7, 8).
 *
 * enforceSubtaskScope clamps the requested budget to what the parent can
 * actually afford. The caller uses the clamped budget when creating the subtask.
 *
 * isWithinParentScope is a predicate callers can use to check before creating
 * a subtask, and to verify invariant 18 in tests.
 */

import type { Cost } from "../shared/types";
import { remainingCost } from "../shared/cost";

/**
 * Clamp a requested subtask budget to the parent's remaining headroom.
 *
 * If the parent has exhausted its tokens, the subtask receives 0 tokens.
 * If the parent has exhausted its time, the subtask receives 0 durationMs.
 * Both axes are clamped independently (spec §Subtask Budget Scoping).
 */
export const enforceSubtaskScope = ({
  requestedBudget,
  parentBudget,
  parentSpent,
}: {
  requestedBudget: Cost;
  parentBudget: Cost;
  parentSpent: Cost;
}): Cost => {
  const remaining = remainingCost(parentBudget, parentSpent);
  return {
    tokens: Math.min(requestedBudget.tokens, remaining.tokens),
    durationMs: Math.min(requestedBudget.durationMs, remaining.durationMs),
  };
};

/**
 * True when the proposed subtask budget fits entirely within the parent's
 * remaining budget. Used to detect scope violations before enforcement.
 */
export const isWithinParentScope = ({
  proposedBudget,
  parentBudget,
  parentSpent,
}: {
  proposedBudget: Cost;
  parentBudget: Cost;
  parentSpent: Cost;
}): boolean => {
  const remaining = remainingCost(parentBudget, parentSpent);
  return (
    proposedBudget.tokens <= remaining.tokens &&
    proposedBudget.durationMs <= remaining.durationMs
  );
};
