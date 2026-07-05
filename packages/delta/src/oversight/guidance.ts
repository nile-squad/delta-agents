/**
 * Engine guidance — warning-band advisory text before escalation thresholds.
 *
 * Guidance computes humanized lines from governance signals (risk, trust, budget,
 * surprise) when they reach elevated levels but remain below escalation thresholds.
 * These lines reach the model on its next turn so it can self-correct before a gate
 * trips (e.g. slow down, prefer cheaper paths, wrap up).
 *
 * Each band sits strictly below its corresponding escalation threshold, so guidance
 * and escalation never fire for the same signal on the same step.
 */

import type { RiskState, TrustState, Cost } from "../shared/types";

export type GuidanceInput = {
  risk: RiskState;
  trust: TrustState;
  spent: Cost;
  budget: Cost;
  surpriseMagnitude?: number;
};

// ── Guidance bands — thresholds and constants ────────────────────────────────

// Risk escalates at currentRisk >= 0.8 (src/governance/risk.ts:105).
// Guidance band: currentRisk in [0.5, 0.8), staying strictly below escalation.
const RISK_GUIDANCE_LOWER = 0.5;
const RISK_GUIDANCE_UPPER = 0.8;

// Trust escalates at score < 0.3 (src/governance/trust.ts:92).
// Guidance band: score in (0.3, 0.5], staying strictly above escalation threshold.
const TRUST_GUIDANCE_LOWER = 0.3;
const TRUST_GUIDANCE_UPPER = 0.5;

// Budget escalates when spent > budget on any axis (src/oversight/escalation.ts:79).
// Guidance band: consumption in [75%, 100%) for each axis, staying strictly below 100%.
const BUDGET_GUIDANCE_THRESHOLD = 0.75;

// Surprise escalates at magnitude >= 0.7 (src/oversight/escalation.ts:35).
// Guidance band: magnitude in [0.4, 0.7), staying strictly below escalation.
const SURPRISE_GUIDANCE_LOWER = 0.4;
const SURPRISE_GUIDANCE_UPPER = 0.7;

/**
 * Compute humanized guidance lines from governance signals.
 *
 * Returns a list of advisory strings, one per band that fires. When multiple signals
 * are elevated, all applicable lines are returned. Returns [] when nothing is in band.
 * Lines are never returned when a signal is at/above its escalation threshold —
 * escalation owns that range and pauses the task.
 *
 * Voice matches existing loop-detector feedback (src/engine/loop-detector.ts:108-137):
 * full sentences, no jargon, humanized without condescension.
 */
export const computeGuidance = (input: GuidanceInput): string[] => {
  const lines: string[] = [];

  // ── Risk band ────────────────────────────────────────────────────────────
  // currentRisk in [0.5, 0.8): escalation owns [0.8, 1.0].
  if (
    input.risk.currentRisk >= RISK_GUIDANCE_LOWER &&
    input.risk.currentRisk < RISK_GUIDANCE_UPPER
  ) {
    lines.push(
      `risk is elevated (${input.risk.currentRisk.toFixed(2)}) — ` +
        `prefer low-risk actions and avoid irreversible operations.`,
    );
  }

  // ── Trust band ───────────────────────────────────────────────────────────
  // score in (0.3, 0.5]: escalation owns [0, 0.3).
  if (
    input.trust.score > TRUST_GUIDANCE_LOWER &&
    input.trust.score <= TRUST_GUIDANCE_UPPER
  ) {
    lines.push(
      `trust is slipping (${input.trust.score.toFixed(2)}) — ` +
        `recent failures or surprising outcomes are eroding it; be conservative and precise.`,
    );
  }

  // ── Budget band ──────────────────────────────────────────────────────────
  // For each declared axis, consumption in [75%, 100%): escalation owns [100%, ∞).
  // Tokens and duration are always declared; memory and latency only when set.
  const budgetAxes: Array<{ name: string; spent: number; max: number }> = [
    { name: "token", spent: input.spent.tokens, max: input.budget.tokens },
    { name: "duration", spent: input.spent.durationMs, max: input.budget.durationMs },
    ...(input.budget.memory !== undefined
      ? [{ name: "memory", spent: input.spent.memory ?? 0, max: input.budget.memory }]
      : []),
    ...(input.budget.latency !== undefined
      ? [{ name: "latency", spent: input.spent.latency ?? 0, max: input.budget.latency }]
      : []),
  ];

  for (const axis of budgetAxes) {
    if (axis.max <= 0) continue; // undeclared/zero axis: no ratio to report.
    const consumed = axis.spent / axis.max;
    if (consumed >= BUDGET_GUIDANCE_THRESHOLD && consumed < 1.0) {
      const percent = Math.round(consumed * 100);
      lines.push(
        `${percent}% of the ${axis.name} budget is consumed — prioritize finishing the goal.`,
      );
    }
  }

  // ── Surprise band ────────────────────────────────────────────────────────
  // magnitude in [0.4, 0.7): escalation owns [0.7, 1.0].
  if (
    input.surpriseMagnitude !== undefined &&
    input.surpriseMagnitude >= SURPRISE_GUIDANCE_LOWER &&
    input.surpriseMagnitude < SURPRISE_GUIDANCE_UPPER
  ) {
    lines.push(
      `the last outcome deviated from expectations — ` +
        `verify results before building on them.`,
    );
  }

  return lines;
};
