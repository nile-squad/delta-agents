import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateTool } from "../../../src/authoring";
import type { Tool } from "../../../src/authoring";
import { Ok } from "slang-ts";

const schema = z.object({ query: z.string() });
const fn = async () => Ok("ok");

const validTool = (): Tool => ({
  name: "web-search",
  description: "Search the web for information",
  schema,
  fn,
});

describe("validateTool — basic fields", () => {
  it("accepts a fully valid tool definition", () => {
    const result = validateTool(validTool());
    expect(result.isOk).toBe(true);
  });

  it("rejects when name is empty", () => {
    const result = validateTool({ ...validTool(), name: "" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/name/);
  });

  it("rejects when name is only whitespace", () => {
    const result = validateTool({ ...validTool(), name: "   " });
    expect(result.isErr).toBe(true);
  });

  it("rejects when name starts with system:", () => {
    const result = validateTool({ ...validTool(), name: "system:internal" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/system:/);
  });

  it("rejects when description is empty", () => {
    const result = validateTool({ ...validTool(), description: "" });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/description/);
  });

  it("rejects when schema is missing", () => {
    const tool = { ...validTool(), schema: undefined } as unknown as Tool;
    const result = validateTool(tool);
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/schema/);
  });

  it("rejects when fn is missing", () => {
    const tool = { ...validTool(), fn: undefined } as unknown as Tool;
    const result = validateTool(tool);
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/fn/);
  });
});

describe("validateTool — limits", () => {
  it("accepts tool with no limits", () => {
    const result = validateTool({ ...validTool(), limits: undefined });
    expect(result.isOk).toBe(true);
  });

  it("accepts tool with valid limits", () => {
    const result = validateTool({
      ...validTool(),
      limits: { maxCallsPerPhase: 5, maxCallsPerTask: 20, cooldownMs: 1000 },
    });
    expect(result.isOk).toBe(true);
  });

  it("rejects negative cooldownMs", () => {
    const result = validateTool({
      ...validTool(),
      limits: { cooldownMs: -1 },
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/cooldownMs/);
  });

  it("rejects maxCallsPerPhase < 1", () => {
    const result = validateTool({
      ...validTool(),
      limits: { maxCallsPerPhase: 0 },
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/maxCallsPerPhase/);
  });

  it("rejects maxCallsPerTask < 1", () => {
    const result = validateTool({
      ...validTool(),
      limits: { maxCallsPerTask: 0 },
    });
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/maxCallsPerTask/);
  });

  it("accepts zero cooldownMs", () => {
    const result = validateTool({
      ...validTool(),
      limits: { cooldownMs: 0 },
    });
    expect(result.isOk).toBe(true);
  });
});
