import { describe, it, expect } from "vitest";
import { computeGuidance } from "../../../src/oversight/guidance";
import type { RiskState, TrustState, Cost } from "../../../src/shared/types";

describe("computeGuidance", () => {
  const baseCost: Cost = { tokens: 100, durationMs: 1000 };
  const baseRisk: RiskState = { staticRisk: 0.2, currentRisk: 0.2, predictedRisk: 0.2, confidence: 0.5, escalated: false };
  const baseTrust: TrustState = { score: 0.8, successfulExecutions: 5, failedExecutions: 0, surpriseEvents: 0 };

  describe("risk band", () => {
    it("fires when currentRisk in [0.5, 0.8)", () => {
      const guidance = computeGuidance({
        risk: { ...baseRisk, currentRisk: 0.65 },
        trust: baseTrust,
        spent: baseCost,
        budget: baseCost,
      });
      expect(guidance.some((g) => g.includes("risk is elevated (0.65)"))).toBe(true);
    });

    it("silent below band (currentRisk < 0.5)", () => {
      const guidance = computeGuidance({
        risk: { ...baseRisk, currentRisk: 0.49 },
        trust: baseTrust,
        spent: baseCost,
        budget: baseCost,
      });
      expect(guidance.some((g) => g.includes("risk is elevated"))).toBe(false);
    });

    it("silent at/above escalation threshold (currentRisk >= 0.8)", () => {
      const guidance = computeGuidance({
        risk: { ...baseRisk, currentRisk: 0.8 },
        trust: baseTrust,
        spent: baseCost,
        budget: baseCost,
      });
      expect(guidance.some((g) => g.includes("risk is elevated"))).toBe(false);
    });
  });

  describe("trust band", () => {
    it("fires when score in (0.3, 0.5]", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: { ...baseTrust, score: 0.4 },
        spent: baseCost,
        budget: baseCost,
      });
      expect(guidance.some((g) => g.includes("trust is slipping (0.40)"))).toBe(true);
    });

    it("silent above band (score > 0.5)", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: { ...baseTrust, score: 0.51 },
        spent: baseCost,
        budget: baseCost,
      });
      expect(guidance.some((g) => g.includes("trust is slipping"))).toBe(false);
    });

    it("silent at/below escalation threshold (score <= 0.3)", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: { ...baseTrust, score: 0.29 },
        spent: baseCost,
        budget: baseCost,
      });
      expect(guidance.some((g) => g.includes("trust is slipping"))).toBe(false);
    });
  });

  describe("budget band", () => {
    it("fires for tokens at 82% of budget", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: { tokens: 820, durationMs: 1000 },
        budget: { tokens: 1000, durationMs: 10000 },
      });
      expect(guidance.some((g) => g.includes("82% of the token budget"))).toBe(true);
    });

    it("fires for duration at 80% of budget", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: { tokens: 100, durationMs: 8000 },
        budget: { tokens: 10000, durationMs: 10000 },
      });
      expect(guidance.some((g) => g.includes("80% of the duration budget"))).toBe(true);
    });

    it("silent below band (74% consumed)", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: { tokens: 740, durationMs: 1000 },
        budget: { tokens: 1000, durationMs: 10000 },
      });
      expect(guidance.some((g) => g.includes("token budget"))).toBe(false);
    });

    it("silent at escalation threshold (100% consumed)", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: { tokens: 1000, durationMs: 1000 },
        budget: { tokens: 1000, durationMs: 10000 },
      });
      expect(guidance.some((g) => g.includes("token budget"))).toBe(false);
    });

    it("fires for optional memory axis when declared", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: { tokens: 100, durationMs: 1000, memory: 750 },
        budget: { tokens: 10000, durationMs: 10000, memory: 1000 },
      });
      expect(guidance.some((g) => g.includes("75% of the memory budget"))).toBe(true);
    });

    it("silent for undeclared optional memory axis", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: { tokens: 100, durationMs: 1000 },
        budget: { tokens: 10000, durationMs: 10000 }, // memory not declared
      });
      expect(guidance.some((g) => g.includes("memory"))).toBe(false);
    });

    it("fires for optional latency axis when declared", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: { tokens: 100, durationMs: 1000, latency: 750 },
        budget: { tokens: 10000, durationMs: 10000, latency: 1000 },
      });
      expect(guidance.some((g) => g.includes("75% of the latency budget"))).toBe(true);
    });
  });

  describe("surprise band", () => {
    it("fires when magnitude in [0.4, 0.7)", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: baseCost,
        budget: baseCost,
        surpriseMagnitude: 0.5,
      });
      expect(guidance.some((g) => g.includes("deviated from expectations"))).toBe(true);
    });

    it("silent below band (magnitude < 0.4)", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: baseCost,
        budget: baseCost,
        surpriseMagnitude: 0.39,
      });
      expect(guidance.some((g) => g.includes("deviated"))).toBe(false);
    });

    it("silent at/above escalation threshold (magnitude >= 0.7)", () => {
      const guidance = computeGuidance({
        risk: baseRisk,
        trust: baseTrust,
        spent: baseCost,
        budget: baseCost,
        surpriseMagnitude: 0.7,
      });
      expect(guidance.some((g) => g.includes("deviated"))).toBe(false);
    });
  });

  describe("multiple signals", () => {
    it("returns multiple lines when several bands fire", () => {
      const guidance = computeGuidance({
        risk: { ...baseRisk, currentRisk: 0.65 },
        trust: { ...baseTrust, score: 0.4 },
        spent: { tokens: 820, durationMs: 1000 },
        budget: { tokens: 1000, durationMs: 10000 },
        surpriseMagnitude: 0.5,
      });
      expect(guidance.length).toBeGreaterThanOrEqual(4);
      expect(guidance.some((g) => g.includes("risk is elevated"))).toBe(true);
      expect(guidance.some((g) => g.includes("trust is slipping"))).toBe(true);
      expect(guidance.some((g) => g.includes("token"))).toBe(true);
      expect(guidance.some((g) => g.includes("deviated"))).toBe(true);
    });
  });

  describe("empty guidance", () => {
    it("returns empty array when nothing is in band", () => {
      const guidance = computeGuidance({
        risk: { ...baseRisk, currentRisk: 0.2 },
        trust: { ...baseTrust, score: 0.8 },
        spent: { tokens: 10, durationMs: 100 },
        budget: { tokens: 1000, durationMs: 10000 },
        surpriseMagnitude: 0.1,
      });
      expect(guidance).toEqual([]);
    });
  });
});
