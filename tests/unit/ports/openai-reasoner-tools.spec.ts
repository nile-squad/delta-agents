/**
 * Phase 2 — tool-aware openai-reasoner tests.
 *
 * Covers:
 *   - buildMessages: action schemas, tool menu, tool hints injection (and
 *     backward-compat: omitted fields leave no trace in the user message)
 *   - tools array assembly: system:use_tool + system:get_tool_schema only
 *     appear when there is at least one registered tool
 *   - parseToolCall: new tool names map to the new ReasonerDecision kinds,
 *     with full validation (valid/invalid/missing tool_name)
 */

import { describe, it, expect } from "vitest";
import { createOpenAIReasoner } from "../../../src/ports/openai-reasoner";
import type { OpenAIReasonerConfig } from "../../../src/ports/openai-reasoner";
import { buildMessages } from "../../../src/ports/openai-reasoner";
import type { ReasonerInput } from "../../../src/ports/reasoner-port";

type FetchFn = NonNullable<OpenAIReasonerConfig["fetch"]>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeInput = (overrides: Partial<ReasonerInput> = {}): ReasonerInput => ({
  task: {
    id: "tsk_tools",
    rootId: "tsk_tools",
    status: "running",
    goal: "use a tool to look something up",
    assignedAgent: "tool-agent",
    budget: { tokens: 5000, durationMs: 120_000 },
    risk: { staticRisk: 0.2, currentRisk: 0.2, predictedRisk: 0.2, confidence: 0.85, escalated: false },
    trust: { score: 0.75, successfulExecutions: 3, failedExecutions: 0, surpriseEvents: 0 },
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  },
  availableActions: ["do-work"],
  agentRole: "Tool User",
  rolePrompt: "You use tools to get work done.",
  ...overrides,
});

const fetchReturning = (body: Record<string, unknown>): FetchFn =>
  async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// Build a response for a given tool call (name + args).
