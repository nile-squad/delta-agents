/**
 * OpenAI reasoner unit tests — all HTTP calls are intercepted via a custom
 * fetch implementation so no real API key or network is required.
 *
 * Tests cover:
 *   - Happy path: tool call parsed to ActionRequest
 *   - reasoning field: optional, passed through when present
 *   - availableActions guard: empty list returns Err before any API call
 *   - API failure: fetch throws → Err
 *   - Model refuses to call tool: no tool_calls in response → Err
 *   - Wrong tool name → Err
 *   - Malformed JSON in tool arguments → Err
 *   - action_name missing → Err
 *   - action_name not in availableActions (model ignored enum) → Err
 *   - Extra unknown fields in input are tolerated
 *   - Message shape: system + user messages contain expected content
 */

import { describe, it, expect, vi } from "vitest";
import { createOpenAIReasoner } from "../../../src/ports/openai-reasoner";
import type { OpenAIReasonerConfig } from "../../../src/ports/openai-reasoner";
import type { ReasonerInput } from "../../../src/ports/reasoner-port";

type FetchFn = NonNullable<OpenAIReasonerConfig["fetch"]>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeInput = (overrides: Partial<ReasonerInput> = {}): ReasonerInput => ({
  task: {
    id: "tsk_test",
    rootId: "tsk_test",
    status: "running",
    goal: "look up the customer and send a notification",
    assignedAgent: "support-agent",
    budget: { tokens: 5000, durationMs: 120_000 },
    risk: { staticRisk: 0.2, currentRisk: 0.2, predictedRisk: 0.2, confidence: 0.85, escalated: false },
    trust: { score: 0.75, successfulExecutions: 3, failedExecutions: 0, surpriseEvents: 0 },
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  },
  availableActions: ["lookup-customer", "send-notification"],
  agentRole: "Customer Support Specialist",
  rolePrompt: "You help customers resolve issues quickly and accurately.",
  ...overrides,
});

// Build a synthetic OpenAI chat completion response containing one tool call.
const mockCompletionResponse = (
  actionName: string,
  input: Record<string, unknown>,
  reasoning?: string,
): Record<string, unknown> => ({
  id: "chatcmpl-test-123",
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
            id: "call_abc",
            type: "function",
            function: {
              name: "request_action",
              arguments: JSON.stringify({
                action_name: actionName,
                input,
                ...(reasoning !== undefined ? { reasoning } : {}),
              }),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
});

// A response where the model called finish_task to signal completion.
const mockFinishResponse = (reason: string): Record<string, unknown> => ({
  id: "chatcmpl-finish",
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
            id: "call_finish",
            type: "function",
            function: { name: "finish_task", arguments: JSON.stringify({ reason }) },
          },
        ],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
});

// A response where the model produced text instead of calling a tool.
const mockTextResponse = (): Record<string, unknown> => ({
  id: "chatcmpl-text",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "I think you should look up the customer.", refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
});

// Custom fetch that returns a scripted JSON body.
const fetchReturning = (body: Record<string, unknown>): FetchFn =>
  async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// Custom fetch that throws (simulates network failure).
const fetchThrowing = (message: string): FetchFn =>
  async () => { throw new Error(message); };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createOpenAIReasoner — happy path", () => {
  it("returns Ok(ActionRequest) for a valid tool call response", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockCompletionResponse("lookup-customer", { customerId: "cust_123" })),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "act") throw new Error("expected act decision");
    expect(result.value.request.actionName).toBe("lookup-customer");
    expect(result.value.request.input).toEqual({ customerId: "cust_123" });
  });

  it("passes reasoning through when the model provides it", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(
        mockCompletionResponse("send-notification", { phone: "+1555" }, "Customer found, notification is next step"),
      ),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "act") throw new Error("expected act decision");
    expect(result.value.request.reasoning).toBe("Customer found, notification is next step");
  });

  it("reasoning is absent when model omits it", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockCompletionResponse("lookup-customer", {})),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "act") throw new Error("expected act decision");
    expect(result.value.request.reasoning).toBeUndefined();
  });

  it("input with multiple field types roundtrips correctly", async () => {
    const complexInput = { id: "c1", count: 42, active: true, note: null };
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockCompletionResponse("lookup-customer", complexInput)),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "act") throw new Error("expected act decision");
    expect(result.value.request.input).toEqual(complexInput);
  });

  it("reports reasoning token cost from usage metadata", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockCompletionResponse("lookup-customer", { id: "c1" })),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "act") throw new Error("expected act decision");
    // mockCompletionResponse reports total_tokens: 110.
    expect(result.value.request.reasoningCost?.tokens).toBe(110);
  });

  it("returns a done decision when the model calls finish_task", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockFinishResponse("goal satisfied")),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "done") throw new Error("expected done decision");
    expect(result.value.reason).toBe("goal satisfied");
  });
});

