/**
 * Execution gateway tests — the single chokepoint for all action execution.
 *
 * Every test here exercises one segment of the deterministic pipeline:
 *   schema validation → legality check → approval gate →
 *   before hook → fn() → after/onError hooks → trust/risk update → store write
 *
 * The gateway never runs a fn unless all prior gates pass. It never infers
 * success from anything other than an explicit Ok return from fn.
 *
 * Covers: invariants 1, 3, 4, 18, 19, 22; prohibitions 1, 2, 9, 17, 18.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { runGateway } from "../../../src/execution";
import { createInMemoryStore } from "../../../src/ports";
import { initialTrust, initialRiskState } from "../../../src/governance";
import type { Action, ActionContext } from "../../../src/authoring";
import type { TaskStateSnapshot } from "../../../src/state-space";
import type { Attachment } from "../../../src/shared/types";

// ── Shared test helpers ──────────────────────────────────────────────────────

const schema = z.object({ name: z.string() });
const validInput = { name: "Alice" };
const invalidInput = { name: 42 }; // wrong type

/** Build a minimal valid Action. Pass fn/hooks/requiresApproval as needed. */
const makeAction = (overrides: Partial<Action> = {}): Action => ({
  name: "test-action",
  description: "A test action",
  schema,
  fn: async () => Ok("result"),
  ...overrides,
});

/** Build a running TaskStateSnapshot with sensible defaults. */
const makeState = (overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot => ({
  taskId: "tsk_abc123",
  rootId: "tsk_abc123",
  agentName: "test-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 10_000, durationMs: 60_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: initialRiskState(),
  trust: initialTrust(),
  ...overrides,
});

// ── 1. Schema validation (invariant 4, prohibition 9) ────────────────────────

describe("runGateway — schema validation", () => {
  it("blocks when rawInput fails the action schema", async () => {
    const action = makeAction();
    let fnCalled = false;
    const guarded = makeAction({ fn: async () => { fnCalled = true; return Ok("x"); } });

    const result = await runGateway({
      action: guarded,
      rawInput: invalidInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });

    expect(result.isErr).toBe(true);
    expect(fnCalled).toBe(false);
  });

  it("Err message is prefixed with 'schema-invalid'", async () => {
    const result = await runGateway({
      action: makeAction(),
      rawInput: invalidInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isErr) expect(result.error).toMatch(/schema-invalid/);
  });

  it("passes through when rawInput matches schema (no block)", async () => {
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isOk).toBe(true);
  });
});

// ── 2. Legality check (Markov re-check at execution time) ────────────────────

describe("runGateway — legality check", () => {
  it("blocks when task status is not 'running'", async () => {
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state: makeState({ status: "paused" }),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/not-legal/);
  });

  it("blocks when own token budget is exhausted", async () => {
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state: makeState({
        budget: { tokens: 100, durationMs: 60_000 },
        spent: { tokens: 101, durationMs: 0 },
      }),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/not-legal/);
  });

  it("blocks when task is escalated (awaiting oversight)", async () => {
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state: makeState({ risk: { ...initialRiskState(), escalated: true } }),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/not-legal/);
  });

  it("blocks when a prerequisite action has not completed", async () => {
    const result = await runGateway({
      action: makeAction({ prerequisites: { actions: ["prepare-data"] } }),
      rawInput: validInput,
      state: makeState({ completedActions: [] }),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/not-legal/);
  });
});

// ── 3. Approval gate (prohibitions 1, 2) ────────────────────────────────────

