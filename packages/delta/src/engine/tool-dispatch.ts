/**
 * Tool-related decision handling for the scheduler's single-step driver.
 *
 * Extracted from `stepTask` in `./scheduler`: the branches for `system:use_tool`
 * execution, the `tool-info` requests (schema / history / history-entry),
 * `system:search_commits`, and the free-loop `system:commit`. Each handler takes
 * the same slice of `stepTask`'s local state it used inline (task, agent,
 * snapshot, registry/store, loopDetector) as named params and returns the exact
 * `StepOutcome` the inline branch used to produce — this is code motion, not a
 * behavior change.
 */

import { option, safeTry } from "slang-ts";
import type { Task, Commit } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerDecision } from "../ports/reasoner-port";
import type { Registry } from "../authoring/registry";
import type { Agent, ToolHistoryEntry } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import { toJSONSchema, prettifyError } from "zod";
import { executionId, commitId } from "../shared/id";
import type { LoopDetector } from "./loop-detector";
import type { StepOutcome } from "./scheduler";

// ── Tool output helpers ──────────────────────────────────────────────────────

/** Default character limit for tool output stored in history (progressive disclosure). */
export const TOOL_OUTPUT_LIMIT = 500;

type Truncated = { value: string; truncated: boolean };

/** Stringify + truncate a tool output for history storage. */
export const truncateToolOutput = (output: unknown): Truncated => {
  const raw = typeof output === "string" ? output : JSON.stringify(output);
  if (raw.length <= TOOL_OUTPUT_LIMIT) return { value: raw, truncated: false };
  return { value: raw.slice(0, TOOL_OUTPUT_LIMIT), truncated: true };
};

// ── system:use_tool ──────────────────────────────────────────────────────────

/**
 * Execute a registered tool: validate the model-supplied input against the
 * tool's schema, then run the tool fn with a TaskID-attributable context.
 * Truncates the output and stamps it with a token estimate so history stays
 * bounded but useful. A schema-invalid call is recorded as a failed entry (so
 * the model can self-correct) and the loop continues — the same shape as an
 * action that returns Err.
 *
 * Loop detection (Phase 4): before the tool runs, the per-run loopDetector is
 * consulted. Order is budget (hard cap) → cooldown (rate limit) → max-calls
 * per phase → max-calls per task. A blocked call is NOT counted (counters only
 * bump on actual execution) and the reasoner sees a humanized block reason via
 * `lastToolInfoResult` on its next turn.
 */
export const handleToolExecution = async ({
  decision,
  agent,
  task,
  snapshot,
  registry,
  loopDetector,
  goal,
}: {
  decision: Extract<ReasonerDecision, { kind: "tool" }>;
  agent: Agent;
  task: Task;
  snapshot: TaskStateSnapshot;
  registry: Registry;
  loopDetector: LoopDetector;
  /** The task's goal, threaded onto ToolContext.goal so a tool can reason about intent. Absent when the caller carries no goal. */
  goal?: string;
}): Promise<StepOutcome> => {
  const toolCall = decision.toolCall;
  const toolResult = registry.getTool(toolCall.toolName);
  if (toolResult.isErr) {
    return { kind: "failed", snapshot, reason: `tool not found: ${toolCall.toolName}` };
  }
  const tool = toolResult.value;
  const parsed = tool.schema.safeParse(toolCall.input);
  if (!parsed.success) {
    const errorMessage = prettifyError(parsed.error);
    const entry: ToolHistoryEntry = {
      id: executionId(),
      toolName: tool.name,
      input: toolCall.input,
      output: { error: `schema-invalid: ${errorMessage}` },
      truncated: false,
      timestamp: Date.now(),
      agentName: agent.name,
      ...(snapshot.currentPhase !== undefined ? { phaseName: snapshot.currentPhase } : {}),
    };
    const history = [...(snapshot.toolHistory ?? []), entry];
    return { kind: "stepped", snapshot: { ...snapshot, toolHistory: history } };
  }
  // Budget first: a hard cap overrides rate-limit / count limits.
  if (tool.cost !== undefined && tool.budget !== undefined) {
    const blockReason = loopDetector.checkBudget(agent.name, tool.name, tool.cost, tool.budget);
    if (blockReason !== undefined) {
      return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: JSON.stringify({ error: blockReason }) } };
    }
  }
  if (tool.limits?.cooldownMs !== undefined) {
    const blockReason = loopDetector.checkToolCooldown(agent.name, tool.name, tool.limits.cooldownMs);
    if (blockReason !== undefined) {
      return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: JSON.stringify({ error: blockReason }) } };
    }
  }
  if (tool.limits?.maxCallsPerPhase !== undefined) {
    const blockReason = loopDetector.checkMaxCalls(agent.name, tool.name, tool.limits.maxCallsPerPhase, "phase");
    if (blockReason !== undefined) {
      return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: JSON.stringify({ error: blockReason }) } };
    }
  }
  if (tool.limits?.maxCallsPerTask !== undefined) {
    const blockReason = loopDetector.checkMaxCalls(agent.name, tool.name, tool.limits.maxCallsPerTask, "task");
    if (blockReason !== undefined) {
      return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: JSON.stringify({ error: blockReason }) } };
    }
  }
  // All checks pass: bump counters and charge spend before running the fn.
  loopDetector.recordToolCall(agent.name, tool.name);
  if (tool.cost !== undefined) {
    loopDetector.recordToolSpend(agent.name, tool.name, tool.cost);
  }
  const toolHistory = snapshot.toolHistory ?? [];
  const fnResult = await safeTry(async () => tool.fn({
    data: parsed.data,
    ctx: {
      agentName: agent.name,
      taskId: task.id,
      ...(snapshot.currentPhase !== undefined ? { phaseName: snapshot.currentPhase } : {}),
      ...(goal !== undefined ? { goal } : {}),
      toolHistory,
      ...(snapshot.attachments !== undefined && snapshot.attachments.length > 0 ? { attachments: snapshot.attachments } : {}),
    },
  }));
  const outputValue = fnResult.isOk
    ? fnResult.value
    : { error: fnResult.error };
  const { value: truncatedOutput, truncated } = truncateToolOutput(outputValue);
  const tokenCount = Math.ceil(JSON.stringify(outputValue).length / 4);
  const entry: ToolHistoryEntry = {
    id: executionId(),
    toolName: tool.name,
    input: toolCall.input,
    output: truncatedOutput,
    truncated,
    timestamp: Date.now(),
    agentName: agent.name,
    tokenCount,
    ...(snapshot.currentPhase !== undefined ? { phaseName: snapshot.currentPhase } : {}),
    ...(tool.cost !== undefined ? { cost: tool.cost } : {}),
    // Keep the full value alongside the truncated inline copy so the model
    // can retrieve it on demand via get_tool_history_entry.
    ...(truncated ? { outputFull: outputValue } : {}),
  };
  const history = [...toolHistory, entry];
  return { kind: "stepped", snapshot: { ...snapshot, toolHistory: history } };
};

