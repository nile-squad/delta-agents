/**
 * OpenAI chat-completion tool definitions for the reasoner.
 *
 * Each `build*Tool` function returns a `ChatCompletionTool` schema offered to
 * the model for a specific action (finish, delegate, mention, communicate,
 * and the `system:*` tool-execution/introspection tools). The `*_NAME`
 * constants are the exact tool names the model calls, and are re-used by
 * `openai-parse.ts` to dispatch on `call.function.name`.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions/completions";

// ── request_action ───────────────────────────────────────────────────────────

export const buildTool = (availableActions: string[]): ChatCompletionTool => ({
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
export const FINISH_TOOL_NAME = "finish_task";

export const buildFinishTool = (): ChatCompletionTool => ({
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
export const DELEGATE_TOOL_NAME = "delegate_task";

export const buildDelegateTool = (availableAgents: string[]): ChatCompletionTool => ({
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
export const MENTION_TOOL_NAME = "mention_teammate";

export const buildMentionTool = (availableAgents: string[]): ChatCompletionTool => ({
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
export const SEND_MESSAGE_TOOL_NAME = "send_message";

export const buildCommunicateTool = (availableChannels: string[]): ChatCompletionTool => ({
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
// tools cannot use it (validated at authoring time). These are the runtime
// hooks the model uses to interact with the tool layer.
export const USE_TOOL_NAME = "system:use_tool";
export const GET_TOOL_SCHEMA_NAME = "system:get_tool_schema";
export const GET_TOOL_HISTORY_NAME = "system:get_tool_history";
export const GET_TOOL_HISTORY_ENTRY_NAME = "system:get_tool_history_entry";
export const SEARCH_COMMITS_NAME = "system:search_commits";
export const COMMIT_NAME = "system:commit";

/**
 * The model calls `system:use_tool` to execute a registered tool. The result is
 * stored in the task's tool history; the next reason() call sees it as prior
 * tool history context.
 *
 * Only offered when at least one tool is registered. The enum constrains the
 * model to a real tool name — anything outside is rejected by the parser.
 */
export const buildUseToolTool = (availableTools: string[]): ChatCompletionTool => ({
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
export const buildGetToolSchemaTool = (availableTools: string[]): ChatCompletionTool => ({
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

/**
 * The model calls `system:get_tool_history` to retrieve the full tool history
 * recorded so far on this task (truncated entries). Only offered when there is
 * at least one prior tool call — there is nothing to retrieve otherwise.
 */
export const buildGetToolHistoryTool = (): ChatCompletionTool => ({
  type: "function",
  function: {
    name: GET_TOOL_HISTORY_NAME,
    description:
      "Return the full tool history recorded on this task so far (truncated entries). " +
      "Use this to review what tools have been called and their results.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
});

/**
 * The model calls `system:get_tool_history_entry` to retrieve a single full
 * (untruncated) history entry by index. Useful when a truncated entry hides
 * detail the model needs.
 */
export const buildGetToolHistoryEntryTool = (): ChatCompletionTool => ({
  type: "function",
  function: {
    name: GET_TOOL_HISTORY_ENTRY_NAME,
    description:
      "Return a single full (untruncated) tool history entry by index. Use this when a " +
      "truncated entry is not enough and you need the complete input or output.",
    parameters: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "Zero-based index of the history entry to retrieve.",
        },
      },
      required: ["index"],
      additionalProperties: false,
    },
  },
});

/**
 * The model calls `system:search_commits` to search across commit records
 * (agent checkpoint annotations) using optional keyword search, workflow
 * filter, or cross-agent scope. Use this to find older commits that are not
 * shown in the recent commit context automatically injected each turn.
 *
 * Always offered: no history dependency — it queries the commit store.
 * The scheduler executes the query and stores the result in toolInfoResult.
 */
export const buildSearchCommitsTool = (): ChatCompletionTool => ({
  type: "function",
  function: {
    name: SEARCH_COMMITS_NAME,
    description:
      "Search across commit records (agent checkpoint annotations) using optional " +
      "keyword search, workflow filter, or cross-agent scope. Use this to find older " +
      "commits that are not shown in the recent commit context.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword to search for in commit notes (case-insensitive substring match).",
        },
        workflow_name: {
          type: "string",
          description: "Filter by workflow name.",
        },
        all_agents: {
          type: "boolean",
          description: "When true, search across all agents. Default: your commits only.",
        },
        limit: {
          type: "number",
          description: "Max results. Default 20.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
});

/**
 * The model calls `system:commit` during the free-loop (non-workflow) send loop
 * to voluntarily record a checkpoint with optional notes. Unlike the
 * post-workflow commit step, this does not end the task — the agent continues
 * reasoning afterward.
 *
 * Always offered in the free loop. The scheduler handles persistence.
 */
export const buildCommitTool = (): ChatCompletionTool => ({
  type: "function",
  function: {
    name: COMMIT_NAME,
    description:
      "Record a checkpoint with optional notes about what you accomplished. " +
      "Use this periodically during task execution to save your progress. " +
      "This does not end the task — you can continue working after committing.",
    parameters: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description: "Optional summary of what was accomplished since the last commit.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
});
