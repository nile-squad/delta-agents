/**
 * Escalation detection and recording unit tests.
 *
 * checkEscalation is a pure function — same inputs always produce the same
 * trigger. raiseEscalation persists the escalation so it is auditable and
 * TaskID-attributable (invariant 13: every escalation is auditable).
 *
 * Priority order under test: risk-threshold > bayesian-surprise >
 * budget-violation > policy-violation > workflow-failure > explicit.
 *
 * Covers: invariant 13.
 */

import { describe, it, expect } from "vitest";
import { checkEscalation, raiseEscalation, getEscalations } from "../../../src/oversight";
import { createInMemoryStore } from "../../../src/ports";
import { initialRiskState } from "../../../src/governance";
import type { RiskState, Cost } from "../../../src/shared/types";
import type { EscalationContext } from "../../../src/oversight";

const safeRisk = (): RiskState => initialRiskState();
const budget = (tokens: number, durationMs: number): Cost => ({ tokens, durationMs });

const baseCtx = (): EscalationContext => ({
  risk: safeRisk(),
  spent: budget(100, 1_000),
  budget: budget(1_000, 30_000),
});

// ── checkEscalation — no escalation ──────────────────────────────────────────

describe("checkEscalation — returns false when all signals are below threshold", () => {
  it("returns { escalate: false } for a healthy task", () => {
    const result = checkEscalation(baseCtx());
    expect(result.escalate).toBe(false);
  });

  it("is deterministic — same inputs always produce the same output", () => {
    const ctx = baseCtx();
    const r1 = checkEscalation(ctx);
    const r2 = checkEscalation(ctx);
    expect(r1).toEqual(r2);
  });

  it("surpriseMagnitude just below threshold does not escalate", () => {
    const result = checkEscalation({ ...baseCtx(), surpriseMagnitude: 0.69 });
    expect(result.escalate).toBe(false);
  });
});

// ── risk-threshold ────────────────────────────────────────────────────────────

describe("checkEscalation — risk-threshold trigger", () => {
  it("escalates when currentRisk >= 0.8", () => {
    const highRisk: RiskState = {
      ...safeRisk(),
      currentRisk: 0.8,
      predictedRisk: 0.5,
    };
    const result = checkEscalation({ ...baseCtx(), risk: highRisk });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("risk-threshold");
  });

  it("escalates when predictedRisk >= 0.9", () => {
    const highPredicted: RiskState = {
      ...safeRisk(),
      currentRisk: 0.4,
      predictedRisk: 0.9,
    };
    const result = checkEscalation({ ...baseCtx(), risk: highPredicted });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("risk-threshold");
  });

  it("does not escalate when currentRisk is 0.79 and predictedRisk is 0.89", () => {
    const borderlineRisk: RiskState = {
      ...safeRisk(),
      currentRisk: 0.79,
      predictedRisk: 0.89,
    };
    const result = checkEscalation({ ...baseCtx(), risk: borderlineRisk });
    expect(result.escalate).toBe(false);
  });
});

// ── bayesian-surprise ─────────────────────────────────────────────────────────

describe("checkEscalation — bayesian-surprise trigger", () => {
  it("escalates when surpriseMagnitude >= 0.7", () => {
    const result = checkEscalation({ ...baseCtx(), surpriseMagnitude: 0.7 });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("bayesian-surprise");
  });

  it("escalates for any surpriseMagnitude > 0.7", () => {
    const result = checkEscalation({ ...baseCtx(), surpriseMagnitude: 0.99 });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("bayesian-surprise");
  });

  it("reason mentions the magnitude", () => {
    const result = checkEscalation({ ...baseCtx(), surpriseMagnitude: 0.85 });
    if (result.escalate) expect(result.reason).toMatch(/0\.85/);
  });
});

// ── budget-violation ──────────────────────────────────────────────────────────

describe("checkEscalation — budget-violation trigger", () => {
  it("escalates when tokens spent exceeds budget", () => {
    const result = checkEscalation({
      ...baseCtx(),
      spent: budget(1_001, 100),
      budget: budget(1_000, 30_000),
    });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("budget-violation");
  });

  it("escalates when durationMs spent exceeds budget", () => {
    const result = checkEscalation({
      ...baseCtx(),
      spent: budget(100, 30_001),
      budget: budget(1_000, 30_000),
    });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("budget-violation");
  });

  it("does not escalate when exactly at budget (equality is not a violation)", () => {
    const result = checkEscalation({
      ...baseCtx(),
      spent: budget(1_000, 30_000),
      budget: budget(1_000, 30_000),
    });
    // tokens == budget is not a violation (> check), so no budget-violation trigger
    expect(result.escalate).toBe(false);
  });
});

// ── policy-violation ──────────────────────────────────────────────────────────

describe("checkEscalation — policy-violation trigger", () => {
  it("escalates when hasPolicyViolation is true", () => {
    const result = checkEscalation({ ...baseCtx(), hasPolicyViolation: true });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("policy-violation");
  });

  it("does not escalate when hasPolicyViolation is false", () => {
    const result = checkEscalation({ ...baseCtx(), hasPolicyViolation: false });
    expect(result.escalate).toBe(false);
  });
});

// ── workflow-failure ──────────────────────────────────────────────────────────

describe("checkEscalation — workflow-failure trigger", () => {
  it("escalates when hasWorkflowFailure is true", () => {
    const result = checkEscalation({ ...baseCtx(), hasWorkflowFailure: true });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("workflow-failure");
  });
});

// ── explicit ──────────────────────────────────────────────────────────────────

describe("checkEscalation — explicit trigger", () => {
  it("escalates when explicitEscalation is true", () => {
    const result = checkEscalation({ ...baseCtx(), explicitEscalation: true });
    expect(result.escalate).toBe(true);
    if (result.escalate) expect(result.trigger).toBe("explicit");
  });
});