const mockToolCallResponse = (name: string, args: Record<string, unknown>): Record<string, unknown> => ({
  id: "chatcmpl-tooltest",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: `call_${name}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
});

// Fallback action response so the tools-array tests have something valid to
// call when the test only inspects the request body.
const mockActionResponse = (actionName: string, input: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-act",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: "call_act",
            type: "function",
            function: {
              name: "request_action",
              arguments: JSON.stringify({ action_name: actionName, input }),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
});

const captureFetch = (): { fetch: FetchFn; getBody: () => Record<string, unknown> | undefined } => {
  let captured: Record<string, unknown> | undefined;
  const fetch: FetchFn = async (_url, init) => {
    captured = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify(mockActionResponse("do-work")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch,
    getBody: () => captured,
  };
};

// ── buildMessages: action schemas, tool menu, tool hints ─────────────────────

describe("buildMessages — action schemas", () => {
  it("includes each action's description and JSON schema in the user message", () => {
    const input = makeInput({
      availableActionSchemas: [
        {
          name: "send-money",
          description: "Send money to a recipient",
          schema: {
            type: "object",
            properties: { to: { type: "string" }, amount: { type: "number" } },
            required: ["to", "amount"],
            additionalProperties: false,
          },
        },
      ],
    });
    const msgs = buildMessages(input);
    const userMsg = msgs.find((m) => m.role === "user");
    const content = String(userMsg?.content);
    expect(content).toMatch(/Action details:/);
    expect(content).toMatch(/send-money: Send money to a recipient/);
    expect(content).toMatch(/"to":\s*\{\s*"type":\s*"string"/);
  });

  it("omits the action-details block when availableActionSchemas is not provided", () => {
    const input = makeInput();
    const msgs = buildMessages(input);
    const userMsg = msgs.find((m) => m.role === "user");
    expect(String(userMsg?.content)).not.toMatch(/Action details:/);
  });

  it("omits the action-details block when availableActionSchemas is empty", () => {
    const input = makeInput({ availableActionSchemas: [] });
    const msgs = buildMessages(input);
    const userMsg = msgs.find((m) => m.role === "user");
    expect(String(userMsg?.content)).not.toMatch(/Action details:/);
  });
});

describe("buildMessages — tool menu", () => {
  it("includes each tool's name and description in the user message", () => {
    const input = makeInput({
      availableTools: [
        { name: "web_search", description: "Search the public web" },
        { name: "calc", description: "Evaluate a math expression" },
      ],
    });
    const msgs = buildMessages(input);
    const userMsg = msgs.find((m) => m.role === "user");
    const content = String(userMsg?.content);
    expect(content).toMatch(/Available tools:/);
    expect(content).toMatch(/web_search: Search the public web/);
    expect(content).toMatch(/calc: Evaluate a math expression/);
    expect(content).toMatch(/system:get_tool_schema/);
  });

  it("omits the tool menu when availableTools is not provided", () => {
    const input = makeInput();
    const msgs = buildMessages(input);
    const userMsg = msgs.find((m) => m.role === "user");
    expect(String(userMsg?.content)).not.toMatch(/Available tools:/);
    expect(String(userMsg?.content)).not.toMatch(/system:get_tool_schema/);
  });

  it("omits the tool menu when availableTools is empty", () => {
    const input = makeInput({ availableTools: [] });
    const msgs = buildMessages(input);
    const userMsg = msgs.find((m) => m.role === "user");
    expect(String(userMsg?.content)).not.toMatch(/Available tools:/);
  });
});

describe("buildMessages — tool hints", () => {
  it("includes advisory tool hints in the user message", () => {
    const input = makeInput({
      availableTools: [{ name: "web_search", description: "Search the public web" }],
      toolHints: ["web_search"],
    });
    const msgs = buildMessages(input);
    const userMsg = msgs.find((m) => m.role === "user");
    expect(String(userMsg?.content)).toMatch(/Suggested tools for this step: web_search/);
  });

  it("omits the hint line when toolHints is empty or absent", () => {
    const msgs1 = buildMessages(makeInput({ toolHints: [] }));
    expect(String(msgs1.find((m) => m.role === "user")?.content)).not.toMatch(/Suggested tools/);
    const msgs2 = buildMessages(makeInput());
    expect(String(msgs2.find((m) => m.role === "user")?.content)).not.toMatch(/Suggested tools/);
  });
});

// ── Tools array assembly ─────────────────────────────────────────────────────

describe("createOpenAIReasoner — system:use_tool and system:get_tool_schema in tools array", () => {
  it("offers both tool tools when availableTools is non-empty", async () => {
    const { fetch, getBody } = captureFetch();
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch,
    });
    await reasoner.reason(makeInput({
      availableTools: [
        { name: "web_search", description: "Search the public web" },
        { name: "calc", description: "Evaluate a math expression" },
      ],
    }));

    const body = getBody();
    expect(body).toBeDefined();
    const tools = body!["tools"] as Array<{ function: { name: string; parameters: { properties: { tool_name?: { enum?: string[] } } } } }>;
    const toolNames = tools.map((t) => t.function.name);
    expect(toolNames).toContain("system:use_tool");
    expect(toolNames).toContain("system:get_tool_schema");

    // Both must enumerate the same available tools in tool_name.
    const useTool = tools.find((t) => t.function.name === "system:use_tool");
    const getSchemaTool = tools.find((t) => t.function.name === "system:get_tool_schema");
    expect(useTool?.function.parameters.properties["tool_name"]?.enum).toEqual(["web_search", "calc"]);
    expect(getSchemaTool?.function.parameters.properties["tool_name"]?.enum).toEqual(["web_search", "calc"]);
  });

  it("does NOT offer system:use_tool or system:get_tool_schema when availableTools is empty", async () => {
    const { fetch, getBody } = captureFetch();
    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch });
    await reasoner.reason(makeInput({ availableTools: [] }));

    const tools = getBody()!["tools"] as Array<{ function: { name: string } }>;
    const toolNames = tools.map((t) => t.function.name);
    expect(toolNames).not.toContain("system:use_tool");
    expect(toolNames).not.toContain("system:get_tool_schema");
  });

  it("does NOT offer tool tools when availableTools is not provided", async () => {
    const { fetch, getBody } = captureFetch();
    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch });
    await reasoner.reason(makeInput());

    const tools = getBody()!["tools"] as Array<{ function: { name: string } }>;
    const toolNames = tools.map((t) => t.function.name);
    expect(toolNames).not.toContain("system:use_tool");
    expect(toolNames).not.toContain("system:get_tool_schema");
  });
});

// ── parseToolCall: system:use_tool ────────────────────────────────────────────

describe("createOpenAIReasoner — system:use_tool", () => {
  it("parses a valid use_tool call into a tool decision", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockToolCallResponse("system:use_tool", {
        tool_name: "web_search",
        input: { query: "delta-agents" },
      })),
    });

    const result = await reasoner.reason(makeInput({
      availableTools: [{ name: "web_search", description: "Search the public web" }],
    }));

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "tool") throw new Error("expected tool decision");
    expect(result.value.toolCall.toolName).toBe("web_search");
    expect(result.value.toolCall.input).toEqual({ query: "delta-agents" });
  });

  it("returns Err when use_tool targets a tool not in availableTools", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockToolCallResponse("system:use_tool", {
        tool_name: "ghost_tool",
        input: {},
      })),
    });

    const result = await reasoner.reason(makeInput({
      availableTools: [{ name: "web_search", description: "Search the public web" }],
    }));

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/ghost_tool/);
    expect(result.error).toMatch(/not in availableTools/);
  });

  it("returns Err when use_tool is missing tool_name", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockToolCallResponse("system:use_tool", { input: {} })),
    });

    const result = await reasoner.reason(makeInput({
      availableTools: [{ name: "web_search", description: "Search the public web" }],
    }));

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/tool_name is missing/);
  });
});

// ── parseToolCall: system:get_tool_schema ─────────────────────────────────────

describe("createOpenAIReasoner — system:get_tool_schema", () => {
  it("parses a valid get_tool_schema call into a tool-info decision", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockToolCallResponse("system:get_tool_schema", {
        tool_name: "web_search",
      })),
    });

    const result = await reasoner.reason(makeInput({
      availableTools: [{ name: "web_search", description: "Search the public web" }],
    }));

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "tool-info") throw new Error("expected tool-info decision");
    expect(result.value.request).toEqual({ type: "schema", toolName: "web_search" });
  });

  it("returns Err when get_tool_schema targets a tool not in availableTools", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockToolCallResponse("system:get_tool_schema", {
        tool_name: "ghost_tool",
      })),
    });

    const result = await reasoner.reason(makeInput({
      availableTools: [{ name: "web_search", description: "Search the public web" }],
    }));

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/ghost_tool/);
    expect(result.error).toMatch(/not in availableTools/);
  });
});
