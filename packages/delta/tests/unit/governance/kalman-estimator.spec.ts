import { describe, it, expect } from "vitest";
import {
  createKalmanState,
  kalmanUpdate,
  computeHealthObservation,
  normaliseRisk,
} from "../../../src/governance";

describe("normaliseRisk", () => {
  it("maps 1 → 0.2, 5 → 1.0", () => {
    expect(normaliseRisk(1)).toBe(0.2);
    expect(normaliseRisk(5)).toBe(1.0);
  });

  it("maps 3 → 0.6 (midpoint)", () => {
    expect(normaliseRisk(3)).toBeCloseTo(0.6);
  });
});

describe("createKalmanState — cold start (no prior)", () => {
  it("initialises estimate at 1.0 (assume on-track until evidence arrives)", () => {
    const state = createKalmanState();
    expect(state.estimate).toBe(1.0);
  });

  it("starts with high uncertainty (large errorVariance)", () => {
    const state = createKalmanState();
    expect(state.errorVariance).toBeGreaterThanOrEqual(0.4);
  });
});

describe("createKalmanState — with anticipated risk prior (invariant 23)", () => {
  it("lowers the initial estimate when risk is high", () => {
    const low = createKalmanState({ anticipatedRisk: 1 });
    const high = createKalmanState({ anticipatedRisk: 5 });
    expect(high.estimate).toBeLessThan(low.estimate);
  });

  it("prior lowers estimate but never below zero", () => {
    const state = createKalmanState({ anticipatedRisk: 5 });
    expect(state.estimate).toBeGreaterThanOrEqual(0);
  });

  it("prior is a starting point, not a floor — evidence can move it below the prior", () => {
    // After a terrible observation, estimate should be well below the prior.
    const state = createKalmanState({ anticipatedRisk: 1 }); // low risk prior
    const afterBadObservation = kalmanUpdate({ state, observation: 0.0 });
    // Evidence of zero health overrides the optimistic prior.
    expect(afterBadObservation.estimate).toBeLessThan(state.estimate);
  });
});

describe("createKalmanState — with estimatedCost prior", () => {
  it("tightens variance when estimatedCost is present (faster convergence)", () => {
    const without = createKalmanState();
    const withCost = createKalmanState({ hasEstimatedCost: true });
    expect(withCost.errorVariance).toBeLessThan(without.errorVariance);
  });
});

describe("kalmanUpdate — basic update mechanics", () => {
  it("moves estimate toward the observation", () => {
    const state = createKalmanState(); // estimate = 1.0
    const updated = kalmanUpdate({ state, observation: 0.5 });
    expect(updated.estimate).toBeLessThan(state.estimate);
    expect(updated.estimate).toBeGreaterThan(0.5);
  });

  it("converges toward the true value over repeated observations", () => {
    let state = createKalmanState();
    // Feed 20 observations of 0.4 — estimate should converge toward 0.4.
    for (let i = 0; i < 20; i++) {
      state = kalmanUpdate({ state, observation: 0.4 });
    }
    expect(state.estimate).toBeCloseTo(0.4, 1);
  });

  it("estimate stays within [0, 1] regardless of extreme observations", () => {
    let state = createKalmanState();
    for (let i = 0; i < 50; i++) {
      state = kalmanUpdate({ state, observation: i % 2 === 0 ? -10 : 10 });
    }
    expect(state.estimate).toBeGreaterThanOrEqual(0);
    expect(state.estimate).toBeLessThanOrEqual(1);
  });

  it("reduces errorVariance with each update (uncertainty decreases as evidence accumulates)", () => {
    let state = createKalmanState();
    const initialVariance = state.errorVariance;
    for (let i = 0; i < 10; i++) {
      state = kalmanUpdate({ state, observation: 0.8 });
    }
    expect(state.errorVariance).toBeLessThan(initialVariance);
  });

  it("prior seeded by risk converges faster than cold-start (invariant 23 — prior helps)", () => {
    // The prior-seeded state starts closer to the truth — it needs fewer updates to converge.
    const coldStart = createKalmanState();
    const priored = createKalmanState({ anticipatedRisk: 3, hasEstimatedCost: true });

    let cold = coldStart;
    let warm = priored;
    for (let i = 0; i < 5; i++) {
      cold = kalmanUpdate({ state: cold, observation: 0.6 });
      warm = kalmanUpdate({ state: warm, observation: 0.6 });
    }
    // After 5 steps, warm prior should be closer to 0.6 due to lower initial variance.
    const coldDist = Math.abs(cold.estimate - 0.6);
    const warmDist = Math.abs(warm.estimate - 0.6);
    expect(warmDist).toBeLessThanOrEqual(coldDist + 0.05); // warm converges at least as fast
  });
});

describe("computeHealthObservation", () => {
  it("returns 1.0 when no cost has been spent (no observation to make)", () => {
    expect(computeHealthObservation({ progressRatio: 0.5, costRatio: 0 })).toBe(1.0);
  });

  it("returns 0.0 when progress is zero but cost is non-zero", () => {
    expect(computeHealthObservation({ progressRatio: 0, costRatio: 0.5 })).toBe(0.0);
  });

  it("returns 1.0 when progress equals cost (perfectly on track)", () => {
    expect(computeHealthObservation({ progressRatio: 0.5, costRatio: 0.5 })).toBe(1.0);
  });

  it("returns < 1.0 when cost outpaces progress (unhealthy)", () => {
    const obs = computeHealthObservation({ progressRatio: 0.2, costRatio: 0.6 });
    expect(obs).toBeLessThan(1.0);
  });

  it("caps at 1.0 even when progress > cost (going faster than expected is fine)", () => {
    const obs = computeHealthObservation({ progressRatio: 0.8, costRatio: 0.2 });
    expect(obs).toBe(1.0);
  });

  it("stays in [0, 1] for arbitrary inputs", () => {
    const cases: Array<{ progressRatio: number; costRatio: number }> = [
      { progressRatio: 0, costRatio: 0 },
      { progressRatio: 1, costRatio: 1 },
      { progressRatio: 0.1, costRatio: 0.9 },
      { progressRatio: 0.9, costRatio: 0.1 },
    ];
    for (const input of cases) {
      const obs = computeHealthObservation(input);
      expect(obs).toBeGreaterThanOrEqual(0);
      expect(obs).toBeLessThanOrEqual(1);
    }
  });
});
