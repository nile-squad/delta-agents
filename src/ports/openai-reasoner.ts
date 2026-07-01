/**
 * OpenAI ReasonerPort adapter — production reasoning via the chat completions API.
 *
 * Uses a single `request_action` function tool with `tool_choice: "required"` so
 * the model is forced to commit to one action each turn. The `action_name` parameter
 * carries an enum constraint derived from the discoverable actions, which steers the
 * model without removing its discretion about which action to pick.
 *
 * The engine remains bounded regardless of the model's capability. A weaker model
 * still goes through every governance check; a stronger model is still blocked by
 * the same gateway rules (README: "A weaker model is still safe. A stronger model
 * is still bounded.").
 *
 * Usage:
 *   const reasoner = createOpenAIReasoner({ model: "gpt-4o" });
 *   // or with explicit key:
 *   const reasoner = createOpenAIReasoner({ apiKey: process.env.OPENAI_API_KEY });
 *
 * For testing, inject a custom fetch:
 *   const reasoner = createOpenAIReasoner({ apiKey: "test", fetch: mockFetch });
 */

import { Ok, Err, option, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { ReasonerPort, ReasonerInput, ReasonerDecision } from "./reasoner-port";
import type { Cost } from "../shared/types";

// Matches the Fetch type the OpenAI client constructor accepts.
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ── Configuration ─────────────────────────────────────────────────────────────

export type OpenAIReasonerConfig = {
  /** OpenAI API key. Falls back to OPENAI_API_KEY environment variable. */
  apiKey?: string;
  /**
   * Base URL for the API. Defaults to the OpenAI endpoint. Set this to point at
   * any OpenAI-compatible provider, for example OpenRouter
   * ("https://openrouter.ai/api/v1"). The reasoner only uses chat completions
   * with tool calling, so any compatible endpoint works unchanged.
   */
  baseURL?: string;
  /**
   * Chat completions model. Defaults to "gpt-4o-mini" — cost-effective
   * and sufficiently capable for governed action selection.
   */
  model?: string;
  /**
   * Sampling temperature. Only sent when explicitly set — newer reasoning models
   * (gpt-5.x / o-series) reject any non-default temperature, so by default the
   * request omits it and the model uses its own default. Set this only for
   * models that support it (e.g. gpt-4o) and where you want exploratory output.
   */
  temperature?: number;
  /**
   * Nucleus sampling probability mass. Only sent when explicitly set.
   * Mutually exclusive with temperature in most providers; set one or the other.
   */
  topP?: number;
  /** Maximum completion tokens (sent as `max_completion_tokens`). Defaults to 512. */
  maxTokens?: number;
  /**
   * Custom fetch implementation. Useful for tests that need to return
   * scripted responses without making real HTTP calls.
   */
  fetch?: FetchFn;
  /**
   * Global org instructions baked into the system message prefix. Static
   * content (no time/varying data) so prompt caching is preserved. When set
   * and non-empty, prepended to the system message before the role + rolePrompt.
   */
  systemPrompt?: string;
};

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 512;

// ── Tool definition ───────────────────────────────────────────────────────────

const buildTool = (availableActions: string[]): ChatCompletionTool => ({
  type: "function",
  function: {
    name: "request_action",
    description:
      "Commit to the single best next action for the current task step. " +
      "The engine will validate and execute it; you do not execute anything directly.",
    parameters: {
      type: "object",
      properties: {
        action_name: {
          type: "string",
          description: "Exact name of the action to execute. Must be one of the available actions.",
          enum: availableActions,
        },
        input: {
          type: "object",
          description: "Parameters the action function expects. Provide all required fields.",
          additionalProperties: true,
        },
        reasoning: {
          type: "string",
          description: "One-sentence explanation of why this action was chosen. Stored for audit.",
        },
      },
      required: ["action_name", "input"],
      additionalProperties: false,
    },
  },
});

// The model calls this when the task goal is satisfied and no further action is
// needed. It is the explicit completion signal — the engine maps it to a clean
// "completed" status, distinct from an Err failure (spec §Execution Outcomes).
const FINISH_TOOL_NAME = "finish_task";

const buildFinishTool = (): ChatCompletionTool => ({
  type: "function",
  function: {
    name: FINISH_TOOL_NAME,
    description:
      "Declare the task complete. Call this only when the goal is fully satisfied " +
      "and no further action is required. Do not call it to abandon a task you cannot finish.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "One-sentence summary of why the task is complete. Stored for audit.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
});

// The model calls this to hand a scoped sub-goal to another agent. The engine
// creates a bounded child task whose budget is clamped to the parent's remaining
// budget (invariant 18) and runs it under the binary supervision tree. Only
// offered when there is at least one other agent to delegate to.
const DELEGATE_TOOL_NAME = "delegate_task";

const buildDelegateTool = (availableAgents: string[]): ChatCompletionTool => ({
  type: "function",
  function: {
    name: DELEGATE_TOOL_NAME,
    description:
      "Hand a scoped sub-goal to another agent. The engine creates a bounded child task " +
      "whose budget is clamped to your remaining budget. Use this to decompose work that " +
      "belongs to a different specialist — not to avoid finishing your own task.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The scoped objective handed to the child agent.",
        },
        agent_name: {
          type: "string",
          description: "Exact name of the agent to delegate to. Must be one of the available agents.",
          enum: availableAgents,
        },
        budget: {
          type: "object",
          description:
            "Optional budget ceiling for the child task. Clamped to your remaining budget. " +
            "Omit to grant the child your full remaining budget.",
          properties: {
            tokens: { type: "number" },
            durationMs: { type: "number" },
          },
          required: ["tokens", "durationMs"],
          additionalProperties: false,
        },
      },
      required: ["goal", "agent_name"],
      additionalProperties: false,
    },
  },
});

