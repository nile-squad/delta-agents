/**
 * Tool budget enforcement integration tests (Phase 4).
 *
 * Tools may declare an optional `cost` (what each call costs) and `budget`
 * (a hard cap on cumulative spend). When the cumulative spend would push
 * past the budget, the scheduler blocks the call and surfaces a humanized
 * reason to the model via `lastToolInfoResult`. A blocked call does NOT
 * add to the spend tracker.
 *
 * Cost is a multi-axis vector from `src/shared/cost.ts`; the budget check
 * uses `isOverBudget` so any axis crossing the cap triggers a block.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import { createDeltaEngine } from "../../src/engine";
import { createInMemoryStore } from "../../src/ports";
import type { ReasonerPort, ReasonerDecision } from "../../src/ports/reasoner-port";
import type { Tool } from "../../src/authoring/types";
import type { DeltaEngine } from "../../src/engine/types";

/** Counter-style reasoner that returns the next call, falling back to "done". */
const counterReasoner = (calls: () => ReasonerDecision[]): ReasonerPort => {
  let i = 0;
  const reasoner: ReasonerPort = {
    reason: async (_input) => Ok(calls()[i++] ?? { kind: "done" }),
  };
  return reasoner;
};

/** Register a noop action on the engine and return it. */
const registerNoop = (delta: DeltaEngine) =>
  delta.action({ name: "finish", description: "noop", schema: z.object({}), fn: async () => Ok("ok") });

describe("budget enforcement: tools with cost but no budget", () => {
  it("a tool with cost but no budget is never blocked", async () => {
    const store = createInMemoryStore();
    const calls: ReasonerDecision[] = [
      { kind: "tool", toolCall: { toolName: "free", input: {} } },
      { kind: "tool", toolCall: { toolName: "free", input: {} } },
      { kind: "tool", toolCall: { toolName: "free", input: {} } },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);
    const tool: Tool = {
      name: "free",
      description: "has cost, no budget",
      schema: z.object({}),
      fn: async () => Ok("ok"),
      cost: { tokens: 100, durationMs: 10 },
    };
    const delta = await createDeltaEngine({ store, reasoner });
    delta.tool(tool);
    delta.deploy(delta.agent({ name: "free-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "call free", agentName: "free-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const history = result.value.snapshot.toolHistory ?? [];
    expect(history).toHaveLength(3);
    expect(result.value.snapshot.lastToolInfoResult).toBeUndefined();
  });
});

describe("budget enforcement: tools with cost + budget", () => {
  it("blocks the call that would push cumulative spend over the budget", async () => {
    const store = createInMemoryStore();
    const calls: ReasonerDecision[] = [
      { kind: "tool", toolCall: { toolName: "metered", input: {} } }, // 50/100 → 50 total
      { kind: "tool", toolCall: { toolName: "metered", input: {} } }, // 50/100 → 100 total (at cap)
      { kind: "tool", toolCall: { toolName: "metered", input: {} } }, // 50/100 → would be 150 → blocked
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);
    const tool: Tool = {
      name: "metered",
      description: "metered",
      schema: z.object({}),
      fn: async () => Ok("ok"),
      cost: { tokens: 50, durationMs: 10 },
      budget: { tokens: 100, durationMs: 1000 },
    };
    const delta = await createDeltaEngine({ store, reasoner });
    delta.tool(tool);
    delta.deploy(delta.agent({ name: "metered-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "call metered", agentName: "metered-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const history = result.value.snapshot.toolHistory ?? [];
    // Two successful calls; the third was blocked.
    expect(history).toHaveLength(2);
    expect(result.value.snapshot.lastToolInfoResult).toBeDefined();
    expect(result.value.snapshot.lastToolInfoResult).toMatch(/budget is exhausted/);
  });

  it("allows every call when the cumulative cost stays within the budget", async () => {
    const store = createInMemoryStore();
    const calls: ReasonerDecision[] = [
      { kind: "tool", toolCall: { toolName: "cheap", input: {} } },
      { kind: "tool", toolCall: { toolName: "cheap", input: {} } },
      { kind: "tool", toolCall: { toolName: "cheap", input: {} } },
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);
    const tool: Tool = {
      name: "cheap",
      description: "cheap",
      schema: z.object({}),
      fn: async () => Ok("ok"),
      cost: { tokens: 1, durationMs: 1 },
      budget: { tokens: 100, durationMs: 1000 },
    };
    const delta = await createDeltaEngine({ store, reasoner });
    delta.tool(tool);
    delta.deploy(delta.agent({ name: "cheap-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "call cheap", agentName: "cheap-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const history = result.value.snapshot.toolHistory ?? [];
    expect(history).toHaveLength(3);
    expect(result.value.snapshot.lastToolInfoResult).toBeUndefined();
  });

  it("uses isOverBudget: an axis crossing the cap blocks even when others are far under", async () => {
    // Tokens are 0/0 (unconstrained), but duration is 100/100 (capped at 100ms).
    // Each call is 60ms; second call would push to 120ms → blocked.
    const store = createInMemoryStore();
    const calls: ReasonerDecision[] = [
      { kind: "tool", toolCall: { toolName: "slow", input: {} } }, // 60/100 → 60 total
      { kind: "tool", toolCall: { toolName: "slow", input: {} } }, // would be 120 → blocked
      { kind: "done" },
    ];
    const reasoner = counterReasoner(() => calls);
    const tool: Tool = {
      name: "slow",
      description: "slow",
      schema: z.object({}),
      fn: async () => Ok("ok"),
      cost: { tokens: 0, durationMs: 60 },
      budget: { tokens: 1_000, durationMs: 100 },
    };
    const delta = await createDeltaEngine({ store, reasoner });
    delta.tool(tool);
    delta.deploy(delta.agent({ name: "slow-agent", description: "d", role: "r", rolePrompt: ".", actions: [registerNoop(delta)] }));

    const result = await delta.send({ goal: "call slow", agentName: "slow-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const history = result.value.snapshot.toolHistory ?? [];
    expect(history).toHaveLength(1);
    expect(result.value.snapshot.lastToolInfoResult).toMatch(/budget is exhausted/);
  });
});
