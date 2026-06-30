/**
 * Reasoner resilience tests.
 *
 * A model call can fail transiently: a network blip, a momentary rate limit,
 * malformed JSON, or a turn with no tool call. The engine retries the reasoner
 * step with jittered backoff (configurable via providerRetry) before giving up,
 * and on exhaustion escalates to a human rather than failing outright.
 *
 * Backoff is set near-zero here so the retries do not slow the suite.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import type { ReasonerPort } from "../../src/ports/reasoner-port";

/** A reasoner that fails `failTimes` times, then returns a clean done decision. */
const flakyReasoner = (failTimes: number): { port: ReasonerPort; calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      reason: async () => {
        calls += 1;
        if (calls <= failTimes) return Err(`transient failure ${calls}`);
        return Ok({ kind: "done" });
      },
    },
  };
};

const deployAgent = (delta: Awaited<ReturnType<typeof createDeltaEngine>>) => {
  const act = delta.action({ name: "act", description: "a unit of work", schema: z.object({}), fn: async () => Ok("ok") });
  delta.deploy(delta.agent({ name: "agent", description: "d", role: "R", rolePrompt: ".", actions: [act] }));
};

describe("reasoner resilience", () => {
  it("recovers from transient reasoner failures within the retry budget", async () => {
    const flaky = flakyReasoner(2); // fail twice, then succeed
    const delta = await createDeltaEngine({
      reasoner: flaky.port,
      providerRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    deployAgent(delta);

    const result = await delta.send({ goal: "go", agentName: "agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The third attempt succeeded, so the task completed despite two failures.
    expect(result.value.status).toBe("completed");
    expect(flaky.calls()).toBe(3);
  });

  it("escalates immediately when retries are disabled (maxAttempts 1)", async () => {
    const flaky = flakyReasoner(99); // always fails
    const delta = await createDeltaEngine({
      reasoner: flaky.port,
      providerRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2 },
    });
    deployAgent(delta);

    const result = await delta.send({ goal: "go", agentName: "agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // One attempt, no retry, then escalate: blocked for human review, not failed.
    expect(result.value.status).toBe("blocked");
    expect(flaky.calls()).toBe(1);
    expect(result.value.reason).toMatch(/1 attempt\(s\), escalated/);

    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (inspected.isOk) {
      expect(inspected.value.escalations.some((e) => e.trigger === "reasoner-failure")).toBe(true);
    }
  });
});
