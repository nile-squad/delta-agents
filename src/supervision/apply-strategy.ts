/**
 * Supervision strategy application — pure function.
 *
 * Converts a declared SupervisionPolicy and execution context into a concrete
 * SupervisionDecision. The decision is deterministic: same inputs always
 * produce the same output (prohibition 10: engine never bypasses configured
 * supervision policies).
 *
 * Retry-based strategies (retry, restart, resume) are subject to maxRetries.
 * Once the retry budget is exhausted the decision is "give-up", which the
 * engine surfaces as an unrecoverable failure for human review.
 *
 * Terminal strategies (escalate, abort-subtree, abort-tree) are not subject
 * to maxRetries — they always produce the same action.
 *
 * Resume falls back to restart when no checkpoint is available, rather than
 * failing silently. This keeps the task recoverable even when a phase had
 * checkpoint:false.
 */

import type { SupervisionPolicy } from "../shared/types";
import type { SupervisionDecision } from "./types";

export const applyStrategy = ({
  policy,
  retryCount,
  checkpointId,
}: {
  policy: SupervisionPolicy;
  /** Number of recovery attempts already made for this failure. */
  retryCount: number;
  /** Latest checkpoint ID, if one exists for this task. */
  checkpointId?: string;
}): SupervisionDecision => {
  // Retry-based strategies honour maxRetries.
  const retriable =
    policy.strategy === "retry" ||
    policy.strategy === "restart" ||
    policy.strategy === "resume";

  if (retriable && retryCount >= policy.maxRetries) {
    return {
      action: "give-up",
      reason: `maxRetries (${policy.maxRetries}) exhausted after ${retryCount} attempt(s)`,
    };
  }

  switch (policy.strategy) {
    case "retry":
      return { action: "retry" };

    case "restart":
      return { action: "restart" };

    case "resume":
      // Graceful fallback: no checkpoint → restart from the beginning.
      if (checkpointId === undefined) {
        return { action: "restart" };
      }
      return { action: "resume", checkpointId };

    case "escalate":
      return { action: "escalate" };

    case "abort-subtree":
      return { action: "abort-subtree" };

    case "abort-tree":
      return { action: "abort-tree" };
  }
};
