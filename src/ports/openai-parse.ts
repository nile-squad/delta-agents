/**
 * Response parsing for the OpenAI reasoner: turns a chat-completion response's
 * forced tool call into a `ReasonerDecision`, and derives the per-turn Cost
 * from usage metadata + measured latency.
 */

import { Ok, Err, option, safeTry } from "slang-ts";
import type { Result } from "slang-ts";
import OpenAI from "openai";
import type { ReasonerInput, ReasonerDecision } from "./reasoner-port";
import type { Cost } from "../shared/types";
import {
  FINISH_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  MENTION_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  USE_TOOL_NAME,
  GET_TOOL_SCHEMA_NAME,
  GET_TOOL_HISTORY_NAME,
  GET_TOOL_HISTORY_ENTRY_NAME,
  SEARCH_COMMITS_NAME,
  COMMIT_NAME,
} from "./openai-tool-defs";

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Cost the model spent producing this turn: tokens from the provider's usage
 * metadata, and the measured API round-trip as `latency` (a real cost axis).
 * Duration (fn execution time) is left to the gateway.
 */
export const reasoningCostFrom = (
  response: OpenAI.Chat.Completions.ChatCompletion,
  latencyMs: number,
): Cost => ({
  tokens: response.usage?.total_tokens ?? 0,
  durationMs: 0,
  latency: latencyMs,
});

/** Parse an optional budget object from delegate_task arguments. */
export const parseBudget = (raw: unknown): Cost | undefined => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const tokens = obj["tokens"];
  const durationMs = obj["durationMs"];
  if (typeof tokens !== "number" || typeof durationMs !== "number") return undefined;
  return { tokens, durationMs };
};

export const parseToolCall = async (
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

  // Tool history — model wants the full recorded tool history (truncated entries).
  if (call.function.name === GET_TOOL_HISTORY_NAME) {
    return Ok({ kind: "tool-info", request: { type: "history" } });
  }

  // Tool history entry — model wants a single full (untruncated) entry by index.
  if (call.function.name === GET_TOOL_HISTORY_ENTRY_NAME) {
    const index = args["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      return Err(`openai-reasoner: system:get_tool_history_entry index must be a non-negative integer in arguments: ${JSON.stringify(args)}`);
    }
    return Ok({ kind: "tool-info", request: { type: "history-entry", index } });
  }

  // Search commits — model wants to query the commit store for past records.
  // Builds a CommitQuery from optional args; the scheduler executes it and
  // stores the result in toolInfoResult (same pattern as tool-info).
  if (call.function.name === SEARCH_COMMITS_NAME) {
    const query: { query?: string; workflowName?: string; allAgents?: boolean; limit?: number } = {};
    if (typeof args["query"] === "string" && args["query"].length > 0) query.query = args["query"];
    if (typeof args["workflow_name"] === "string" && args["workflow_name"].length > 0) query.workflowName = args["workflow_name"];
    if (typeof args["all_agents"] === "boolean") query.allAgents = args["all_agents"];
    if (typeof args["limit"] === "number" && args["limit"] > 0) query.limit = Math.min(args["limit"], 100);
    return Ok({ kind: "search-commits", query });
  }

  // Commit — model wants to record a voluntary checkpoint during the free-loop.
  // The optional notes are passed through; the scheduler creates the Commit record.
  if (call.function.name === COMMIT_NAME) {
    const notes = typeof args["notes"] === "string" && args["notes"].length > 0 ? args["notes"] : undefined;
    return Ok({ kind: "commit", notes });
  }

  if (call.function.name !== "request_action") {
    return Err(
      `openai-reasoner: unexpected tool name "${call.function.name}" — expected "request_action", "delegate_task", "mention_teammate", "send_message", "finish_task", "system:use_tool", "system:get_tool_schema", "system:get_tool_history", "system:get_tool_history_entry", "system:search_commits", or "system:commit"`,
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
