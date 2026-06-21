/**
 * Human oversight integration tests.
 *
 * These tests wire the oversight module into the execution gateway to verify
 * that the approval gate and escalation paths function end-to-end:
 *
 * - requiresApproval actions are blocked until resolved
 * - A rejected approval permanently closes the gate (prohibition 11)
 * - Every escalation is TaskID-attributable and retrievable (invariant 13)
 * - The gateway error message distinguishes pending / rejected / not-requested
 *
 * The gateway is tested with a mock action; the oversight module provides
 * the ApprovalStatus the gateway needs to make its decision.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok } from "slang-ts";
import {
  requestApproval,
  resolveApproval,
  getApprovalStatusForAction,
  checkEscalation,
  raiseEscalation,
  getEscalations,
} from "../../../src/oversight";
import { runGateway } from "../../../src/execution";
import { createInMemoryStore } from "../../../src/ports";
import { initialRiskState, initialTrust } from "../../../src/governance";
import type { Action } from "../../../src/authoring/types";
import type { TaskStateSnapshot } from "../../../src/state-space/types";
import type { RiskState } from "../../../src/shared/types";

const makeAction = (override: Partial<Action> = {}): Action => ({
  name: "test-action",
  description: "test",
  schema: z.object({ x: z.number() }),
  requiresApproval: true,
  fn: async () => Ok("done"),
  ...override,
});

const makeState = (): TaskStateSnapshot => ({
  taskId: "tsk_integration",
  rootId: "tsk_integration",
  agentName: "test-agent",
  status: "running",
  completedActions: [],
  completedWorkflows: [],
  budget: { tokens: 10_000, durationMs: 60_000 },
  spent: { tokens: 0, durationMs: 0 },
  risk: initialRiskState(),
  trust: initialTrust(),
});

// ── approval gate in the execution gateway ────────────────────────────────────

describe("gateway approval gate — blocks until resolved", () => {
  it("blocks when no approval has been requested (approvalStatus 'none')", async () => {
    const store = createInMemoryStore();
    const result = await runGateway({
      action: makeAction(),
      rawInput: { x: 1 },
      state: makeState(),
      approvalStatus: "none",
      store,
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/approval-required/);
    if (result.isErr) expect(result.error).toMatch(/not been requested/);
  });

  it("blocks when approval is pending (approvalStatus 'pending')", async () => {
    const store = createInMemoryStore();
    const result = await runGateway({
      action: makeAction(),
      rawInput: { x: 1 },
      state: makeState(),
      approvalStatus: "pending",
      store,
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/pending human resolution/);
  });

  it("blocks when approval was rejected — gate stays closed (prohibition 11)", async () => {
    const store = createInMemoryStore();
    const result = await runGateway({
      action: makeAction(),
      rawInput: { x: 1 },
      state: makeState(),
      approvalStatus: "rejected",
      store,
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/rejected/);
  });

  it("proceeds when approval is approved", async () => {
    const store = createInMemoryStore();
    const result = await runGateway({
      action: makeAction(),
      rawInput: { x: 1 },
      state: makeState(),
      approvalStatus: "approved",
      store,
    });
    expect(result.isOk).toBe(true);
  });
});

// ── full approval flow: request → resolve → gateway ──────────────────────────

describe("full approval flow — request, resolve, then pass to gateway", () => {
  it("requestApproval → approved → gateway proceeds", async () => {
    const store = createInMemoryStore();
    const action = makeAction({ name: "send-payment" });

    // 1. Request approval
    const req = await requestApproval({
      taskId: "tsk_integration",
      action: "send-payment",
      reason: "high-risk financial action",
      store,
    });
    expect(req.isOk).toBe(true);

    // 2. Resolve as approved
    if (req.isOk) {
      const resolved = await resolveApproval({
        approvalId: req.value.id,
        decision: "approved",
        store,
      });
      expect(resolved.isOk).toBe(true);
    }

    // 3. Get status and pass to gateway
    const statusResult = await getApprovalStatusForAction({
      taskId: "tsk_integration",
      action: "send-payment",
      store,
    });
    expect(statusResult.isOk).toBe(true);
    if (!statusResult.isOk) return;

    const gatewayResult = await runGateway({
      action,
      rawInput: { x: 42 },
      state: makeState(),
      approvalStatus: statusResult.value,
      store,
    });
    expect(gatewayResult.isOk).toBe(true);
  });

  it("requestApproval → rejected → gateway blocks", async () => {
    const store = createInMemoryStore();
    const action = makeAction({ name: "delete-account" });

    const req = await requestApproval({
      taskId: "tsk_integration",
      action: "delete-account",
      reason: "irreversible deletion",
      store,
    });

    if (req.isOk) {
      await resolveApproval({
        approvalId: req.value.id,
        decision: "rejected",
        store,
      });
    }

    const statusResult = await getApprovalStatusForAction({
      taskId: "tsk_integration",
      action: "delete-account",
      store,
    });

    if (!statusResult.isOk) return;

    const gatewayResult = await runGateway({
      action,
      rawInput: { x: 1 },
      state: makeState(),
      approvalStatus: statusResult.value,
      store,
    });
    expect(gatewayResult.isErr).toBe(true);
    if (gatewayResult.isErr) expect(gatewayResult.error).toMatch(/rejected/);
  });
});

// ── escalation: all triggers are auditable (invariant 13) ────────────────────

describe("escalation audit trail — every escalation is TaskID-attributable (invariant 13)", () => {
  it("raiseEscalation from risk-threshold is stored and retrievable", async () => {
    const store = createInMemoryStore();
    const highRisk: RiskState = {
      staticRisk: 0.2,
      currentRisk: 0.85,
      predictedRisk: 0.92,
      confidence: 0.9,
      escalated: false,
    };
    const ctx = {
      risk: highRisk,
      spent: { tokens: 100, durationMs: 1_000 },
      budget: { tokens: 1_000, durationMs: 30_000 },
    };
    const check = checkEscalation(ctx);

    expect(check.escalate).toBe(true);
    if (!check.escalate) return;

    await raiseEscalation({
      taskId: "tsk_audit",
      trigger: check.trigger,
      reason: check.reason,
      store,
    });

    const records = await getEscalations({ taskId: "tsk_audit", store });
    expect(records.isOk).toBe(true);
    if (records.isOk) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]?.trigger).toBe("risk-threshold");
      expect(records.value[0]?.taskId).toBe("tsk_audit");
    }
  });

  it("multiple escalations across triggers are all stored for the task", async () => {
    const store = createInMemoryStore();
    const triggers: Array<"explicit" | "budget-violation" | "workflow-failure"> = [
      "explicit",
      "budget-violation",
      "workflow-failure",
    ];

    for (const trigger of triggers) {
      await raiseEscalation({ taskId: "tsk_multi", trigger, reason: `reason for ${trigger}`, store });
    }

    const records = await getEscalations({ taskId: "tsk_multi", store });
    if (records.isOk) {
      expect(records.value).toHaveLength(3);
      const storedTriggers = records.value.map((r) => r.trigger);
      for (const trigger of triggers) {
        expect(storedTriggers).toContain(trigger);
      }
    }
  });

  it("escalation records from different tasks are isolated", async () => {
    const store = createInMemoryStore();
    await raiseEscalation({ taskId: "tsk_X", trigger: "explicit", reason: "X", store });
    await raiseEscalation({ taskId: "tsk_Y", trigger: "explicit", reason: "Y", store });

    const xRecords = await getEscalations({ taskId: "tsk_X", store });
    if (xRecords.isOk) {
      expect(xRecords.value).toHaveLength(1);
      expect(xRecords.value[0]?.taskId).toBe("tsk_X");
    }
  });

  it("no escalation path is silent — raiseEscalation always produces an auditable record", async () => {
    const store = createInMemoryStore();
    const allTriggers: Array<"risk-threshold" | "bayesian-surprise" | "policy-violation" | "budget-violation" | "workflow-failure" | "explicit"> = [
      "risk-threshold",
      "bayesian-surprise",
      "policy-violation",
      "budget-violation",
      "workflow-failure",
      "explicit",
    ];

    for (const trigger of allTriggers) {
      const result = await raiseEscalation({
        taskId: "tsk_all",
        trigger,
        reason: `testing ${trigger}`,
        store,
      });
      expect(result.isOk).toBe(true);
    }

    const records = await getEscalations({ taskId: "tsk_all", store });
    if (records.isOk) {
      expect(records.value).toHaveLength(allTriggers.length);
      for (const record of records.value) {
        expect(record.taskId).toBe("tsk_all");
        expect(record.id.startsWith("esc_")).toBe(true);
      }
    }
  });
});

// ── Trust degradation escalation (G2) ────────────────────────────────────────

describe("checkEscalation — degraded trust escalates (G2)", () => {
  const baseBudget = { spent: { tokens: 0, durationMs: 0 }, budget: { tokens: 1_000, durationMs: 30_000 } };

  it("escalates with trigger 'trust-degradation' when trust is below threshold", () => {
    const result = checkEscalation({
      risk: initialRiskState(),
      ...baseBudget,
      trust: { score: 0.2, successfulExecutions: 0, failedExecutions: 5, surpriseEvents: 1 },
    });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("trust-degradation");
  });

  it("does not escalate on healthy trust", () => {
    const result = checkEscalation({ risk: initialRiskState(), ...baseBudget, trust: initialTrust() });
    expect(result.escalate).toBe(false);
  });
});