// The model calls this to mention a teammate: leave a named teammate a note on
// this task without handing off work. Unlike delegate_task it spawns no child
// task; the engine records a TaskID-attributable agent-to-agent message. Only
// offered when the agent has teammates (the same availableAgents set).
const MENTION_TOOL_NAME = "mention_teammate";

const buildMentionTool = (availableAgents: string[]): ChatCompletionTool => ({
  type: "function",
  function: {
    name: MENTION_TOOL_NAME,
    description:
      "Leave a note for a teammate on this task without handing off work. Use this to " +
      "reference or loop in a teammate; use delegate_task instead when you want them to own a sub-goal.",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Exact name of the teammate to mention. Must be one of the available agents.",
          enum: availableAgents,
        },
        message: {
          type: "string",
          description: "The note left for the mentioned teammate.",
        },
      },
      required: ["agent_name", "message"],
      additionalProperties: false,
    },
  },
});

// The model calls this to send a message through one of the agent's bound
// channels (Slack, email, WhatsApp, …). Only offered when the agent has at least
// one channel. The engine routes it through the channel, optionally gating it
// behind human approval, and records the message.
const SEND_MESSAGE_TOOL_NAME = "send_message";

const buildCommunicateTool = (availableChannels: string[]): ChatCompletionTool => ({
  type: "function",
  function: {
    name: SEND_MESSAGE_TOOL_NAME,
    description:
      "Send a message to a person or channel this task is connected to (e.g. Slack, email). " +
      "Use this to communicate, ask, or notify — not to perform internal actions.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "The channel to send through. Must be one of the available channels.",
          enum: availableChannels,
        },
        body: {
          type: "string",
          description: "The message text to send.",
        },
      },
      required: ["channel", "body"],
      additionalProperties: false,
    },
  },
});

// The "system:" prefix is reserved for internal framework tools. User-registered
// tools cannot use it (validated at authoring time). These two are the runtime
// hooks the model uses to interact with the tool layer.
const USE_TOOL_NAME = "system:use_tool";
const GET_TOOL_SCHEMA_NAME = "system:get_tool_schema";

/**
 * The model calls `system:use_tool` to execute a registered tool. The result is
 * stored in the task's tool history; the next reason() call sees it as prior
 * tool history context.
 *
 * Only offered when at least one tool is registered. The enum constrains the
 * model to a real tool name — anything outside is rejected by the parser.
 */