// ── Guard: empty availableActions ─────────────────────────────────────────────

describe("createOpenAIReasoner — empty availableActions", () => {
  it("returns Err immediately without calling the API when no actions are available", async () => {
    const mockFetch = vi.fn<FetchFn>();
    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: mockFetch });

    const result = await reasoner.reason(makeInput({ availableActions: [] }));

    expect(result.isErr).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── API failure ───────────────────────────────────────────────────────────────

describe("createOpenAIReasoner — API failure", () => {
  it("returns Err when the fetch call throws a network error", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchThrowing("network timeout"),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/API request failed/);
  });
});

// ── Model does not call tool ──────────────────────────────────────────────────

describe("createOpenAIReasoner — model skips tool call", () => {
  it("returns Err when the model returns text instead of a tool call", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockTextResponse()),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/did not call a tool/);
  });

  it("returns Err when choices array is empty", async () => {
    const emptyChoices = { ...mockCompletionResponse("x", {}), choices: [] };
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(emptyChoices),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/no choices/);
  });
});

// ── Wrong tool name ───────────────────────────────────────────────────────────

describe("createOpenAIReasoner — wrong tool name", () => {
  it("returns Err when the model calls an unexpected function", async () => {
    const badTool: Record<string, unknown> = {
      ...mockCompletionResponse("x", {}),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "some_other_function", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    };

    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(badTool),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/unexpected tool name/);
    expect(result.error).toMatch(/some_other_function/);
  });
});

// ── Malformed arguments JSON ──────────────────────────────────────────────────

describe("createOpenAIReasoner — malformed tool arguments", () => {
  it("returns Err when arguments is not valid JSON", async () => {
    const badArgs: Record<string, unknown> = {
      ...mockCompletionResponse("x", {}),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "request_action", arguments: "not-valid-json{{{" },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    };

    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(badArgs),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/failed to parse tool arguments/);
  });
});

// ── action_name missing ───────────────────────────────────────────────────────

describe("createOpenAIReasoner — action_name missing", () => {
  it("returns Err when action_name is absent from the parsed arguments", async () => {
    const noName: Record<string, unknown> = {
      ...mockCompletionResponse("x", {}),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: {
                  name: "request_action",
                  arguments: JSON.stringify({ input: {} }), // action_name omitted
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    };

    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(noName),
    });

    const result = await reasoner.reason(makeInput());

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/action_name is missing/);
  });
});

// ── action_name not in availableActions ───────────────────────────────────────

describe("createOpenAIReasoner — action_name outside availableActions", () => {
  it("returns Err when model ignores enum and picks an unavailable action", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockCompletionResponse("delete-account", { id: "123" })),
    });

    const result = await reasoner.reason(
      makeInput({ availableActions: ["lookup-customer", "send-notification"] }),
    );

    expect(result.isErr).toBe(true);
    if (!result.isErr) return;
    expect(result.error).toMatch(/delete-account/);
    expect(result.error).toMatch(/not in availableActions/);
  });
});

// ── Message content ───────────────────────────────────────────────────────────

describe("createOpenAIReasoner — message content inspection", () => {
  it("includes task goal and available actions in the user message", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify(mockCompletionResponse("lookup-customer", {})),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const input = makeInput({
      task: {
        ...makeInput().task,
        goal: "resolve complaint for customer XYZ",
        id: "tsk_inspect",
        rootId: "tsk_inspect",
      },
      availableActions: ["lookup-customer", "send-notification"],
    });

    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: captureFetch });
    await reasoner.reason(input);

    expect(capturedBody).toBeDefined();
    const messages = capturedBody!["messages"] as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toMatch(/resolve complaint for customer XYZ/);
    expect(userMsg?.content).toMatch(/lookup-customer/);
    expect(userMsg?.content).toMatch(/send-notification/);
  });

  it("includes agent role in the system message", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify(mockCompletionResponse("lookup-customer", {})),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: captureFetch });
    await reasoner.reason(makeInput({ agentRole: "Billing Specialist" }));

    const messages = capturedBody!["messages"] as Array<{ role: string; content: string }>;
    const sysMsg = messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toMatch(/Billing Specialist/);
  });

  it("appends context to the user message when provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify(mockCompletionResponse("lookup-customer", {})),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: captureFetch });
    await reasoner.reason(makeInput({ context: "Customer has a premium subscription." }));

    const messages = capturedBody!["messages"] as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toMatch(/Customer has a premium subscription/);
  });

  it("sends tool_choice: required and the request_action tool", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify(mockCompletionResponse("lookup-customer", {})),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: captureFetch });
    await reasoner.reason(makeInput());

    expect(capturedBody!["tool_choice"]).toBe("required");
    const tools = capturedBody!["tools"] as Array<{ function: { name: string } }>;
    expect(tools).toHaveLength(2);
    const toolNames = tools.map((t) => t.function.name);
    expect(toolNames).toContain("request_action");
    expect(toolNames).toContain("finish_task");
  });
});