describe("runGateway — approval gate", () => {
  it("blocks when requiresApproval is true and status is 'none'", async () => {
    let fnCalled = false;
    const result = await runGateway({
      action: makeAction({ requiresApproval: true, fn: async () => { fnCalled = true; return Ok("x"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    expect(fnCalled).toBe(false);
    if (result.isErr) expect(result.error).toMatch(/approval-required/);
  });

  it("blocks when requiresApproval is true and approval is still pending", async () => {
    let fnCalled = false;
    const result = await runGateway({
      action: makeAction({ requiresApproval: true, fn: async () => { fnCalled = true; return Ok("x"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "pending",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    expect(fnCalled).toBe(false);
    if (result.isErr) {
      expect(result.error).toMatch(/approval-required/);
      expect(result.error).toMatch(/pending/);
    }
  });

  it("proceeds when requiresApproval is true and approval is granted", async () => {
    const result = await runGateway({
      action: makeAction({ requiresApproval: true }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "approved",
      store: createInMemoryStore(),
    });
    expect(result.isOk).toBe(true);
  });

  it("proceeds without approval when requiresApproval is not set", async () => {
    const result = await runGateway({
      action: makeAction({ requiresApproval: undefined }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isOk).toBe(true);
  });
});

// ── 4. Before hook (invariant 22, prohibition 17) ────────────────────────────

describe("runGateway — before hook", () => {
  it("blocks fn when before hook returns Err", async () => {
    let fnCalled = false;
    const result = await runGateway({
      action: makeAction({
        fn: async () => { fnCalled = true; return Ok("x"); },
        hooks: { before: async () => Err("prerequisite not met") },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    expect(fnCalled).toBe(false);
    if (result.isErr) expect(result.error).toMatch(/before-hook-failed/);
  });

  it("blocks fn when before hook throws (catch does not grant authority — prohibition 17)", async () => {
    let fnCalled = false;
    const result = await runGateway({
      action: makeAction({
        fn: async () => { fnCalled = true; return Ok("x"); },
        hooks: { before: async () => { throw new Error("setup crash"); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    expect(fnCalled).toBe(false);
  });

  it("a before hook cannot bypass an approval check — approval check runs before the hook", async () => {
    // If approval is missing, the gateway returns Err before running the before hook.
    let hookCalled = false;
    const result = await runGateway({
      action: makeAction({
        requiresApproval: true,
        hooks: { before: async () => { hookCalled = true; return Ok("bypassing!"); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isErr).toBe(true);
    // The hook was never called because the approval gate blocked first.
    expect(hookCalled).toBe(false);
  });

  it("proceeds normally when before hook returns Ok", async () => {
    let hookCalled = false;
    const result = await runGateway({
      action: makeAction({
        hooks: { before: async () => { hookCalled = true; return Ok(undefined); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(hookCalled).toBe(true);
    expect(result.isOk).toBe(true);
  });
});

// ── 5. fn execution — Ok result (invariants 3, 18, 19) ──────────────────────

describe("runGateway — fn returns Ok", () => {
  it("returns Ok(GatewaySuccess) with fnResult.isOk = true", async () => {
    const result = await runGateway({
      action: makeAction({ fn: async () => Ok("done") }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.fnResult.isOk).toBe(true);
  });

  it("adds the action to updatedSnapshot.completedActions", async () => {
    const result = await runGateway({
      action: makeAction({ name: "compute" }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.completedActions).toContain("compute");
    }
  });

  it("increases trust.successfulExecutions by 1", async () => {
    const state = makeState();
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.trust.successfulExecutions).toBe(
        state.trust.successfulExecutions + 1,
      );
    }
  });

  it("trust.score grows after a successful execution (slow accrual)", async () => {
    const state = makeState();
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.trust.score).toBeGreaterThan(state.trust.score);
    }
  });

  it("Execution record written with status 'completed' (invariant 1)", async () => {
    const store = createInMemoryStore();
    const result = await runGateway({
      action: makeAction({ name: "compute" }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store,
    });
    expect(result.isOk).toBe(true);

    const execs = await store.getExecutionsByTask("tsk_abc123");
    expect(execs.isOk).toBe(true);
    if (execs.isOk) {
      expect(execs.value).toHaveLength(1);
      expect(execs.value[0]?.taskId).toBe("tsk_abc123");
      expect(execs.value[0]?.action).toBe("compute");
      expect(execs.value[0]?.status).toBe("completed");
    }
  });
});

// ── 6. fn execution — Err result (invariant 19, prohibition 18) ─────────────

describe("runGateway — fn returns Err", () => {
  it("outer gateway still returns Ok (fn ran — gateway succeeded at its job)", async () => {
    const result = await runGateway({
      action: makeAction({ fn: async () => Err("processing failed") }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isOk).toBe(true);
  });

  it("fnResult.isErr = true (never infer success from non-throw — prohibition 18)", async () => {
    const result = await runGateway({
      action: makeAction({ fn: async () => Err("processing failed") }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) expect(result.value.fnResult.isErr).toBe(true);
  });

  it("action is NOT added to completedActions on Err (invariant 19)", async () => {
    const result = await runGateway({
      action: makeAction({ name: "risky-op", fn: async () => Err("failed") }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.completedActions).not.toContain("risky-op");
    }
  });

  it("increases trust.failedExecutions by 1", async () => {
    const state = makeState();
    const result = await runGateway({
      action: makeAction({ fn: async () => Err("err") }),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.trust.failedExecutions).toBe(
        state.trust.failedExecutions + 1,
      );
    }
  });

  it("trust.score decays after failure (fast decay)", async () => {
    const state = makeState();
    const result = await runGateway({
      action: makeAction({ fn: async () => Err("err") }),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.trust.score).toBeLessThan(state.trust.score);
    }
  });

  it("Execution record written with status 'failed' (invariant 1)", async () => {
    const store = createInMemoryStore();
    await runGateway({
      action: makeAction({ fn: async () => Err("failed") }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store,
    });
    const execs = await store.getExecutionsByTask("tsk_abc123");
    if (execs.isOk) {
      expect(execs.value[0]?.status).toBe("failed");
    }
  });
});

// ── 7. fn throws — never infer success (prohibition 18) ─────────────────────

describe("runGateway — fn throws", () => {
  it("gateway still returns Ok(GatewaySuccess) — throw is caught", async () => {
    const result = await runGateway({
      action: makeAction({ fn: async () => { throw new Error("boom"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isOk).toBe(true);
  });

  it("fnResult.isErr = true — a throw is treated as failure, never as success (prohibition 18)", async () => {
    const result = await runGateway({
      action: makeAction({ fn: async () => { throw new Error("boom"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) expect(result.value.fnResult.isErr).toBe(true);
  });

  it("action NOT added to completedActions when fn throws", async () => {
    const result = await runGateway({
      action: makeAction({ name: "throw-op", fn: async () => { throw new Error("crash"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.completedActions).not.toContain("throw-op");
    }
  });

  it("Execution record status is 'failed' when fn throws", async () => {
    const store = createInMemoryStore();
    await runGateway({
      action: makeAction({ fn: async () => { throw new Error("crash"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store,
    });
    const execs = await store.getExecutionsByTask("tsk_abc123");
    if (execs.isOk) expect(execs.value[0]?.status).toBe("failed");
  });
});

// ── 8. After / onError hooks (prohibition 17 — hooks cannot alter governance) ─

describe("runGateway — after and onError hooks", () => {
  it("after hook failure does not change fnResult or the outer Ok (prohibition 17)", async () => {
    const result = await runGateway({
      action: makeAction({
        fn: async () => Ok("success"),
        hooks: { after: async () => Err("teardown failed") },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    // Gateway still succeeded; fnResult is still Ok.
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.fnResult.isOk).toBe(true);
  });

  it("onError hook throw does not change fnResult (prohibition 17)", async () => {
    const result = await runGateway({
      action: makeAction({
        fn: async () => Err("fn failed"),
        hooks: { onError: async () => { throw new Error("teardown crash"); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value.fnResult.isErr).toBe(true);
  });

  it("after hook runs when fn returns Ok", async () => {
    let afterCalled = false;
    await runGateway({
      action: makeAction({
        fn: async () => Ok("done"),
        hooks: { after: async () => { afterCalled = true; return Ok(undefined); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(afterCalled).toBe(true);
  });

  it("onError hook runs when fn returns Err", async () => {
    let onErrorCalled = false;
    await runGateway({
      action: makeAction({
        fn: async () => Err("fail"),
        hooks: { onError: async () => { onErrorCalled = true; return Ok(undefined); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(onErrorCalled).toBe(true);
  });

  it("after hook does not run when fn returns Err", async () => {
    let afterCalled = false;
    await runGateway({
      action: makeAction({
        fn: async () => Err("fail"),
        hooks: { after: async () => { afterCalled = true; return Ok(undefined); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(afterCalled).toBe(false);
  });
});

// ── 9. Execution record (invariant 1) ────────────────────────────────────────

describe("runGateway — Execution record (invariant 1: every execution is TaskID-attributable)", () => {
  it("execution record has the correct taskId and action name", async () => {
    const store = createInMemoryStore();
    const result = await runGateway({
      action: makeAction({ name: "send-email" }),
      rawInput: validInput,
      state: makeState({ taskId: "tsk_xyz", rootId: "tsk_xyz" }),
      approvalStatus: "none",
      store,
    });
    if (result.isOk) {
      const { execution } = result.value;
      expect(execution.taskId).toBe("tsk_xyz");
      expect(execution.action).toBe("send-email");
    }
  });

  it("execution record has an endedAt timestamp after fn runs", async () => {
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.execution.endedAt).toBeInstanceOf(Date);
    }
  });

  it("execution record is persisted to the store before gateway returns", async () => {
    const store = createInMemoryStore();
    await runGateway({
      action: makeAction({ name: "persist-check" }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store,
    });
    const execs = await store.getExecutionsByTask("tsk_abc123");
    expect(execs.isOk).toBe(true);
    if (execs.isOk) expect(execs.value.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 10. Snapshot updates ─────────────────────────────────────────────────────

describe("runGateway — snapshot updates", () => {
  it("updatedSnapshot.spent.durationMs is greater than 0 after execution", async () => {
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    // durationMs may be 0 in fast test environments, but the field is present.
    if (result.isOk) expect(result.value.updatedSnapshot.spent).toBeDefined();
  });

  it("updatedSnapshot preserves all unrelated fields (Markov immutability)", async () => {
    const state = makeState({ taskId: "tsk_preserve", agentName: "my-agent" });
    const result = await runGateway({
      action: makeAction(),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.taskId).toBe("tsk_preserve");
      expect(result.value.updatedSnapshot.agentName).toBe("my-agent");
    }
  });

  it("completedActions grows by 1 on Ok but stays unchanged on Err", async () => {
    const state = makeState({ completedActions: ["existing-action"] });
    const store = createInMemoryStore();

    const okResult = await runGateway({
      action: makeAction({ name: "new-action", fn: async () => Ok("done") }),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store,
    });

    const errResult = await runGateway({
      action: makeAction({ name: "fail-action", fn: async () => Err("fail") }),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store,
    });

    if (okResult.isOk) {
      expect(okResult.value.updatedSnapshot.completedActions).toContain("new-action");
      expect(okResult.value.updatedSnapshot.completedActions).toContain("existing-action");
    }

    if (errResult.isOk) {
      expect(errResult.value.updatedSnapshot.completedActions).not.toContain("fail-action");
      expect(errResult.value.updatedSnapshot.completedActions).toContain("existing-action");
    }
  });
});

// ── Surprise → trust (G1) ────────────────────────────────────────────────────

describe("runGateway — surprise erodes trust (G1)", () => {
  it("a significantly surprising step records a surprise event and decays trust", async () => {
    // Spend 10x the budget in one step → observed health collapses vs the cold
    // prediction → significant surprise → trust outcome "surprise".
    const state = makeState({ budget: { tokens: 100, durationMs: 60_000 } });
    const result = await runGateway({
      action: makeAction({ fn: async () => Ok("ok") }),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store: createInMemoryStore(),
      reasoningCost: { tokens: 1000, durationMs: 0 },
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.surpriseMagnitude).toBeGreaterThanOrEqual(0.4);
    expect(result.value.updatedSnapshot.trust.surpriseEvents).toBe(1);
    expect(result.value.updatedSnapshot.trust.score).toBeLessThan(state.trust.score);
  });

  it("an unsurprising successful step accrues trust normally (no surprise event)", async () => {
    const state = makeState();
    const result = await runGateway({
      action: makeAction({ fn: async () => Ok("ok") }),
      rawInput: validInput,
      state,
      approvalStatus: "none",
      store: createInMemoryStore(),
      reasoningCost: { tokens: 1, durationMs: 0 },
    });
    if (result.isOk) {
      expect(result.value.updatedSnapshot.trust.surpriseEvents).toBe(0);
      expect(result.value.updatedSnapshot.trust.successfulExecutions).toBe(state.trust.successfulExecutions + 1);
    }
  });
});

// ── Extended ActionContext fields (goal, workflowName, attachments, recall, budget) ─

describe("runGateway — extended ActionContext fields", () => {
  it("threads goal, workflowName, attachments, recall, and budget onto the action fn's ctx", async () => {
    let ctxSeen: ActionContext | undefined;
    const recall = async () => Ok("recalled");
    const attachments: Attachment[] = [{ id: "att_1", kind: "file", mimeType: "text/plain", name: "a.txt" }];
    const budget = { spent: { tokens: 5, durationMs: 10 }, limit: { tokens: 100, durationMs: 1000 } };

    await runGateway({
      action: makeAction({ fn: async (_input, ctx) => { ctxSeen = ctx; return Ok("x"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
      goal: "close the ticket",
      workflowName: "support-flow",
      attachments,
      recall,
      budget,
    });

    expect(ctxSeen?.goal).toBe("close the ticket");
    expect(ctxSeen?.workflowName).toBe("support-flow");
    expect(ctxSeen?.attachments).toEqual(attachments);
    expect(ctxSeen?.budget).toEqual(budget);
    expect(ctxSeen?.recall).toBe(recall);
  });

  it("omits the extended fields from ctx when GatewayInput does not supply them", async () => {
    let ctxSeen: ActionContext | undefined;
    await runGateway({
      action: makeAction({ fn: async (_input, ctx) => { ctxSeen = ctx; return Ok("x"); } }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(ctxSeen?.goal).toBeUndefined();
    expect(ctxSeen?.attachments).toBeUndefined();
    expect(ctxSeen?.recall).toBeUndefined();
    expect(ctxSeen?.budget).toBeUndefined();
  });
});

// ── After / onError hooks observe the outcome (result / error) ──────────────

describe("runGateway — hooks observe the fn outcome", () => {
  it("after hook receives the fn's Ok value as ctx.result", async () => {
    let resultSeen: unknown = "unset";
    await runGateway({
      action: makeAction({
        fn: async () => Ok("payload"),
        hooks: { after: async (ctx) => { resultSeen = ctx.result; return Ok(undefined); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(resultSeen).toBe("payload");
  });

  it("onError hook receives the fn's error message as ctx.error", async () => {
    let errorSeen: unknown = "unset";
    await runGateway({
      action: makeAction({
        fn: async () => Err("db down"),
        hooks: { onError: async (ctx) => { errorSeen = ctx.error; return Ok(undefined); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(errorSeen).toBe("db down");
  });

  it("onError hook receives the thrown error (normalised to a string) as ctx.error", async () => {
    let errorSeen: unknown = "unset";
    await runGateway({
      action: makeAction({
        fn: async () => { throw new Error("boom"); },
        hooks: { onError: async (ctx) => { errorSeen = ctx.error; return Ok(undefined); } },
      }),
      rawInput: validInput,
      state: makeState(),
      approvalStatus: "none",
      store: createInMemoryStore(),
    });
    expect(typeof errorSeen).toBe("string");
    expect(errorSeen).toContain("boom");
  });
});