const buildUseToolTool = (availableTools: string[]): ChatCompletionTool => ({
  type: "function",
  function: {
    name: USE_TOOL_NAME,
    description:
      "Execute a tool by name with the provided input. Use system:get_tool_schema first " +
      "if you need to know the expected input shape. The result is stored in tool history.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "Exact name of the tool to execute. Must be one of the available tools.",
          enum: availableTools,
        },
        input: {
          type: "object",
          description: "Parameters the tool function expects. Provide all required fields.",
          additionalProperties: true,
        },
      },
      required: ["tool_name", "input"],
      additionalProperties: false,
    },
  },
});

/**
 * The model calls `system:get_tool_schema` to fetch a tool's JSON schema before
 * calling `system:use_tool`. Progressive disclosure: the lightweight tool menu
 * ships every turn; full schemas are on demand.
 */
const buildGetToolSchemaTool = (availableTools: string[]): ChatCompletionTool => ({
  type: "function",
  function: {
    name: GET_TOOL_SCHEMA_NAME,
    description:
      "Fetch the JSON schema for a tool so you know what input parameters it expects. " +
      "Call this before system:use_tool when you need to know the input shape.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "Exact name of the tool to get the schema for.",
          enum: availableTools,
        },
      },
      required: ["tool_name"],
      additionalProperties: false,
    },
  },
});

// ── Message builder ───────────────────────────────────────────────────────────

/**
 * Build the chat-completion message array from a ReasonerInput. Exported so
 * tests can verify the cacheable prefix and time-awareness wiring directly
 * without standing up a live reasoner.
 */
export const buildMessages = (input: ReasonerInput): ChatCompletionMessageParam[] => {
  const { task, availableActions, availableAgents, availableChannels, availableSkills, availableActionSchemas, availableTools, toolHints, agentRole, rolePrompt, context, systemPrompt, currentTimestamp, priorMessages } = input;
  const canDelegate = availableAgents !== undefined && availableAgents.length > 0;
  const canCommunicate = availableChannels !== undefined && availableChannels.length > 0;
  const hasSkills = availableSkills !== undefined && availableSkills.length > 0;
  const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
  const hasPrior = priorMessages !== undefined && priorMessages.length > 0;
  const hasActionSchemas = availableActionSchemas !== undefined && availableActionSchemas.length > 0;
  const hasTools = availableTools !== undefined && availableTools.length > 0;
  const hasToolHints = toolHints !== undefined && toolHints.length > 0;

  const system: ChatCompletionMessageParam = {
    role: "system",
    content: [
      // systemPrompt first so the cacheable prefix = `[systemPrompt]\n\nYou are ...`.
      // Time/varying content must NEVER go here — it would break the prefix.
      ...(hasSystemPrompt ? [systemPrompt, ""] : []),
      `You are ${agentRole}. ${rolePrompt}`,
      "",
      "You are driving a governed execution task. Each turn you must call exactly one tool.",
      "Call request_action with the action name and the parameters that action needs.",
      "Only call actions listed in the user message — all others are outside your authority.",
      ...(canDelegate
        ? [
            "Call delegate_task to hand a scoped sub-goal to one of the available agents.",
            "Call mention_teammate to leave one of them a note without handing off work.",
          ]
        : []),
      ...(canCommunicate
        ? ["Call send_message to send a message through one of the available channels."]
        : []),
      ...(hasTools
        ? [
            "Call system:use_tool to execute a registered tool by name.",
            "Call system:get_tool_schema first to fetch a tool's input schema when needed.",
          ]
        : []),
      "When the goal is fully satisfied and no further action is needed, call finish_task instead.",
    ].join("\n"),
  };

  const userLines: string[] = [];
  // Time awareness lives in the user message — never in the system prefix.
  if (currentTimestamp !== undefined) {
    userLines.push(`Current time: ${currentTimestamp.humanized} (${currentTimestamp.iso})`);
  }
  userLines.push(`Task goal: ${task.goal}`);
  userLines.push(`Task ID: ${task.id}`);
  userLines.push(`Available actions: ${availableActions.join(", ")}`);
  // Action schemas: full description + JSON schema for each legal action.
  // The model needs the full shape to call business-logic actions correctly.
  if (hasActionSchemas) {
    userLines.push("", "Action details:");
    for (const action of availableActionSchemas) {
      userLines.push(`  ${action.name}: ${action.description}`);
      userLines.push(`  Schema: ${JSON.stringify(action.schema)}`);
    }
  }
  if (canDelegate) {
    userLines.push(`Available teammates (to delegate to or mention): ${availableAgents.join(", ")}`);
  }
  if (canCommunicate) {
    userLines.push(`Available channels to send through: ${availableChannels.join(", ")}`);
  }
  // Tool menu: names + descriptions (progressive disclosure — schemas on demand).
  if (hasTools) {
    userLines.push("", "Available tools:");
    for (const tool of availableTools) {
      userLines.push(`  ${tool.name}: ${tool.description}`);
    }
    userLines.push("Use system:get_tool_schema to fetch a tool's input schema before calling system:use_tool.");
  }
  // Advisory hints from the current phase/action. Suggestions only — the full
  // tool menu above is always shown regardless of hints.
  if (hasToolHints) {
    userLines.push(`Suggested tools for this step: ${toolHints.join(", ")}`);
  }
  if (hasSkills) {
    userLines.push(`Skills (specialized capabilities to apply): ${availableSkills.map((s) => `${s.name} — ${s.description}`).join("; ")}`);
    for (const skill of availableSkills) {
      if (skill.content !== undefined && skill.content.length > 0) {
        userLines.push(`Skill "${skill.name}" content:\n${skill.content}`);
      }
    }
  }
  if (hasPrior) {
    userLines.push("", "Prior conversation:", ...priorMessages.map((m) => `[${m.relativeTime}] ${m.sender}: ${m.content}`));
  }
  if (context !== undefined && context.length > 0) {
    userLines.push("", "Context:", context);
  }

  const user: ChatCompletionMessageParam = {
    role: "user",
    content: userLines.join("\n"),
  };

  return [system, user];
};

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Cost the model spent producing this turn: tokens from the provider's usage
 * metadata, and the measured API round-trip as `latency` (a real cost axis).
 * Duration (fn execution time) is left to the gateway.
 */
