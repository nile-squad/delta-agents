import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateAction } from "../../../src/authoring";
import type { Action } from "../../../src/authoring";
import { Ok } from "slang-ts";

const schema = z.object({ id: z.string() });
const fn = async () => Ok("ok");

const validAction = (): Action => ({
  name: "lookup-customer",
  description: "Look up a customer account",
  schema,
  fn,
});

describe("validateAction — invariant 4 (every executable action has a schema)", () => {
  it("accepts a fully valid action definition", () => {
    const result = validateAction(validAction());
    expect(result.isOk).toBe(true);
  });

  it("rejects when schema is missing", () => {
    const action = { ...validAction(), schema: undefined } as unknown as Action;
    const result = validateAction(action);
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/schema is required/);
  });

  it("rejects when name is empty", () => {
    const result = validateAction({ ...validAction(), name: "" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/name/);
  });

  it("rejects when name is only whitespace", () => {
    const result = validateAction({ ...validAction(), name: "   " });
    expect(result.isErr).toBe(true);
  });

  it("rejects when description is empty", () => {
    const result = validateAction({ ...validAction(), description: "" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/description/);
  });

  it("rejects when fn is missing", () => {
    const action = { ...validAction(), fn: undefined } as unknown as Action;
    const result = validateAction(action);
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/fn/);
  });
});

describe("validateAction — risk prior (optional, 1–5 only)", () => {
  it("accepts action with no risk declared", () => {
    const result = validateAction({ ...validAction(), risk: undefined });
    expect(result.isOk).toBe(true);
  });

  it("accepts risk values 1 through 5", () => {
    for (const risk of [1, 2, 3, 4, 5] as const) {
      const result = validateAction({ ...validAction(), risk });
      expect(result.isOk).toBe(true);
    }
  });

  it("passes risk value through unchanged (prior, not ceiling)", () => {
    const result = validateAction({ ...validAction(), risk: 3 });
    if (result.isOk) expect(result.value.risk).toBe(3);
  });

  it("accepts action with optional estimatedCost", () => {
    const result = validateAction({
      ...validAction(),
      estimatedCost: { tokens: 500, durationMs: 3000 },
    });
    expect(result.isOk).toBe(true);
  });
});

describe("validateAction — prerequisites (optional)", () => {
  it("accepts action with no prerequisites", () => {
    const result = validateAction({ ...validAction(), prerequisites: undefined });
    expect(result.isOk).toBe(true);
  });

  it("accepts action with action prerequisites", () => {
    const result = validateAction({
      ...validAction(),
      prerequisites: { actions: ["confirm-order"] },
    });
    expect(result.isOk).toBe(true);
  });

  it("accepts action with workflow prerequisites", () => {
    const result = validateAction({
      ...validAction(),
      prerequisites: { workflows: ["fraud-review"] },
    });
    expect(result.isOk).toBe(true);
  });
});

describe("validateAction — hooks (optional)", () => {
  it("accepts action with no hooks", () => {
    expect(validateAction({ ...validAction(), hooks: undefined }).isOk).toBe(true);
  });

  it("accepts action with before/after/onError hooks", () => {
    const hookFn = async () => Ok("hook");
    const result = validateAction({
      ...validAction(),
      hooks: { before: hookFn, after: hookFn, onError: hookFn },
    });
    expect(result.isOk).toBe(true);
  });
});
