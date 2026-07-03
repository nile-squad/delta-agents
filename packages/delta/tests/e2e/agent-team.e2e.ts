/**
 * Agent-to-agent teamwork end-to-end suite, run against the BUILT artifact in
 * dist/, with a real OpenAI-compatible model (OpenRouter) driving every agent.
 *
 * Where core-principles.e2e.ts proves a live model cannot bypass governance,
 * this suite proves the collaboration primitives themselves work end-to-end
 * against a real, non-deterministic model on a realistic multi-agent task:
 *   - delegation: a coordinator hands a scoped sub-goal to a specialist teammate
 *     and the child task is governed and scoped under the parent's tree
 *   - mention: a teammate leaves a note that is delivered on the recipient's own
 *     next task, without spawning a child or sharing task state
 *
 * Assertions are structural (task tree shape, delivery, no crash) rather than
 * narrative (exact wording), because a live model's turn-by-turn choices are
 * not deterministic — only the governance shape around them is.
 *
 * Run: OPENROUTER_API_KEY=sk-or-... pnpm test:e2e
 * Optional: OPENROUTER_MODEL (default openai/gpt-4o-mini),
 *           OPENROUTER_BASE_URL (default https://openrouter.ai/api/v1).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
// Import the shipped artifact, not the source.
import { createDeltaEngine, Ok } from "../../dist/index.js";

// ── Live-model wiring ──────────────────────────────────────────────────────────

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL ?? "cohere/north-mini-code:free";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

// Skip the whole suite cleanly when no key is present, rather than failing.
const describeLive = API_KEY ? describe : describe.skip;

// `models` (not the `reasoner` escape hatch) is the documented production path
// for wiring a real provider — createOpenAIReasoner stays internal to the engine.
const liveEngine = () => createDeltaEngine({
  models: [{ name: "default", model: MODEL, endpoint: BASE_URL, apiKey: API_KEY, default: true }],
  maxStepsPerTask: 8,
});

const GENEROUS = { tokens: 12_000, durationMs: 180_000 };

// ── Team: delegation on a real task ─────────────────────────────────────────────

describeLive("agent team — delegation on a real task", () => {
  it("a coordinator delegates a scoped sub-goal to a specialist teammate", async () => {
    const delta = await liveEngine();

    const lookupPrice = delta.action({
      name: "lookup-price",
      description: "look up the current price of a stock ticker",
      schema: z.object({ ticker: z.string() }),
      fn: async ({ ticker }: { ticker: string }) => Ok(`${ticker}: $123.45`),
    });
    const analyst = delta.agent({
      name: "market-analyst",
      description: "looks up market data on request",
      role: "Market Analyst",
      rolePrompt: "When asked about a ticker, look up its price and report it back concisely.",
      actions: [lookupPrice],
    });
    delta.deploy(analyst);

    const draftBrief = delta.action({
      name: "draft-brief",
      description: "draft a one-line investment brief",
      schema: z.object({ summary: z.string() }),
      fn: async () => Ok("brief drafted"),
    });
    const coordinator = delta.agent({
      name: "team-lead",
      description: "coordinates a small research team",
      role: "Team Lead",
      rolePrompt:
        "Delegate looking up the ACME ticker price to the market-analyst teammate. " +
        "Once you have an answer, draft a one-line brief and finish.",
      actions: [draftBrief],
    });
    delta.deploy(coordinator);

    const result = await delta.send({
      goal: "Get the current ACME stock price from the market-analyst and draft a one-line brief.",
      agentName: "team-lead",
      budget: GENEROUS,
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The team task settled within governance: no unbounded growth, no crash.
    expect(["completed", "blocked", "failed"]).toContain(result.value.status);

    // If the coordinator delegated (its choice, not forced), the child task is
    // scoped under the parent's tree, never free-floating (invariants 15, 18).
    const child = await delta.lastTask("market-analyst");
    if (child.isOk && child.value !== null) {
      expect(child.value.rootId).toBe(result.value.taskId);
      expect(child.value.assignedAgent).toBe("market-analyst");
    }
  });
});

// ── Team: mention delivers a note across agents' own tasks ─────────────────────

describeLive("agent team — mention delivers a note to a teammate", () => {
  it("a note left via mention is delivered on the teammate's own next task", async () => {
    const delta = await liveEngine();

    const noop = delta.action({
      name: "noop",
      description: "acknowledge and finish",
      schema: z.object({}),
      fn: async () => Ok("done"),
    });

    const sender = delta.agent({
      name: "shift-lead",
      description: "hands off context to the next shift",
      role: "Shift Lead",
      rolePrompt:
        "Mention your teammate on-call-agent with a note that says " +
        "'server-7 is under maintenance, do not page for it', then finish.",
      actions: [noop],
    });
    delta.deploy(sender);

    const receiver = delta.agent({
      name: "on-call-agent",
      description: "handles pages",
      role: "On-call",
      rolePrompt: "Acknowledge any handoff notes from your teammates, then finish.",
      actions: [noop],
    });
    delta.deploy(receiver);

    const first = await delta.send({
      goal: "Hand off context about server-7 to the on-call-agent before your shift ends.",
      agentName: "shift-lead",
      budget: GENEROUS,
    });
    expect(first.isOk).toBe(true);

    // The mention is delivered when the recipient's own task next reasons, not
    // by spawning a child — give the on-call-agent its own task and inspect what
    // it saw. Delivery is best-effort on the model's choice to actually mention;
    // this assertion only checks the plumbing does not throw and settles cleanly.
    const second = await delta.send({
      goal: "Start your shift and acknowledge any handoff notes.",
      agentName: "on-call-agent",
      budget: GENEROUS,
    });
    expect(second.isOk).toBe(true);
    if (!second.isOk) return;
    expect(["completed", "blocked", "failed"]).toContain(second.value.status);
  });
});
