/**
 * delta.tools.invoke — the developer-facing tool invocation surface.
 *
 * invoke is the out-of-band path: it validates input against the tool's schema
 * and runs the tool with a synthesized context, without any task-scoped
 * governance (no history, no loop/budget). Tools are declared at engine
 * definition via `tools.custom`; invoke takes named args `{ tool, input, ctx? }`
 * — a uniform shape for every tool.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Ok, Err } from "slang-ts";
import { createDeltaEngine } from "../../../src/engine";
import { createInMemoryStore } from "../../../src/ports";
import type { Tool, ToolContext } from "../../../src/authoring/types";

const echoTool: Tool = {
  name: "echo",
  description: "echoes a message",
  schema: z.object({ message: z.string() }),
  fn: async ({ data }: { data: unknown }) => Ok((data as { message: string }).message),
};

const failTool: Tool = {
  name: "always-fails",
  description: "always errors",
  schema: z.object({}),
  fn: async () => Err("upstream down"),
};

const countTool: Tool = {
  name: "count-attachments",
  description: "counts attachments in ctx",
  schema: z.object({}),
  fn: async ({ ctx }: { data: unknown; ctx: ToolContext }) => Ok(ctx.attachments?.length ?? 0),
};

describe("delta.tools.invoke", () => {
  it("returns Err for an unknown tool", async () => {
    const delta = await createDeltaEngine({ store: createInMemoryStore() });
    const res = await delta.tools.invoke({ tool: "does-not-exist", input: {} });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("not found");
  });

  it("returns Err when input fails the tool's schema", async () => {
    const delta = await createDeltaEngine({ store: createInMemoryStore(), tools: { custom: [echoTool] } });
    const res = await delta.tools.invoke({ tool: "echo", input: { message: 42 } });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toContain("invalid");
  });

  it("runs a valid custom tool and returns its Result", async () => {
    const delta = await createDeltaEngine({ store: createInMemoryStore(), tools: { custom: [echoTool] } });
    const res = await delta.tools.invoke({ tool: "echo", input: { message: "hello" } });
    expect(res.isOk).toBe(true);
    if (res.isOk) expect(res.value).toBe("hello");
  });

  it("surfaces a tool's own Err unchanged", async () => {
    const delta = await createDeltaEngine({ store: createInMemoryStore(), tools: { custom: [failTool] } });
    const res = await delta.tools.invoke({ tool: "always-fails", input: {} });
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error).toBe("upstream down");
  });

  it("passes ctx.attachments through to the tool fn", async () => {
    const delta = await createDeltaEngine({ store: createInMemoryStore(), tools: { custom: [countTool] } });
    const res = await delta.tools.invoke({
      tool: "count-attachments",
      input: {},
      ctx: { attachments: [{ id: "a1", kind: "file", mimeType: "application/pdf", data: "x" }] },
    });
    expect(res.isOk).toBe(true);
    if (res.isOk) expect(res.value).toBe(1);
  });

  it("rejects an invalid custom tool at construction", async () => {
    await expect(
      createDeltaEngine({
        store: createInMemoryStore(),
        tools: { custom: [{ ...echoTool, name: "system:evil" }] },
      }),
    ).rejects.toThrow(/system:/);
  });

  it("rejects duplicate custom tool names at construction", async () => {
    await expect(
      createDeltaEngine({
        store: createInMemoryStore(),
        tools: { custom: [echoTool, { ...echoTool }] },
      }),
    ).rejects.toThrow(/already registered/);
  });
});
