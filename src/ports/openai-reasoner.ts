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

import { Ok, Err } from "slang-ts";
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
   * Chat completions model. Defaults to "gpt-4o-mini" — cost-effective
   * and sufficiently capable for governed action selection.
   */
  model?: string;
  /**
   * Sampling temperature. Defaults to 0 for deterministic, reproducible
   * action selection. Increase for exploratory agents.
   */
  temperature?: number;
  /** Maximum output tokens. Defaults to 512. */
  maxTokens?: number;
  /**
   * Custom fetch implementation. Useful for tests that need to return
   * scripted responses without making real HTTP calls.
   */
  fetch?: FetchFn;
};

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TEMPERATURE = 0;
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

// ── Message builder ───────────────────────────────────────────────────────────

const buildMessages = (input: ReasonerInput): ChatCompletionMessageParam[] => {
  const { task, availableActions, availableAgents, agentRole, rolePrompt, context } = input;
  const canDelegate = availableAgents !== undefined && availableAgents.length > 0;

  const system: ChatCompletionMessageParam = {
    role: "system",
    content: [
      `You are ${agentRole}. ${rolePrompt}`,
      "",
      "You are driving a governed execution task. Each turn you must call exactly one tool.",
      "Call request_action with the action name and the parameters that action needs.",
      "Only call actions listed in the user message — all others are outside your authority.",
      ...(canDelegate
        ? ["Call delegate_task to hand a scoped sub-goal to one of the available agents."]
        : []),
      "When the goal is fully satisfied and no further action is needed, call finish_task instead.",
    ].join("\n"),
  };

  const userLines = [
    `Task goal: ${task.goal}`,
    `Task ID: ${task.id}`,
    `Available actions: ${availableActions.join(", ")}`,
  ];
  if (canDelegate) {
    userLines.push(`Available agents to delegate to: ${availableAgents.join(", ")}`);
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
 * Tokens the model spent producing this turn, read from the provider's usage
 * metadata. Folded into the action's recorded cost so token budget enforcement
 * is real. Duration is left to the gateway (it times fn execution).
 */
const reasoningCostFrom = (
  response: OpenAI.Chat.Completions.ChatCompletion,
): { tokens: number; durationMs: number } => ({
  tokens: response.usage?.total_tokens ?? 0,
  durationMs: 0,
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

const parseToolCall = (
  response: OpenAI.Chat.Completions.ChatCompletion,
  availableActions: string[],
  availableAgents: string[],
): Result<ReasonerDecision, string> => {
  const choice = response.choices[0];
  if (choice === undefined) {
    return Err("openai-reasoner: API response contained no choices");
  }

  const toolCalls = choice.message.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    return Err(
      `openai-reasoner: model did not call a tool (finish_reason: "${choice.finish_reason}")`,
    );
  }

  const call = toolCalls[0];
  // Narrow the union: only function-type tool calls carry a .function property.
  if (call === undefined || call.type !== "function") {
    return Err(
      `openai-reasoner: unexpected tool type "${call?.type ?? "none"}" — expected "function"`,
    );
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    return Err(
      `openai-reasoner: failed to parse tool arguments as JSON: ${call.function.arguments}`,
    );
  }

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

  if (call.function.name !== "request_action") {
    return Err(
      `openai-reasoner: unexpected tool name "${call.function.name}" — expected "request_action", "delegate_task", or "finish_task"`,
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
      reasoningCost: reasoningCostFrom(response),
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
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
  });

  const model = config.model ?? DEFAULT_MODEL;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    reason: async (input: ReasonerInput): Promise<Result<ReasonerDecision, string>> => {
      const { availableActions } = input;
      const availableAgents = input.availableAgents ?? [];

      if (availableActions.length === 0) {
        return Err("openai-reasoner: no available actions — nothing to propose");
      }

      // The delegate tool is only offered when there is at least one other agent
      // to hand work to — otherwise the model has no valid delegation target.
      const tools: ChatCompletionTool[] = [buildTool(availableActions), buildFinishTool()];
      if (availableAgents.length > 0) tools.push(buildDelegateTool(availableAgents));

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await client.chat.completions.create({
          model,
          temperature,
          max_tokens: maxTokens,
          messages: buildMessages(input),
          tools,
          tool_choice: "required",
        });
      } catch (e) {
        return Err(`openai-reasoner: API request failed — ${String(e)}`);
      }

      return parseToolCall(response, availableActions, availableAgents);
    },
  };
};
