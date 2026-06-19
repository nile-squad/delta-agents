import { describe, it, expect } from "vitest";
import { validatePhase } from "../../../src/authoring";
import type { Phase } from "../../../src/authoring";

const validPhase = (): Phase => ({
  name: "investigation",
  description: "Gather customer information",
  actions: ["lookup-customer"],
  checkpoint: true,
});

describe("validatePhase — sequential actions", () => {
  it("accepts a valid phase with sequential string actions", () => {
    expect(validatePhase(validPhase()).isOk).toBe(true);
  });

  it("rejects when name is empty", () => {
    const result = validatePhase({ ...validPhase(), name: "" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/name/);
  });

  it("rejects when description is empty", () => {
    const result = validatePhase({ ...validPhase(), description: "" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/description/);
  });

  it("rejects when actions list is empty", () => {
    const result = validatePhase({ ...validPhase(), actions: [] });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/actions list must be non-empty/);
  });

  it("rejects when an action ref has an empty name string", () => {
    const result = validatePhase({ ...validPhase(), actions: [""] });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/empty action name/);
  });
});

describe("validatePhase — branch nodes", () => {
  it("accepts a valid branch with onSuccess routing to a declared action", () => {
    const phase: Phase = {
      name: "settlement",
      description: "Payment settlement phase",
      checkpoint: true,
      actions: [
        "confirm-order",
        {
          action: "process-order",
          onSuccess: "confirm-order", // both actions declared in this phase
          onFailure: "confirm-order",
        },
      ],
    };
    expect(validatePhase(phase).isOk).toBe(true);
  });

  it("accepts a branch with only a when guard (no onSuccess/onFailure)", () => {
    const phase: Phase = {
      name: "routing",
      description: "Routing phase",
      checkpoint: false,
      actions: [
        "action-a",
        {
          action: "action-b",
          when: () => true,
        },
      ],
    };
    expect(validatePhase(phase).isOk).toBe(true);
  });

  it("rejects a branch with no routing target at all", () => {
    const phase: Phase = {
      name: "bad-phase",
      description: "Phase with bare branch",
      checkpoint: false,
      actions: [
        { action: "some-action" }, // no onSuccess, onFailure, or when
      ],
    };
    const result = validatePhase(phase);
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/onSuccess.*onFailure.*when/);
  });

  it("rejects a branch where onSuccess targets an action not declared in the phase", () => {
    const phase: Phase = {
      name: "bad-routing",
      description: "Bad routing phase",
      checkpoint: false,
      actions: [
        {
          action: "step-a",
          onSuccess: "ghost-action", // not in this phase
        },
      ],
    };
    const result = validatePhase(phase);
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/"ghost-action" is not declared/);
  });

  it("rejects a branch where onFailure targets a missing action", () => {
    const phase: Phase = {
      name: "bad-failure-routing",
      description: "Bad failure routing",
      checkpoint: false,
      actions: [
        {
          action: "step-a",
          onFailure: "nonexistent",
        },
      ],
    };
    const result = validatePhase(phase);
    expect(result.isErr).toBe(true);
  });
});

describe("validatePhase — supervision", () => {
  it("accepts a phase with a valid supervision policy", () => {
    const result = validatePhase({
      ...validPhase(),
      supervision: { strategy: "retry", maxRetries: 3 },
    });
    expect(result.isOk).toBe(true);
  });

  it("rejects supervision with negative maxRetries", () => {
    const result = validatePhase({
      ...validPhase(),
      supervision: { strategy: "retry", maxRetries: -1 },
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/maxRetries/);
  });
});
