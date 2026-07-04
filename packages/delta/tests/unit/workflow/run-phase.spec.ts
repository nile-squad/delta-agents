/**
 * runPhase tests — sequential + branching execution with checkpoints.
 *
 * Every action goes through the gateway; the phase runner just orchestrates
 * which actions to run in which order. Tests here verify the orchestration:
 * order preservation, branch routing, guard evaluation, checkpoint writing,
 * hook lifecycle, and the step limit.
 *
 * Covers: invariant 10 (checkpoint = recoverable state), 21, prohibition 19.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { runPhase } from "../../../src/workflow";
import { createInMemoryStore } from "../../../src/ports";
import { initialTrust, initialRiskState } from "../../../src/governance";
import type { Action, Phase, ActionRef } from "../../../src/authoring";
import type { TaskStateSnapshot } from "../../../src/state-space";

// ── Shared helpers ────────────────────────────────────────────────────────────

const emptySchema = z.object({});

const makeAction = (name: string, fn: Action["fn"] = async () => Ok("ok")): Action => ({
  name,
  description: `${name} action`,
  schema: emptySchema,
  fn,
});

const makeState = (overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot => ({
  taskId: "tsk_phase_test",
  rootId: "tsk_phase_test",
  agentName: "test-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 100_000, durationMs: 300_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: initialRiskState(),
  trust: initialTrust(),
  ...overrides,
});

const makePhase = (
  name: string,
  actions: ActionRef[],
  overrides: Partial<Phase> = {},
): Phase => ({
  name,
  description: `${name} phase`,
  actions,
  checkpoint: false,
  ...overrides,
});

const alwaysNone = () => "none" as const;
const alwaysEmpty = () => ({});

// ── Sequential execution ──────────────────────────────────────────────────────

describe("runPhase — sequential execution", () => {
  it("runs all actions in declared order and returns completed", async () => {
    const order: string[] = [];
    const reg = new Map([
      ["step-a", makeAction("step-a", async () => { order.push("a"); return Ok("a"); })],
      ["step-b", makeAction("step-b", async () => { order.push("b"); return Ok("b"); })],
      ["step-c", makeAction("step-c", async () => { order.push("c"); return Ok("c"); })],
    ]);

    const result = await runPhase({
      phase: makePhase("seq", ["step-a", "step-b", "step-c"]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("all Ok actions appear in completedActions of the final snapshot", async () => {
    const reg = new Map([
      ["lookup", makeAction("lookup")],
      ["process", makeAction("process")],
    ]);

    const result = await runPhase({
      phase: makePhase("seq", ["lookup", "process"]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    if (result.status === "completed") {
      expect(result.snapshot.completedActions).toContain("lookup");
      expect(result.snapshot.completedActions).toContain("process");
    }
  });

  it("stops on first Err action and returns failed with the action name", async () => {
    const order: string[] = [];
    const reg = new Map([
      ["step-a", makeAction("step-a", async () => { order.push("a"); return Ok("a"); })],
      ["step-b", makeAction("step-b", async () => { order.push("b"); return Err("step-b failed"); })],
      ["step-c", makeAction("step-c", async () => { order.push("c"); return Ok("c"); })],
    ]);

    const result = await runPhase({
      phase: makePhase("fail-mid", ["step-a", "step-b", "step-c"]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    expect(order).toEqual(["a", "b"]); // step-c never ran
    if (result.status === "failed") {
      expect(result.failedAction).toBe("step-b");
    }
  });

  it("failed action is NOT in completedActions (invariant 19)", async () => {
    const reg = new Map([
      ["bad-op", makeAction("bad-op", async () => Err("failed"))],
    ]);

    const result = await runPhase({
      phase: makePhase("fail", ["bad-op"]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.snapshot.completedActions).not.toContain("bad-op");
  });
});

// ── Branching ─────────────────────────────────────────────────────────────────

describe("runPhase — conditional branching", () => {
  it("Ok outcome routes to onSuccess action, not onFailure", async () => {
    const ran: string[] = [];
    const reg = new Map([
      ["verify", makeAction("verify", async () => { ran.push("verify"); return Ok("ok"); })],
      ["fulfill", makeAction("fulfill", async () => { ran.push("fulfill"); return Ok("ok"); })],
      ["notify-fail", makeAction("notify-fail", async () => { ran.push("notify-fail"); return Ok("ok"); })],
    ]);

    const actions: ActionRef[] = [
      { action: "verify", onSuccess: "fulfill", onFailure: "notify-fail" },
      "fulfill",
      "notify-fail",
    ];

    const result = await runPhase({
      phase: makePhase("branch-ok", actions),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(ran).toContain("fulfill");
    expect(ran).not.toContain("notify-fail");
  });

  it("Err outcome routes to onFailure action, not onSuccess", async () => {
    const ran: string[] = [];
    const reg = new Map([
      ["verify", makeAction("verify", async () => { ran.push("verify"); return Err("payment declined"); })],
      ["fulfill", makeAction("fulfill", async () => { ran.push("fulfill"); return Ok("ok"); })],
      ["notify-fail", makeAction("notify-fail", async () => { ran.push("notify-fail"); return Ok("ok"); })],
    ]);

    const actions: ActionRef[] = [
      { action: "verify", onSuccess: "fulfill", onFailure: "notify-fail" },
      "fulfill",
      "notify-fail",
    ];

    const result = await runPhase({
      phase: makePhase("branch-err", actions),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    // notify-fail returned Ok so phase completes, but the path was the failure route.
    expect(ran).toContain("notify-fail");
    expect(ran).not.toContain("fulfill");
  });

  it("Branch with no onSuccess on Ok → phase ends successfully", async () => {
    const reg = new Map([
      ["check", makeAction("check", async () => Ok("ok"))],
    ]);

    const result = await runPhase({
      phase: makePhase("no-success-route", [{ action: "check", onFailure: "handle" }]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
  });

  it("Branch with no onFailure on Err → phase fails with fn error", async () => {
    const reg = new Map([
      ["check", makeAction("check", async () => Err("critical error"))],
    ]);

    const result = await runPhase({
      phase: makePhase("no-failure-route", [{ action: "check", onSuccess: "handle" }]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failedReason).toContain("critical error");
  });

  it("undeclared branch target → end-failure, never jumps to invented index (prohibition 19)", async () => {
    const reg = new Map([
      ["check", makeAction("check", async () => Ok("ok"))],
    ]);

    const result = await runPhase({
      phase: makePhase("undeclared", [{ action: "check", onSuccess: "ghost-action" }]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failedReason).toContain("ghost-action");
      expect(result.failedReason).toMatch(/prohibition 19/i);
    }
  });
});

// ── Branch when-guard ─────────────────────────────────────────────────────────

describe("runPhase — branch when-guard", () => {
  it("guard returns false → branch is skipped, next action in list runs", async () => {
    const ran: string[] = [];
    const reg = new Map([
      ["conditional", makeAction("conditional", async () => { ran.push("conditional"); return Ok("ok"); })],
      ["always", makeAction("always", async () => { ran.push("always"); return Ok("ok"); })],
    ]);

    const actions: ActionRef[] = [
      { action: "conditional", when: () => false, onSuccess: "always" },
      "always",
    ];

    const result = await runPhase({
      phase: makePhase("guarded", actions),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(ran).not.toContain("conditional"); // guard was false, branch skipped
    expect(ran).toContain("always");
  });

  it("guard returns true → branch action runs normally", async () => {
    const ran: string[] = [];
    const reg = new Map([
      ["conditional", makeAction("conditional", async () => { ran.push("conditional"); return Ok("ok"); })],
    ]);

    await runPhase({
      phase: makePhase("guarded-true", [{ action: "conditional", when: () => true }]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(ran).toContain("conditional");
  });
});

// ── Checkpoints (invariant 10) ────────────────────────────────────────────────

describe("runPhase — checkpoints (invariant 10: checkpoint = recoverable state)", () => {
  it("writes a checkpoint to the store when phase.checkpoint is true and phase succeeds", async () => {
    const store = createInMemoryStore();
    const reg = new Map([["step", makeAction("step")]]);

    const result = await runPhase({
      phase: makePhase("ckpt-phase", ["step"], { checkpoint: true }),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store,
    });

    expect(result.status).toBe("completed");
    const ckpt = await store.getLatestCheckpoint("tsk_phase_test");
    expect(ckpt.isOk).toBe(true);
    if (ckpt.isOk) {
      expect(ckpt.value).not.toBeNull();
      expect(ckpt.value?.phase).toBe("ckpt-phase");
      expect(ckpt.value?.taskId).toBe("tsk_phase_test");
    }
  });

  it("writes a checkpoint even when phase.checkpoint is false (checkpointing is always-on)", async () => {
    // Without an always-on checkpoint, a later blocked phase would resume from
    // BEFORE this phase and re-execute its side effects. The flag is retained
    // for declaration compatibility only.
    const store = createInMemoryStore();
    const reg = new Map([["step", makeAction("step")]]);

    await runPhase({
      phase: makePhase("no-ckpt", ["step"], { checkpoint: false }),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store,
    });

    const ckpt = await store.getLatestCheckpoint("tsk_phase_test");
    expect(ckpt.isOk).toBe(true);
    if (ckpt.isOk) {
      expect(ckpt.value).not.toBeNull();
      expect(ckpt.value?.phase).toBe("no-ckpt");
    }
  });

  it("does not write a checkpoint when the phase fails", async () => {
    const store = createInMemoryStore();
    const reg = new Map([["bad", makeAction("bad", async () => Err("fail"))]]);

    const result = await runPhase({
      phase: makePhase("fail-ckpt", ["bad"], { checkpoint: true }),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store,
    });

    expect(result.status).toBe("failed");
    const ckpt = await store.getLatestCheckpoint("tsk_phase_test");
    if (ckpt.isOk) expect(ckpt.value).toBeNull();
  });

  it("checkpoint state captures the snapshot at phase completion (recoverable invariant 10)", async () => {
    const store = createInMemoryStore();
    const reg = new Map([["fetch", makeAction("fetch")]]);

    await runPhase({
      phase: makePhase("snap-ckpt", ["fetch"], { checkpoint: true }),
      actionRegistry: reg,
      state: makeState({ taskId: "tsk_ckpt_test", rootId: "tsk_ckpt_test" }),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store,
    });

    const ckpt = await store.getLatestCheckpoint("tsk_ckpt_test");
    if (ckpt.isOk && ckpt.value !== null) {
      expect(ckpt.value.state).toBeDefined();
      expect(typeof ckpt.value.state).toBe("object");
      // The state must contain the taskId so recovery can identify the task.
      expect((ckpt.value.state as Record<string, unknown>)["taskId"]).toBe("tsk_ckpt_test");
    }
  });
});

// ── Phase lifecycle hooks ─────────────────────────────────────────────────────

describe("runPhase — phase hooks", () => {
  it("before hook runs before any actions", async () => {
    const order: string[] = [];
    const reg = new Map([
      ["step", makeAction("step", async () => { order.push("action"); return Ok("ok"); })],
    ]);

    const result = await runPhase({
      phase: makePhase("hook-before", ["step"], {
        hooks: { before: async () => { order.push("before"); return Ok(undefined); } },
      }),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(order.indexOf("before")).toBeLessThan(order.indexOf("action"));
  });

  it("after hook runs when phase succeeds", async () => {
    let afterCalled = false;
    const reg = new Map([["step", makeAction("step")]]);

    const result = await runPhase({
      phase: makePhase("hook-after", ["step"], {
        hooks: { after: async () => { afterCalled = true; return Ok(undefined); } },
      }),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(afterCalled).toBe(true);
  });

  it("onError hook runs when phase fails", async () => {
    let onErrorCalled = false;
    const reg = new Map([["bad", makeAction("bad", async () => Err("fail"))]]);

    const result = await runPhase({
      phase: makePhase("hook-error", ["bad"], {
        hooks: { onError: async () => { onErrorCalled = true; return Ok(undefined); } },
      }),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    expect(onErrorCalled).toBe(true);
  });

  it("before hook Err halts the phase before any actions run", async () => {
    let actionRan = false;
    const reg = new Map([["step", makeAction("step", async () => { actionRan = true; return Ok("ok"); })]]);

    const result = await runPhase({
      phase: makePhase("before-err", ["step"], {
        hooks: { before: async () => Err("setup failed") },
      }),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    expect(actionRan).toBe(false);
    if (result.status === "failed") expect(result.failedReason).toContain("before-hook failed");
  });
});

// ── Step limit ────────────────────────────────────────────────────────────────

describe("runPhase — step limit", () => {
  it("returns failed with a cycle warning when step limit is exceeded", async () => {
    // Build a phase with 101 sequential actions, all succeeding.
    const names = Array.from({ length: 101 }, (_, i) => `step-${i}`);
    const reg = new Map(names.map((n) => [n, makeAction(n)]));

    const result = await runPhase({
      phase: makePhase("too-many", names),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failedReason).toMatch(/step limit/i);
    }
  });
});
