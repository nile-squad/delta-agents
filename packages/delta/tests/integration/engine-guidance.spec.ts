/**
 * Engine guidance integration test.
 *
 * Verifies the end-to-end guidance path: a post-step that lands a governance
 * signal in a warning band (here, the token-budget band) has guidance computed
 * in applyPostStepGovernance, carried on the snapshot, and rendered into the
 * NEXT reasoner call's input. Also verifies `guidance: false` disables it and
 * that no line is produced when nothing is in band.
 *
 * The token-budget band is the deterministic lever: reasoningCost on the first
 * decision is folded into `spent` by the gateway before post-step runs, so a
 * budget sized to put spend at ~80% reliably fires the [75%, 100%) band.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine/create-delta-engine";
import { createInMemoryStore } from "../../src/ports/in-memory-store";
import type { ReasonerPort, ReasonerInput, ReasonerDecision } from "../../src/ports/reasoner-port";

/** A reasoner that plays scripted decisions in order and records every input. */
const scriptedReasoner = (script: ReasonerDecision[]): { reasoner: ReasonerPort; calls: ReasonerInput[] } => {
  const calls: ReasonerInput[] = [];
  let i = 0;
  const reasoner: ReasonerPort = {
    reason: async (input) => {
      calls.push(input);
      return Ok(script[i++] ?? { kind: "done" });
    },
  };
  return { reasoner, calls };
};

/** A no-op action with no declared estimatedCost (so the MPC pre-block never fires). */
const buildEngine = async (reasoner: ReasonerPort, guidance?: boolean) => {
  const store = createInMemoryStore();
  const engine = await createDeltaEngine(
    guidance === undefined ? { store, reasoner } : { store, reasoner, guidance },
  );
  const noop = engine.action({
    name: "noop",
    description: "does nothing",
    schema: z.object({}),
    fn: async () => Ok("done"),
  });
  const agent = engine.agent({
    name: "test-agent",
    description: "test",
    role: "Tester",
    rolePrompt: "Test.",
    actions: [noop],
  });
  engine.deploy(agent);
  return engine;
};

// Step 1 spends 800 of a 1000-token budget (80% → token band). Step 2 finishes.
const bandScript: ReasonerDecision[] = [
  { kind: "act", request: { actionName: "noop", input: {}, reasoningCost: { tokens: 800, durationMs: 0 } } },
  { kind: "done" },
];

describe("Engine guidance (integration)", () => {
  it("renders budget-band guidance into the next reasoner call", async () => {
    const { reasoner, calls } = scriptedReasoner(bandScript);
    const engine = await buildEngine(reasoner);

    const result = await engine.send({
      goal: "test guidance",
      agentName: "test-agent",
      budget: { tokens: 1000, durationMs: 100_000 },
    });

    expect(result.isOk).toBe(true);
    // Two reasoner calls: the initial step and the post-action step.
    expect(calls.length).toBe(2);
    const second = calls[1]!;
    expect(second.guidance).toBeDefined();
    expect(second.guidance!.some((g) => g.includes("token budget"))).toBe(true);
  });

  it("produces no guidance when guidance: false, even in a warning band", async () => {
    const { reasoner, calls } = scriptedReasoner(bandScript);
    const engine = await buildEngine(reasoner, false);

    const result = await engine.send({
      goal: "test guidance disabled",
      agentName: "test-agent",
      budget: { tokens: 1000, durationMs: 100_000 },
    });

    expect(result.isOk).toBe(true);
    for (const call of calls) {
      expect(call.guidance).toBeUndefined();
    }
  });

  it("produces no guidance when no signal is in a warning band", async () => {
    // Same 800-token step, but a 100k budget keeps consumption near 0.8% — nothing in band.
    const { reasoner, calls } = scriptedReasoner(bandScript);
    const engine = await buildEngine(reasoner);

    const result = await engine.send({
      goal: "test no guidance",
      agentName: "test-agent",
      budget: { tokens: 100_000, durationMs: 100_000 },
    });

    expect(result.isOk).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]!.guidance).toBeUndefined();
  });
});
