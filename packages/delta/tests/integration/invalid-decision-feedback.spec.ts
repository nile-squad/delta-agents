/**
 * Bounded invalid-decision feedback (maxInvalidDecisionRetries).
 *
 * WHY: a model decision naming an unknown action, or supplying input that fails
 * the action's schema, previously failed the task outright — one malformed
 * model output killed the run. The scheduler now feeds the rejection back to
 * the model (ReasonerInput.lastError) so it can self-correct, bounded by
 * `maxInvalidDecisionRetries` consecutive attempts (default 3; 0 = the old
 * fail-immediately behavior). Any valid decision resets the counter.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import type { ReasonerPort, ReasonerDecision, ReasonerInput } from "../../src/ports/reasoner-port";

/** Scripted reasoner that records every input it receives (to assert lastError). */
const scriptedReasoner = (script: ReasonerDecision[], seen: ReasonerInput[]): ReasonerPort => {
  const queue = [...script];
  return {
    reason: async (input) => {
      seen.push(input);
      const next = queue.shift();
      return Ok(next ?? { kind: "done" });
    },
  };
};

const act = (actionName: string, input: Record<string, string | number | boolean | null> = {}): ReasonerDecision => ({
  kind: "act",
  request: { actionName, input },
});

describe("invalid-decision feedback loop", () => {
  it("feeds an unknown-action rejection back via lastError, then completes on a valid decision", async () => {
    const seen: ReasonerInput[] = [];
    let workCount = 0;
    const delta = await createDeltaEngine({
      store: createInMemoryStore(),
      reasoner: scriptedReasoner([act("nope"), act("work")], seen),
    });
    const work = delta.action({
      name: "work",
      description: "test action",
      schema: z.object({}),
      fn: async () => {
        workCount++;
        return Ok("done");
      },
    });
    delta.deploy(delta.agent({ name: "fb-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    const result = await delta.send({ goal: "do work", agentName: "fb-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(workCount).toBe(1);

    // Second call carries the rejection (attempt 1 of the default 3)…
    expect(seen[1]?.lastError).toBeDefined();
    expect(seen[1]?.lastError?.reason).toContain('unknown action "nope"');
    expect(seen[1]?.lastError?.attempt).toBe(1);
    expect(seen[1]?.lastError?.maxAttempts).toBe(3);
    // …and the valid decision resets the counter: the third call carries none.
    expect(seen[2]?.lastError).toBeUndefined();
  });

  it("fails with a retries-exhausted reason after N+1 consecutive invalid decisions", async () => {
    const seen: ReasonerInput[] = [];
    const delta = await createDeltaEngine({
      store: createInMemoryStore(),
      reasoner: scriptedReasoner([act("ghost"), act("ghost"), act("ghost")], seen),
      maxInvalidDecisionRetries: 2,
    });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: async () => Ok("done") });
    delta.deploy(delta.agent({ name: "fb2-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    const result = await delta.send({ goal: "do work", agentName: "fb2-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/invalid decision retries exhausted after 3 consecutive attempt\(s\)/);
    expect(result.value.reason).toContain('unknown action "ghost"');
    // Exactly three reasoner turns: two fed back, the third exhausted the bound.
    expect(seen.length).toBe(3);
  });

  it("maxInvalidDecisionRetries: 0 fails on the first invalid decision (old behavior)", async () => {
    const seen: ReasonerInput[] = [];
    const delta = await createDeltaEngine({
      store: createInMemoryStore(),
      reasoner: scriptedReasoner([act("ghost")], seen),
      maxInvalidDecisionRetries: 0,
    });
    const work = delta.action({ name: "work", description: "test action", schema: z.object({}), fn: async () => Ok("done") });
    delta.deploy(delta.agent({ name: "fb3-agent", description: "d", role: "r", rolePrompt: ".", actions: [work] }));

    const result = await delta.send({ goal: "do work", agentName: "fb3-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("failed");
    expect(result.value.reason).toMatch(/invalid decision retries exhausted after 1 consecutive attempt\(s\)/);
    expect(seen.length).toBe(1); // no feedback turn was offered
  });

  it("feeds a schema-invalid input back via lastError, then completes on corrected input", async () => {
    const seen: ReasonerInput[] = [];
    let typedCount = 0;
    const delta = await createDeltaEngine({
      store: createInMemoryStore(),
      // Valid action name, wrong input shape first (id must be a string).
      reasoner: scriptedReasoner([act("typed", { id: 123 }), act("typed", { id: "ok" })], seen),
    });
    const typed = delta.action({
      name: "typed",
      description: "test action with a typed schema",
      schema: z.object({ id: z.string() }),
      fn: async () => {
        typedCount++;
        return Ok("done");
      },
    });
    delta.deploy(delta.agent({ name: "fb4-agent", description: "d", role: "r", rolePrompt: ".", actions: [typed] }));

    const result = await delta.send({ goal: "do typed work", agentName: "fb4-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.status).toBe("completed");
    expect(typedCount).toBe(1); // the fn only ran for the corrected input

    expect(seen[1]?.lastError).toBeDefined();
    expect(seen[1]?.lastError?.reason).toMatch(/^schema-invalid:/);
    expect(seen[1]?.lastError?.attempt).toBe(1);
  });
});