// ── Delegation tool ─────────────────────────────────────────────────────────

// A response where the model called delegate_task to hand off a sub-goal.
const mockDelegateResponse = (
  goal: string,
  agentName: string,
  budget?: { tokens: number; durationMs: number },
): Record<string, unknown> => ({
  id: "chatcmpl-delegate",
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
            id: "call_delegate",
            type: "function",
            function: {
              name: "delegate_task",
              arguments: JSON.stringify({ goal, agent_name: agentName, ...(budget !== undefined ? { budget } : {}) }),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
});

describe("createOpenAIReasoner — delegation", () => {
  it("parses a delegate_task call into a delegate decision", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockDelegateResponse("research the account", "research-agent")),
    });

    const result = await reasoner.reason(makeInput({ availableAgents: ["research-agent", "billing-agent"] }));
    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "delegate") throw new Error("expected delegate decision");
    expect(result.value.delegation.goal).toBe("research the account");
    expect(result.value.delegation.agentName).toBe("research-agent");
    expect(result.value.delegation.budget).toBeUndefined();
  });

  it("passes the child budget through when provided", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockDelegateResponse("sub", "research-agent", { tokens: 500, durationMs: 30_000 })),
    });

    const result = await reasoner.reason(makeInput({ availableAgents: ["research-agent"] }));
    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "delegate") throw new Error("expected delegate decision");
    expect(result.value.delegation.budget).toEqual({ tokens: 500, durationMs: 30_000 });
  });

  it("returns Err when the model delegates to an agent outside availableAgents", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockDelegateResponse("sub", "ghost-agent")),
    });

    const result = await reasoner.reason(makeInput({ availableAgents: ["research-agent"] }));
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/not in availableAgents/);
  });

  it("offers the delegate_task tool only when other agents are available", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockCompletionResponse("lookup-customer", {})), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: captureFetch });
    await reasoner.reason(makeInput({ availableAgents: ["research-agent"] }));

    const tools = capturedBody!["tools"] as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toContain("delegate_task");
    const messages = capturedBody!["messages"] as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toMatch(/Available agents to delegate to: research-agent/);
  });

  it("does not offer delegate_task when no other agents are available", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockCompletionResponse("lookup-customer", {})), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: captureFetch });
    await reasoner.reason(makeInput({ availableAgents: [] }));

    const tools = capturedBody!["tools"] as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).not.toContain("delegate_task");
  });
});

// ── send_message tool ────────────────────────────────────────────────────────

const mockSendMessageResponse = (channel: string, body: string): Record<string, unknown> => ({
  id: "chatcmpl-send",
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
          { id: "call_send", type: "function", function: { name: "send_message", arguments: JSON.stringify({ channel, body }) } },
        ],
      },
      finish_reason: "tool_calls",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 70, completion_tokens: 12, total_tokens: 82 },
});

describe("createOpenAIReasoner — communication", () => {
  it("parses a send_message call into a communicate decision", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockSendMessageResponse("slack", "deploy finished")),
    });
    const result = await reasoner.reason(makeInput({ availableChannels: ["slack", "email"] }));
    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value.kind !== "communicate") throw new Error("expected communicate decision");
    expect(result.value.communication.channel).toBe("slack");
    expect(result.value.communication.body).toBe("deploy finished");
  });

  it("returns Err when the model sends on a channel outside availableChannels", async () => {
    const reasoner = createOpenAIReasoner({
      apiKey: "test-key",
      fetch: fetchReturning(mockSendMessageResponse("discord", "hi")),
    });
    const result = await reasoner.reason(makeInput({ availableChannels: ["slack"] }));
    expect(result.isErr).toBe(true);
    if (result.isErr) expect(result.error).toMatch(/not in availableChannels/);
  });

  it("offers the send_message tool only when channels are available", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockCompletionResponse("lookup-customer", {})), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const reasoner = createOpenAIReasoner({ apiKey: "test-key", fetch: captureFetch });

    await reasoner.reason(makeInput({ availableChannels: ["slack"] }));
    let tools = capturedBody!["tools"] as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toContain("send_message");

    await reasoner.reason(makeInput({ availableChannels: [] }));
    tools = capturedBody!["tools"] as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).not.toContain("send_message");
  });
});