const reasoningCostFrom = (
  response: OpenAI.Chat.Completions.ChatCompletion,
  latencyMs: number,
): Cost => ({
  tokens: response.usage?.total_tokens ?? 0,
  durationMs: 0,
  latency: latencyMs,
});

/** Parse an optional budget object from delegate_task arguments. */
const parseBudget = (raw: unknown): Cost | undefined => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const tokens = obj["tokens"];
  const durationMs = obj["durationMs"];
  if (typeof tokens !== "number" || typeof durationMs !== "number") return undefined;
  return { tokens, durationMs };
};

const parseToolCall = async (
  response: OpenAI.Chat.Completions.ChatCompletion,
  input: ReasonerInput,
  latencyMs: number,
): Promise<Result<ReasonerDecision, string>> => {
  const { availableActions, availableAgents = [], availableChannels = [] } = input;
  const availableToolNames = (input.availableTools ?? []).map((t) => t.name);
  const choiceOpt = option(response.choices[0]);
  if (choiceOpt.isNone) {
    return Err("openai-reasoner: API response contained no choices");
  }
  const choice = choiceOpt.value;

  const toolCalls = choice.message.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    return Err(
      `openai-reasoner: model did not call a tool (finish_reason: "${choice.finish_reason}")`,
    );
  }

  // Narrow the union: only function-type tool calls carry a .function property.
  const callOpt = option(toolCalls[0]);
  if (callOpt.isNone || callOpt.value.type !== "function") {
    return Err(
      `openai-reasoner: unexpected tool type "${callOpt.isSome ? callOpt.value.type : "none"}" — expected "function"`,
    );
  }
  const call = callOpt.value;

  const argsResult = await safeTry(async () => JSON.parse(call.function.arguments) as Record<string, unknown>);
  if (argsResult.isErr) return Err(`openai-reasoner: failed to parse tool arguments as JSON: ${call.function.arguments}`);
  const args = argsResult.value;

  // Explicit completion signal — the goal is satisfied, no further action.
  if (call.function.name === FINISH_TOOL_NAME) {
    const reason = typeof args["reason"] === "string" ? args["reason"] : undefined;
    return Ok({ kind: "done", ...(reason !== undefined ? { reason } : {}) });
  }

  // Delegation — hand a scoped sub-goal to another agent.
  if (call.function.name === DELEGATE_TOOL_NAME) {
    const goal = args["goal"];
    if (typeof goal !== "string" || goal.length === 0) {
      return Err(`openai-reasoner: delegate goal is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    const agentName = args["agent_name"];
    if (typeof agentName !== "string" || agentName.length === 0) {
      return Err(`openai-reasoner: delegate agent_name is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    if (!availableAgents.includes(agentName)) {
      return Err(
        `openai-reasoner: model chose to delegate to "${agentName}" which is not in availableAgents ${JSON.stringify(availableAgents)}`,
      );
    }
    const budget = parseBudget(args["budget"]);
    return Ok({
      kind: "delegate",
      delegation: { goal, agentName, ...(budget !== undefined ? { budget } : {}) },
    });
  }

  // Mention — leave a teammate a note on this task (no child task spawned).
  if (call.function.name === MENTION_TOOL_NAME) {
    const agentName = args["agent_name"];
    if (typeof agentName !== "string" || agentName.length === 0) {
      return Err(`openai-reasoner: mention agent_name is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    if (!availableAgents.includes(agentName)) {
      return Err(
        `openai-reasoner: model chose to mention "${agentName}" which is not in availableAgents ${JSON.stringify(availableAgents)}`,
      );
    }
    const message = args["message"];
    if (typeof message !== "string" || message.length === 0) {
      return Err(`openai-reasoner: mention message is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    return Ok({ kind: "mention", mention: { agentName, message } });
  }

  // Communication — send a message through a bound channel.
  if (call.function.name === SEND_MESSAGE_TOOL_NAME) {
    const channel = args["channel"];
    if (typeof channel !== "string" || channel.length === 0) {
      return Err(`openai-reasoner: send_message channel is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    if (!availableChannels.includes(channel)) {
      return Err(
        `openai-reasoner: model chose channel "${channel}" which is not in availableChannels ${JSON.stringify(availableChannels)}`,
      );
    }
    const body = args["body"];
    if (typeof body !== "string" || body.length === 0) {
      return Err(`openai-reasoner: send_message body is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    return Ok({ kind: "communicate", communication: { channel, body } });
  }

  // Tool execution — model wants to run a reusable utility. Validated against
  // availableTools so a model cannot call a tool that was not offered this turn.
  if (call.function.name === USE_TOOL_NAME) {
    const toolName = args["tool_name"];
    if (typeof toolName !== "string" || toolName.length === 0) {
      return Err(`openai-reasoner: system:use_tool tool_name is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    if (!availableToolNames.includes(toolName)) {
      return Err(`openai-reasoner: model chose tool "${toolName}" which is not in availableTools ${JSON.stringify(availableToolNames)}`);
    }
    const rawToolInput = args["input"];
    const toolInput: Record<string, unknown> =
      rawToolInput !== null && typeof rawToolInput === "object" && !Array.isArray(rawToolInput)
        ? (rawToolInput as Record<string, unknown>)
        : {};
    return Ok({ kind: "tool", toolCall: { toolName, input: toolInput } });
  }

  // Tool schema request — model wants to see a tool's input shape before calling it.
  if (call.function.name === GET_TOOL_SCHEMA_NAME) {
    const toolName = args["tool_name"];
    if (typeof toolName !== "string" || toolName.length === 0) {
      return Err(`openai-reasoner: system:get_tool_schema tool_name is missing or not a string in arguments: ${JSON.stringify(args)}`);
    }
    if (!availableToolNames.includes(toolName)) {
      return Err(`openai-reasoner: model asked for schema of tool "${toolName}" which is not in availableTools ${JSON.stringify(availableToolNames)}`);
    }
    return Ok({ kind: "tool-info", request: { type: "schema", toolName } });
  }

  if (call.function.name !== "request_action") {
    return Err(
      `openai-reasoner: unexpected tool name "${call.function.name}" — expected "request_action", "delegate_task", "mention_teammate", "send_message", "finish_task", "system:use_tool", or "system:get_tool_schema"`,
    );
  }

  const actionName = args["action_name"];
  if (typeof actionName !== "string" || actionName.length === 0) {
    return Err(
      `openai-reasoner: action_name is missing or not a string in arguments: ${JSON.stringify(args)}`,
    );
  }

  if (!availableActions.includes(actionName)) {
    return Err(
      `openai-reasoner: model chose "${actionName}" which is not in availableActions ${JSON.stringify(availableActions)}`,
    );
  }

  const rawInput = args["input"];
  const actionInput: Record<string, string | number | boolean | null> =
    rawInput !== null &&
    typeof rawInput === "object" &&
    !Array.isArray(rawInput)
      ? (rawInput as Record<string, string | number | boolean | null>)
      : {};

  const reasoning =
    typeof args["reasoning"] === "string" ? args["reasoning"] : undefined;

  return Ok({
    kind: "act",
    request: {
      actionName,
      input: actionInput,
      reasoningCost: reasoningCostFrom(response, latencyMs),
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
  });
};

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an OpenAI-backed ReasonerPort.
 *
 * The returned reasoner calls the chat completions API each turn, forcing a
 * tool call that names the next action and its input. The engine validates,
 * governs, and executes — the model only proposes.
 */
export const createOpenAIReasoner = (config: OpenAIReasonerConfig = {}): ReasonerPort => {
  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
  });

  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  // systemPrompt is set once at construction — kept in closure so every
  // reasoner call prepends it to the cacheable system prefix.
  const systemPrompt = config.systemPrompt;

  return {
    reason: async (input: ReasonerInput): Promise<Result<ReasonerDecision, string>> => {
      const { availableActions } = input;
      const availableAgents = input.availableAgents ?? [];
      const availableChannels = input.availableChannels ?? [];
      // Bind the engine-level systemPrompt into the message build. Per-call
      // `input.systemPrompt` is ignored — it is a server-side concern, not a
      // per-turn override (would break the cacheable prefix invariant).
      const messageInput: ReasonerInput = systemPrompt !== undefined
        ? { ...input, systemPrompt }
        : input;

      if (availableActions.length === 0) {
        return Err("openai-reasoner: no available actions — nothing to propose");
      }

      // Optional tools are only offered when there is a valid target — a delegate
      // tool needs another agent, a send_message tool needs a bound channel,
      // system:use_tool/system:get_tool_schema need at least one registered tool.
      const tools: ChatCompletionTool[] = [buildTool(availableActions), buildFinishTool()];
      if (availableAgents.length > 0) tools.push(buildDelegateTool(availableAgents));
      if (availableAgents.length > 0) tools.push(buildMentionTool(availableAgents));
      if (availableChannels.length > 0) tools.push(buildCommunicateTool(availableChannels));
      const availableToolNames = input.availableTools?.map((t) => t.name) ?? [];
      if (availableToolNames.length > 0) {
        tools.push(buildUseToolTool(availableToolNames));
        tools.push(buildGetToolSchemaTool(availableToolNames));
      }

      const apiStart = Date.now();
      const apiResult = await safeTry(async () => client.chat.completions.create({
        model,
        // `max_completion_tokens` is the current field; `max_tokens` is
        // deprecated and rejected by newer models. Temperature and top_p are
        // forwarded only when explicitly configured — newer reasoning models
        // reject non-default sampling params.
        max_completion_tokens: maxTokens,
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.topP !== undefined ? { top_p: config.topP } : {}),
        messages: buildMessages(messageInput),
        tools,
        tool_choice: "required",
      }));
      if (apiResult.isErr) return Err(`openai-reasoner: API request failed — ${apiResult.error}`);
      const latencyMs = Date.now() - apiStart;

      return await parseToolCall(apiResult.value, messageInput, latencyMs);
    },
  };
};