// ── system:get_tool_schema / get_tool_history / get_tool_history_entry ──────

/**
 * Handle a tool-info request: the model wants a tool's schema, the full
 * history, or a single history entry. Each shape is stored on the snapshot as
 * a JSON string in `lastToolInfoResult`; the next reason() call surfaces it in
 * the user message via ReasonerInput.toolInfoResult.
 */
export const handleToolInfo = ({
  decision,
  snapshot,
  registry,
}: {
  decision: Extract<ReasonerDecision, { kind: "tool-info" }>;
  snapshot: TaskStateSnapshot;
  registry: Registry;
}): StepOutcome => {
  const request = decision.request;
  if (request.type === "schema") {
    const toolResult = registry.getTool(request.toolName);
    if (toolResult.isErr) {
      return { kind: "failed", snapshot, reason: `tool not found: ${request.toolName}` };
    }
    const schemaJson = toJSONSchema(toolResult.value.schema);
    const payload = JSON.stringify({ toolName: request.toolName, schema: schemaJson });
    return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: payload } };
  }
  if (request.type === "history") {
    // Return the full history (truncated entries) so the model can review
    // what has happened. Entries are already bounded by the per-call limit.
    const history = snapshot.toolHistory ?? [];
    const payload = JSON.stringify({ toolHistory: history });
    return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: payload } };
  }
  // request.type === "history-entry": full (untruncated) entry at index.
  // The inline `output` is bounded; when `outputFull` was kept at execution
  // time we surface that here so the model gets the complete value.
  const history = snapshot.toolHistory ?? [];
  const idx = option(history[request.index]);
  if (idx.isNone) {
    return {
      kind: "stepped",
      snapshot: { ...snapshot, lastToolInfoResult: JSON.stringify({ error: `index ${request.index} out of range (history has ${history.length} entries)` }) },
    };
  }
  const entry = idx.value;
  const fullEntry = entry.outputFull !== undefined
    ? { ...entry, output: entry.outputFull }
    : entry;
  const payload = JSON.stringify({ toolHistoryEntry: fullEntry });
  return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: payload } };
};

// ── system:search_commits ────────────────────────────────────────────────────

/**
 * Search across commit records for past agent checkpoint annotations. Executes
 * store.searchCommits with the model's query params, stores the result as a
 * JSON string in lastToolInfoResult (same pattern as tool-info).
 */
export const handleSearchCommits = async ({
  decision,
  snapshot,
  store,
  agent,
}: {
  decision: Extract<ReasonerDecision, { kind: "search-commits" }>;
  snapshot: TaskStateSnapshot;
  store: StoragePort;
  agent: Agent;
}): Promise<StepOutcome> => {
  const result = await store.searchCommits(decision.query, agent.name);
  const payload = result.isOk
    ? JSON.stringify({ commits: result.value })
    : JSON.stringify({ error: result.error });
  return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: payload } };
};

// ── system:commit (free-loop) ─────────────────────────────────────────────────

/**
 * Free-loop commit — model voluntarily records a checkpoint with optional
 * notes. Unlike the post-workflow commit step, this does NOT change task
 * status or end the task. The Commit is created and the loop continues.
 */
export const handleFreeLoopCommit = async ({
  decision,
  task,
  agent,
  snapshot,
  store,
}: {
  decision: Extract<ReasonerDecision, { kind: "commit" }>;
  task: Task;
  agent: Agent;
  snapshot: TaskStateSnapshot;
  store: StoragePort;
}): Promise<StepOutcome> => {
  const ckptResult = await store.getLatestCheckpoint(task.id);
  const checkpointId =
    ckptResult.isOk && ckptResult.value !== null ? ckptResult.value.id : null;
  const commit: Commit = {
    id: commitId(),
    taskId: task.id,
    agentName: agent.name,
    workflowName: null,
    notes: decision.notes ?? null,
    checkpointId,
    createdAt: new Date(),
  };
  const saveResult = await store.saveCommit(commit);
  const payload = saveResult.isOk
    ? JSON.stringify({ committed: true, notes: commit.notes })
    : JSON.stringify({ committed: false, error: saveResult.error });
  return { kind: "stepped", snapshot: { ...snapshot, lastToolInfoResult: payload } };
};