// ── priority order ────────────────────────────────────────────────────────────

describe("checkEscalation — priority order (risk > surprise > budget > policy > workflow > explicit)", () => {
  it("risk-threshold wins over bayesian-surprise", () => {
    const result = checkEscalation({
      ...baseCtx(),
      risk: { ...safeRisk(), currentRisk: 0.9, predictedRisk: 0.95 },
      surpriseMagnitude: 0.9,
    });
    if (result.escalate) expect(result.trigger).toBe("risk-threshold");
  });

  it("bayesian-surprise wins over budget-violation", () => {
    const result = checkEscalation({
      ...baseCtx(),
      surpriseMagnitude: 0.8,
      spent: budget(9_999, 1_000),
      budget: budget(1_000, 30_000),
    });
    if (result.escalate) expect(result.trigger).toBe("bayesian-surprise");
  });

  it("budget-violation wins over policy-violation", () => {
    const result = checkEscalation({
      ...baseCtx(),
      spent: budget(2_000, 1_000),
      budget: budget(1_000, 30_000),
      hasPolicyViolation: true,
    });
    if (result.escalate) expect(result.trigger).toBe("budget-violation");
  });

  it("policy-violation wins over workflow-failure", () => {
    const result = checkEscalation({
      ...baseCtx(),
      hasPolicyViolation: true,
      hasWorkflowFailure: true,
    });
    if (result.escalate) expect(result.trigger).toBe("policy-violation");
  });

  it("workflow-failure wins over explicit", () => {
    const result = checkEscalation({
      ...baseCtx(),
      hasWorkflowFailure: true,
      explicitEscalation: true,
    });
    if (result.escalate) expect(result.trigger).toBe("workflow-failure");
  });
});

// ── raiseEscalation ───────────────────────────────────────────────────────────

describe("raiseEscalation — persist escalation record (invariant 13)", () => {
  it("returns Ok with the saved record", async () => {
    const store = createInMemoryStore();
    const result = await raiseEscalation({
      taskId: "tsk_1",
      trigger: "explicit",
      reason: "manual override",
      store,
    });
    expect(result.isOk).toBe(true);
  });

  it("record carries the correct taskId, trigger, and reason", async () => {
    const store = createInMemoryStore();
    const result = await raiseEscalation({
      taskId: "tsk_abc",
      trigger: "risk-threshold",
      reason: "risk is too high",
      store,
    });
    if (result.isOk) {
      expect(result.value.taskId).toBe("tsk_abc");
      expect(result.value.trigger).toBe("risk-threshold");
      expect(result.value.reason).toBe("risk is too high");
    }
  });

  it("id is prefixed with 'esc_' (auditable, self-describing, invariant 13)", async () => {
    const store = createInMemoryStore();
    const result = await raiseEscalation({
      taskId: "tsk_1",
      trigger: "explicit",
      reason: "test",
      store,
    });
    if (result.isOk) expect(result.value.id.startsWith("esc_")).toBe(true);
  });

  it("every escalation id is unique", async () => {
    const store = createInMemoryStore();
    const r1 = await raiseEscalation({ taskId: "tsk_1", trigger: "explicit", reason: "a", store });
    const r2 = await raiseEscalation({ taskId: "tsk_1", trigger: "explicit", reason: "b", store });
    if (r1.isOk && r2.isOk) expect(r1.value.id).not.toBe(r2.value.id);
  });

  it("includes a createdAt timestamp", async () => {
    const store = createInMemoryStore();
    const result = await raiseEscalation({
      taskId: "tsk_1",
      trigger: "budget-violation",
      reason: "over budget",
      store,
    });
    if (result.isOk) expect(result.value.createdAt).toBeInstanceOf(Date);
  });
});

// ── getEscalations ────────────────────────────────────────────────────────────

describe("getEscalations — retrieve all escalations for a task", () => {
  it("returns empty array when no escalations exist", async () => {
    const store = createInMemoryStore();
    const result = await getEscalations({ taskId: "tsk_empty", store });
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toHaveLength(0);
  });

  it("returns all escalations for the task in insertion order", async () => {
    const store = createInMemoryStore();
    await raiseEscalation({ taskId: "tsk_1", trigger: "explicit", reason: "first", store });
    await raiseEscalation({ taskId: "tsk_1", trigger: "risk-threshold", reason: "second", store });

    const result = await getEscalations({ taskId: "tsk_1", store });
    if (result.isOk) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.trigger).toBe("explicit");
      expect(result.value[1]?.trigger).toBe("risk-threshold");
    }
  });

  it("is scoped to taskId — escalations from other tasks are not returned", async () => {
    const store = createInMemoryStore();
    await raiseEscalation({ taskId: "tsk_A", trigger: "explicit", reason: "task A", store });
    await raiseEscalation({ taskId: "tsk_B", trigger: "explicit", reason: "task B", store });

    const resultA = await getEscalations({ taskId: "tsk_A", store });
    if (resultA.isOk) {
      expect(resultA.value).toHaveLength(1);
      expect(resultA.value[0]?.reason).toBe("task A");
    }
  });

  it("all returned records are TaskID-attributable (invariant 13)", async () => {
    const store = createInMemoryStore();
    await raiseEscalation({ taskId: "tsk_audit", trigger: "workflow-failure", reason: "fail", store });
    await raiseEscalation({ taskId: "tsk_audit", trigger: "budget-violation", reason: "over", store });

    const result = await getEscalations({ taskId: "tsk_audit", store });
    if (result.isOk) {
      for (const record of result.value) {
        expect(record.taskId).toBe("tsk_audit");
        expect(record.id).toBeTruthy();
      }
    }
  });
});
