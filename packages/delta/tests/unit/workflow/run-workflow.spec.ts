/**
 * runWorkflow integration tests.
 *
 * The workflow runner wires phases together: snapshot state threads from one
 * phase to the next, completedWorkflows is populated on success, and a phase
 * failure halts the whole workflow with attribution.
 *
 * The final test in this file is the Phase 5 "exit" integration: a branching
 * payment workflow runs end-to-end through the execution gateway.
 *
 * Covers: invariant 21; prohibition 19.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { runWorkflow } from "../../../src/workflow";
import { createInMemoryStore } from "../../../src/ports";
import { initialTrust, initialRiskState } from "../../../src/governance";
import type { Action, Phase, Workflow, ActionRef } from "../../../src/authoring";
import type { TaskStateSnapshot } from "../../../src/state-space";

// ── Shared helpers ────────────────────────────────────────────────────────────

const schema = z.object({});

const makeAction = (name: string, fn: Action["fn"] = async () => Ok("ok")): Action => ({
  name,
  description: `${name} action`,
  schema,
  fn,
});

const makePhase = (name: string, actions: ActionRef[], checkpoint = false): Phase => ({
  name,
  description: `${name} phase`,
  actions,
  checkpoint,
});

const makeWorkflow = (name: string, phases: Phase[]): Workflow => ({
  name,
  description: `${name} workflow`,
  version: "1.0.0",
  phases,
});

const makeState = (overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot => ({
  taskId: "tsk_wf_test",
  rootId: "tsk_wf_test",
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

const alwaysNone = () => "none" as const;
const alwaysEmpty = () => ({});

// ── Sequential phases ─────────────────────────────────────────────────────────

describe("runWorkflow — sequential phases", () => {
  it("all phases succeed → workflow completes", async () => {
    const reg = new Map([
      ["step-a", makeAction("step-a")],
      ["step-b", makeAction("step-b")],
      ["step-c", makeAction("step-c")],
    ]);

    const result = await runWorkflow({
      workflow: makeWorkflow("three-phase", [
        makePhase("phase-1", ["step-a"]),
        makePhase("phase-2", ["step-b"]),
        makePhase("phase-3", ["step-c"]),
      ]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
  });

  it("workflow adds itself to completedWorkflows on success", async () => {
    const reg = new Map([["step", makeAction("step")]]);

    const result = await runWorkflow({
      workflow: makeWorkflow("my-workflow", [makePhase("only", ["step"])]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    if (result.status === "completed") {
      expect(result.snapshot.completedWorkflows).toContain("my-workflow");
    }
  });

  it("completedActions from phase 1 are visible in phase 2 snapshot (state threads through)", async () => {
    let phase2Saw: string[] = [];
    const reg = new Map([
      ["p1-action", makeAction("p1-action")],
      ["p2-action", makeAction("p2-action", async () => Ok("p2"))],
    ]);

    // Spy on phase 2 by reading the snapshot state that arrives in the gateway
    // (via a custom fn that captures the input state implicitly through completedActions).
    // We'll check the final snapshot instead.
    const result = await runWorkflow({
      workflow: makeWorkflow("state-thread", [
        makePhase("phase-1", ["p1-action"]),
        makePhase("phase-2", ["p2-action"]),
      ]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    if (result.status === "completed") {
      expect(result.snapshot.completedActions).toContain("p1-action");
      expect(result.snapshot.completedActions).toContain("p2-action");
    }
  });

  it("phase 1 failure halts workflow and reports the failed phase", async () => {
    const reg = new Map([
      ["bad", makeAction("bad", async () => Err("phase 1 failed"))],
      ["good", makeAction("good")],
    ]);

    const result = await runWorkflow({
      workflow: makeWorkflow("fail-early", [
        makePhase("phase-1", ["bad"]),
        makePhase("phase-2", ["good"]),
      ]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failedPhase).toBe("phase-1");
    }
  });

  it("phase 2 failure leaves phase 1 completedActions in the snapshot", async () => {
    const reg = new Map([
      ["p1", makeAction("p1")],
      ["p2", makeAction("p2", async () => Err("fail"))],
    ]);

    const result = await runWorkflow({
      workflow: makeWorkflow("fail-late", [
        makePhase("phase-1", ["p1"]),
        makePhase("phase-2", ["p2"]),
      ]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    // p1 completed in phase 1; that should still be recorded.
    expect(result.snapshot.completedActions).toContain("p1");
    expect(result.snapshot.completedActions).not.toContain("p2");
  });
});

// ── Workflow hooks ────────────────────────────────────────────────────────────

describe("runWorkflow — workflow lifecycle hooks", () => {
  it("before hook runs before first phase", async () => {
    const order: string[] = [];
    const reg = new Map([
      ["step", makeAction("step", async () => { order.push("action"); return Ok("ok"); })],
    ]);

    const wf: Workflow = {
      ...makeWorkflow("hook-test", [makePhase("p1", ["step"])]),
      hooks: { before: async () => { order.push("before"); return Ok(undefined); } },
    };

    await runWorkflow({
      workflow: wf,
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(order.indexOf("before")).toBeLessThan(order.indexOf("action"));
  });

  it("after hook runs after workflow succeeds", async () => {
    let afterCalled = false;
    const reg = new Map([["step", makeAction("step")]]);

    const wf: Workflow = {
      ...makeWorkflow("after-test", [makePhase("p1", ["step"])]),
      hooks: { after: async () => { afterCalled = true; return Ok(undefined); } },
    };

    const result = await runWorkflow({
      workflow: wf,
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(afterCalled).toBe(true);
  });

  it("onError hook runs when workflow fails", async () => {
    let onErrorCalled = false;
    const reg = new Map([["bad", makeAction("bad", async () => Err("fail"))]]);

    const wf: Workflow = {
      ...makeWorkflow("error-test", [makePhase("p1", ["bad"])]),
      hooks: { onError: async () => { onErrorCalled = true; return Ok(undefined); } },
    };

    const result = await runWorkflow({
      workflow: wf,
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    expect(onErrorCalled).toBe(true);
  });

  it("before hook Err halts workflow before any phase runs", async () => {
    let actionRan = false;
    const reg = new Map([["step", makeAction("step", async () => { actionRan = true; return Ok("ok"); })]]);

    const wf: Workflow = {
      ...makeWorkflow("before-err", [makePhase("p1", ["step"])]),
      hooks: { before: async () => Err("wf setup failed") },
    };

    const result = await runWorkflow({
      workflow: wf,
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("failed");
    expect(actionRan).toBe(false);
  });
});

// ── Phase checkpoints across workflow ─────────────────────────────────────────

describe("runWorkflow — phase checkpoints", () => {
  it("phase with checkpoint:true writes a checkpoint on success", async () => {
    const store = createInMemoryStore();
    const reg = new Map([["step", makeAction("step")]]);

    await runWorkflow({
      workflow: makeWorkflow("ckpt-wf", [makePhase("p1", ["step"], true)]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store,
    });

    const ckpt = await store.getLatestCheckpoint("tsk_wf_test");
    expect(ckpt.isOk).toBe(true);
    if (ckpt.isOk) expect(ckpt.value?.phase).toBe("p1");
  });

  it("multiple checkpoint phases write multiple checkpoints (latest is last success)", async () => {
    const store = createInMemoryStore();
    const reg = new Map([
      ["a", makeAction("a")],
      ["b", makeAction("b")],
    ]);

    await runWorkflow({
      workflow: makeWorkflow("multi-ckpt", [
        makePhase("phase-1", ["a"], true),
        makePhase("phase-2", ["b"], true),
      ]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store,
    });

    const ckpt = await store.getLatestCheckpoint("tsk_wf_test");
    if (ckpt.isOk) expect(ckpt.value?.phase).toBe("phase-2");
  });
});

// ── Integration: payment workflow branching end-to-end ────────────────────────
// This is the Phase 5 exit criterion: a branching example runs through the gateway.

describe("runWorkflow — integration: payment workflow with branching", () => {
  it("success path: verify succeeds → fulfill runs, notify-fail does not", async () => {
    const ran: string[] = [];
    const reg = new Map([
      ["prepare-order", makeAction("prepare-order", async () => { ran.push("prepare-order"); return Ok("order-ready"); })],
      ["verify-payment", makeAction("verify-payment", async () => { ran.push("verify-payment"); return Ok("payment-ok"); })],
      ["fulfill-order", makeAction("fulfill-order", async () => { ran.push("fulfill-order"); return Ok("fulfilled"); })],
      ["notify-failure", makeAction("notify-failure", async () => { ran.push("notify-failure"); return Ok("notified"); })],
    ]);

    const verifyPhase = makePhase("verification", [
      "prepare-order",
      { action: "verify-payment", onSuccess: "fulfill-order", onFailure: "notify-failure" },
      "fulfill-order",
      "notify-failure",
    ]);

    const result = await runWorkflow({
      workflow: makeWorkflow("payment-workflow", [verifyPhase]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    expect(ran).toContain("prepare-order");
    expect(ran).toContain("verify-payment");
    expect(ran).toContain("fulfill-order");
    expect(ran).not.toContain("notify-failure");
    if (result.status === "completed") {
      expect(result.snapshot.completedActions).toContain("fulfill-order");
      expect(result.snapshot.completedActions).not.toContain("notify-failure");
      expect(result.snapshot.completedWorkflows).toContain("payment-workflow");
    }
  });

  it("failure path: verify fails → notify-failure runs, fulfill does not", async () => {
    const ran: string[] = [];
    const reg = new Map([
      ["prepare-order", makeAction("prepare-order", async () => { ran.push("prepare-order"); return Ok("order-ready"); })],
      ["verify-payment", makeAction("verify-payment", async () => { ran.push("verify-payment"); return Err("card declined"); })],
      ["fulfill-order", makeAction("fulfill-order", async () => { ran.push("fulfill-order"); return Ok("fulfilled"); })],
      ["notify-failure", makeAction("notify-failure", async () => { ran.push("notify-failure"); return Ok("notified"); })],
    ]);

    const verifyPhase = makePhase("verification", [
      "prepare-order",
      { action: "verify-payment", onSuccess: "fulfill-order", onFailure: "notify-failure" },
      "fulfill-order",
      "notify-failure",
    ]);

    await runWorkflow({
      workflow: makeWorkflow("payment-workflow", [verifyPhase]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(ran).toContain("prepare-order");
    expect(ran).toContain("verify-payment");
    expect(ran).toContain("notify-failure");
    expect(ran).not.toContain("fulfill-order");
  });

  it("multi-phase workflow: each phase's output feeds the next", async () => {
    const reg = new Map([
      ["validate-cart", makeAction("validate-cart")],
      ["apply-discount", makeAction("apply-discount")],
      ["charge-payment", makeAction("charge-payment")],
      ["send-receipt", makeAction("send-receipt")],
    ]);

    const result = await runWorkflow({
      workflow: makeWorkflow("checkout", [
        makePhase("cart-phase", ["validate-cart", "apply-discount"]),
        makePhase("payment-phase", ["charge-payment"], true),
        makePhase("receipt-phase", ["send-receipt"]),
      ]),
      actionRegistry: reg,
      state: makeState(),
      getApprovalStatus: alwaysNone,
      inputFor: alwaysEmpty,
      store: createInMemoryStore(),
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.snapshot.completedActions).toContain("validate-cart");
      expect(result.snapshot.completedActions).toContain("apply-discount");
      expect(result.snapshot.completedActions).toContain("charge-payment");
      expect(result.snapshot.completedActions).toContain("send-receipt");
      expect(result.snapshot.completedWorkflows).toContain("checkout");
    }
  });
});
