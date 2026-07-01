import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createRegistry } from "../../../src/authoring";
import { makeDefineTool } from "../../../src/authoring";
import type { Tool } from "../../../src/authoring";
import { Ok } from "slang-ts";

const schema = z.object({ query: z.string() });
const fn = async () => Ok("ok");

const validTool = (name = "web-search"): Tool => ({
  name,
  description: "Search the web for information",
  schema,
  fn,
});

describe("makeDefineTool", () => {
  it("registers a valid tool and returns it", () => {
    const registry = createRegistry();
    const defineTool = makeDefineTool({ registry });
    const tool = defineTool(validTool());
    expect(tool.name).toBe("web-search");
    expect(registry.getTool("web-search").isOk).toBe(true);
  });

  it("rejects duplicate tool names", () => {
    const registry = createRegistry();
    const defineTool = makeDefineTool({ registry });
    defineTool(validTool("search"));
    expect(() => defineTool(validTool("search"))).toThrow(/already registered/);
  });

  it("rejects tool with system: prefix", () => {
    const registry = createRegistry();
    const defineTool = makeDefineTool({ registry });
    expect(() => defineTool(validTool("system:internal"))).toThrow(/system:/);
  });

  it("lists registered tools", () => {
    const registry = createRegistry();
    const defineTool = makeDefineTool({ registry });
    defineTool(validTool("tool-a"));
    defineTool(validTool("tool-b"));
    expect(registry.listTools()).toContain("tool-a");
    expect(registry.listTools()).toContain("tool-b");
  });
});
