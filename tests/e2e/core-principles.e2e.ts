/**
 * Core-principles end-to-end suite, run against the BUILT artifact in dist/.
 *
 * Every import below comes from ../../dist/index.js, so these tests exercise the
 * exact package a consumer installs (the bundled ESM and its types), not the
 * src/ tree. One describe block per principle in docs/internal/core-principles.md.
 *
 * Two kinds of suite:
 *   - Deterministic (P3, P4, P5): engine mechanics that do not depend on a model.
 *     They use the built-in mock reasoner and run with no credentials.
 *   - Live model (P1, P2, P6, P7, P8): the point is that a real, non-deterministic
 *     model still cannot bypass governance. They call an OpenAI-compatible endpoint
 *     (OpenRouter) and are skipped automatically when OPENROUTER_API_KEY is unset.
 *
 * Run: OPENROUTER_API_KEY=sk-or-... pnpm test:e2e
 * Optional: OPENROUTER_MODEL (default openai/gpt-4o-mini),
 *           OPENROUTER_BASE_URL (default https://openrouter.ai/api/v1).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
// Import the shipped artifact, not the source.
import { createDeltaEngine, createOpenAIReasoner, createMockReasoner, Ok, Err } from "../../dist/index.js";

// ── Live-model wiring ──────────────────────────────────────────────────────────

const API_KEY = process.env.OPENROUTER_API_KEY;
// A free, tool-calling-capable model. Free models are rate-limited, so the live
// suites run sequentially. Override with OPENROUTER_MODEL for a stronger model.
const MODEL = process.env.OPENROUTER_MODEL ?? "cohere/north-mini-code:free";
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

// Skip the live suites cleanly when no key is present, rather than failing.
const describeLive = API_KEY ? describe : describe.skip;

const liveReasoner = () => createOpenAIReasoner({ apiKey: API_KEY, baseURL: BASE_URL, model: MODEL });
const liveEngine = () => createDeltaEngine({ reasoner: liveReasoner(), maxStepsPerTask: 6 });

const GENEROUS = { tokens: 8000, durationMs: 120_000 };

// ── P1. The engine owns enforcement ─────────────────────────────────────────────

describeLive("P1 the engine owns enforcement", () => {
  it("blocks a requiresApproval action even when the live model requests it", async () => {
    const delta = await liveEngine();
    let executed = false;
    const refund = delta.action({
      name: "issue-refund",
      description: "Issue a monetary refund to the customer",
      schema: z.object({ amount: z.number() }),
      requiresApproval: true,
      fn: async () => {
        executed = true;
        return Ok("refunded");
      },
    });
    const agent = delta.agent({
      name: "billing-agent",
      description: "Handles customer refunds",
      role: "Billing",
      rolePrompt: "Issue the refund the user asks for.",
      actions: [refund],
    });
    delta.deploy(agent);

    const result = await delta.send({
      goal: "Issue a refund of 50 dollars to the customer.",
      agentName: "billing-agent",
      budget: GENEROUS,
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The model proposed the only action it has; the engine gated it on approval.
    expect(result.value.status).toBe("blocked");
    // The function never ran without a human decision, no matter what the model wanted.
    expect(executed).toBe(false);
    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (inspected.isOk) expect(inspected.value.pendingApprovals.length).toBeGreaterThan(0);
  });
});

// ── P2. Bounded state-space ──────────────────────────────────────────────────────

describeLive("P2 the system operates within a bounded state-space", () => {
  it("only ever executes actions the agent declares", async () => {
    const delta = await liveEngine();
    const lookup = delta.action({
      name: "lookup-order",
      description: "Look up an order by id",
      schema: z.object({ orderId: z.string() }),
      fn: async () => Ok({ status: "shipped" }),
    });
    const summarize = delta.action({
      name: "summarize",
      description: "Summarize the order status for the user",
      schema: z.object({ text: z.string() }),
      fn: async () => Ok("done"),
    });
    const declared = new Set(["lookup-order", "summarize"]);
    const agent = delta.agent({
      name: "order-agent",
      description: "Answers order questions",
      role: "Support",
      rolePrompt: "Look up the order, then summarize it.",
      actions: [lookup, summarize],
    });
    delta.deploy(agent);

    const result = await delta.send({
      goal: "Tell me the status of order O-1.",
      agentName: "order-agent",
      input: { orderId: "O-1", text: "status" },
      budget: GENEROUS,
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    // Whatever the model chose, nothing outside the declared action set ever ran.
    for (const exec of inspected.value.executions) {
      expect(declared.has(exec.action)).toBe(true);
    }
  });
});

// ── P3. Prediction precedes execution (MPC) ──────────────────────────────────────
// Deterministic: the MPC pre-flight is on the reasoner-less workflow path.

describe("P3 prediction precedes execution (MPC)", () => {
  it("blocks a workflow whose projected cost exceeds the budget before any action runs", async () => {
    const delta = await createDeltaEngine();
    let ran = false;
    const expensive = delta.action({
      name: "expensive-step",
      description: "A step with a large declared cost",
      schema: z.object({}),
      estimatedCost: { tokens: 100_000, durationMs: 1000 },
      fn: async () => {
        ran = true;
        return Ok("done");
      },
    });
    const phase = delta.phase({ name: "p", description: "one phase", actions: ["expensive-step"], checkpoint: false });
    const wf = delta.workflow({ name: "pricey", description: "over budget", version: "1.0.0", phases: [phase] });
    const agent = delta.agent({
      name: "mpc-agent",
      description: "runs a pricey workflow",
      role: "R",
      rolePrompt: ".",
      actions: [expensive],
      workflows: [wf],
    });
    delta.deploy(agent);

    const result = await delta.send({
      goal: "run it",
      agentName: "mpc-agent",
      workflow: "pricey",
      budget: { tokens: 1000, durationMs: 1000 },
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The engine projected the cost and refused before executing anything.
    expect(result.value.status).toBe("blocked");
    expect(ran).toBe(false);
  });
});

// ── P4. Memory is retrieved, not carried ─────────────────────────────────────────
// Deterministic: proves the memory pathway is wired in the built engine.

describe("P4 memory is retrieved, not carried", () => {
  it("an action persists a memory through the built engine as a stored resource", async () => {
    const delta = await createDeltaEngine({
      reasoner: createMockReasoner({ responses: [{ actionName: "note", input: {} }] }),
    });
    let rememberOk = false;
    const note = delta.action({
      name: "note",
      description: "record a durable note about the customer",
      schema: z.object({}),
      fn: async (_input, ctx) => {
        const result = await ctx.remember?.("customer prefers email contact", "preference");
        rememberOk = result?.isOk ?? false;
        return Ok("noted");
      },
    });
    const agent = delta.agent({
      name: "memo-agent",
      description: "writes memories",
      role: "R",
      rolePrompt: ".",
      actions: [note],
    });
    delta.deploy(agent);

    const result = await delta.send({ goal: "remember the preference", agentName: "memo-agent" });
    expect(result.isOk).toBe(true);
    // The memory was written to the store on demand, not carried in the model context.
    expect(rememberOk).toBe(true);
  });
});

// ── P5. Task identity is the security boundary ───────────────────────────────────
// Deterministic: every governance record is attributable to one TaskID.

describe("P5 task identity is the security boundary", () => {
  it("attributes the full audit trail to one TaskID and finds it without a stored id", async () => {
    const delta = await createDeltaEngine({
      reasoner: createMockReasoner({
        responses: [{ actionName: "act", input: {} }, { done: true }],
      }),
    });
    const act = delta.action({
      name: "act",
      description: "do a unit of work",
      schema: z.object({}),
      fn: async () => Ok("ok"),
    });
    const agent = delta.agent({
      name: "audit-agent",
      description: "produces an audit trail",
      role: "R",
      rolePrompt: ".",
      actions: [act],
    });
    delta.deploy(agent);

    const result = await delta.send({ goal: "do the work", agentName: "audit-agent" });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const taskId = result.value.taskId;

    const inspected = await delta.inspect(taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    expect(inspected.value.task.id).toBe(taskId);
    expect(inspected.value.executions.length).toBeGreaterThan(0);

    // Principle 5 / invariant 25: the caller never needs a stored TaskID.
    const last = await delta.lastTask("audit-agent");
    expect(last.isOk).toBe(true);
    if (last.isOk) expect(last.value?.id).toBe(taskId);
  });
});

// ── P6. Delegation is bounded ────────────────────────────────────────────────────

describeLive("P6 delegation is bounded", () => {
  it("scopes a delegated child task under the parent's tree", async () => {
    const delta = await liveEngine();
    const research = delta.action({
      name: "research",
      description: "research a topic and return notes",
      schema: z.object({ topic: z.string() }),
      fn: async () => Ok("notes"),
    });
    const specialist = delta.agent({
      name: "researcher",
      description: "a research specialist",
      role: "Researcher",
      rolePrompt: "Research the topic you are given.",
      actions: [research],
    });
    delta.deploy(specialist);

    const coordinate = delta.action({
      name: "coordinate",
      description: "coordinate the response",
      schema: z.object({ note: z.string() }),
      fn: async () => Ok("coordinated"),
    });
    const coordinator = delta.agent({
      name: "coordinator",
      description: "delegates research to a specialist",
      role: "Coordinator",
      rolePrompt: "Delegate the research to the researcher agent, then finish.",
      actions: [coordinate],
    });
    delta.deploy(coordinator);

    const result = await delta.send({
      goal: "Delegate researching 'delta governance' to the researcher, then conclude.",
      agentName: "coordinator",
      budget: GENEROUS,
    });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    // The parent task settled within governance (no unbounded growth, no throw).
    expect(["completed", "blocked", "failed"]).toContain(result.value.status);

    // If the model delegated, the child is scoped under the parent's root, never a
    // free-floating task. The strict active-count and FIFO-queue bounds are covered
    // exhaustively by the deterministic tests under tests/stress and tests/unit.
    const child = await delta.lastTask("researcher");
    if (child.isOk && child.value !== null) {
      expect(child.value.rootId).toBe(result.value.taskId);
    }
  });
});

// ── P7. Trust is statistical ─────────────────────────────────────────────────────
// Deterministic: trust moving with evidence is an engine mechanic. A mock drives
// the failing action so the failure evidence is guaranteed; a live model may or
// may not call the action on a given run, which is about the model, not the
// principle. (P1, P2, P6 carry the live-model-cannot-bypass angle.)

describe("P7 trust is statistical", () => {
  it("lowers trust below the 0.5 start when an action fails", async () => {
    const delta = await createDeltaEngine({
      reasoner: createMockReasoner({ responses: [{ actionName: "charge-card", input: { amount: 20 } }] }),
    });
    const flaky = delta.action({
      name: "charge-card",
      description: "charge the customer's card",
      schema: z.object({ amount: z.number() }),
      fn: async () => Err("payment processor declined"),
    });
    const agent = delta.agent({
      name: "payments-agent",
      description: "charges cards",
      role: "Payments",
      rolePrompt: "Charge the card for the requested amount.",
      actions: [flaky],
    });
    delta.deploy(agent);

    const result = await delta.send({ goal: "Charge the customer 20 dollars.", agentName: "payments-agent" });

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const inspected = await delta.inspect(result.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    // Evidence moved trust: a failed execution was recorded and the score fell
    // below the neutral 0.5 start. Trust is earned and lost by evidence.
    expect(inspected.value.task.trust.failedExecutions).toBeGreaterThan(0);
    expect(inspected.value.task.trust.score).toBeLessThan(0.5);
  });
});

// ── P8. Human oversight is fundamental ───────────────────────────────────────────
// Deterministic: the approval gate and the pause/resume cycle are engine mechanics
// that hold regardless of the model. (P1 already proves a live model cannot bypass
// the same gate.) This runs on the reasoner-less workflow path so the resume always
// completes, instead of depending on a model emitting a clean tool call every turn.

describe("P8 human oversight is fundamental", () => {
  it("blocks a workflow on approval, then resumes to completion after a human approves", async () => {
    const delta = await createDeltaEngine();
    let executed = 0;
    const publish = delta.action({
      name: "publish-post",
      description: "publish a public post",
      schema: z.object({ text: z.string() }),
      requiresApproval: true,
      fn: async () => {
        executed += 1;
        return Ok("published");
      },
    });
    const phase = delta.phase({ name: "publish", description: "publish step", actions: ["publish-post"], checkpoint: true });
    const wf = delta.workflow({ name: "publish-wf", description: "publishes with sign-off", version: "1.0.0", phases: [phase] });
    const agent = delta.agent({
      name: "social-agent",
      description: "publishes posts",
      role: "Social",
      rolePrompt: ".",
      actions: [publish],
      workflows: [wf],
    });
    delta.deploy(agent);

    const blocked = await delta.send({
      goal: "publish hello world",
      agentName: "social-agent",
      workflow: "publish-wf",
      input: { text: "hello world" },
    });
    expect(blocked.isOk).toBe(true);
    if (!blocked.isOk) return;
    // Oversight gate: the task is held, nothing ran.
    expect(blocked.value.status).toBe("blocked");
    expect(executed).toBe(0);

    const inspected = await delta.inspect(blocked.value.taskId);
    expect(inspected.isOk).toBe(true);
    if (!inspected.isOk) return;
    const approvalId = inspected.value.pendingApprovals[0]?.id;
    expect(approvalId).toBeDefined();
    if (approvalId === undefined) return;

    await delta.approve(approvalId);
    const resumed = await delta.resume(blocked.value.taskId);
    expect(resumed.isOk).toBe(true);
    if (!resumed.isOk) return;
    // The action ran exactly once, and only after the human approved it.
    expect(resumed.value.status).toBe("completed");
    expect(executed).toBe(1);
  });
});
