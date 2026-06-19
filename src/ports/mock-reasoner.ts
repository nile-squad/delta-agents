/**
 * Mock ReasonerPort adapter for testing.
 *
 * Returns scripted deterministic responses in order. Tests use this to exercise
 * the governance layer without a live model API. Governance behaviour must be
 * identical whether the reasoner is a mock or OpenAI — that independence is a
 * safety property, not just a test convenience.
 *
 * The mock also validates that requested actions are currently available. If a
 * scripted response names an action that is not in availableActions, the mock
 * returns Err — this catches tests that would silently skip prerequisite checks.
 */

import { Ok, Err } from "slang-ts";
import type { ReasonerPort, ActionRequest } from "./reasoner-port";

export type MockResponse = {
  actionName: string;
  input: Record<string, string | number | boolean | null>;
  reasoning?: string;
};

export type MockReasonerOptions = {
  /**
   * Scripted responses returned in order.
   * If the queue is exhausted and no fallback is set, further calls return Err.
   */
  responses?: MockResponse[];
  /** When set, every call returns Err with this message (simulates model failure). */
  alwaysFail?: string;
};

export const createMockReasoner = ({
  responses = [],
  alwaysFail,
}: MockReasonerOptions = {}): ReasonerPort => {
  const queue = [...responses];

  return {
    reason: async ({ availableActions }) => {
      if (alwaysFail !== undefined) return Err(alwaysFail);

      const next = queue.shift();
      if (next === undefined) {
        return Err("mock reasoner: no more responses configured");
      }

      // Validate that the scripted action is actually available — prevents tests
      // from bypassing state-space checks through the mock.
      if (!availableActions.includes(next.actionName)) {
        return Err(
          `mock reasoner: action "${next.actionName}" is not in availableActions ${JSON.stringify(availableActions)}`,
        );
      }

      const request: ActionRequest = {
        actionName: next.actionName,
        input: next.input,
        ...(next.reasoning !== undefined ? { reasoning: next.reasoning } : {}),
      };

      return Ok(request);
    },
  };
};
