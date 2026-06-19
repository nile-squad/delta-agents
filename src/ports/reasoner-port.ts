/**
 * ReasonerPort — model-reasoning boundary.
 *
 * Governance logic calls this interface to get the agent's next action request.
 * The mock adapter returns deterministic scripted responses for tests.
 * The OpenAI adapter replaces it in production (Phase 10) without changing
 * any governance code — the engine is bounded regardless of model capability
 * (README: "A weaker model is still safe. A stronger model is still bounded.").
 *
 * The reasoner never directly executes anything. It proposes an action name and
 * input. The execution gateway decides whether to authorise it.
 */

import type { Result } from "slang-ts";
import type { Task } from "../shared/types";

// What the reasoner returns: a proposed action and the input it wants to pass.
export type ActionRequest = {
  /** Name of the action being requested. Must match a registered action name. */
  actionName: string;
  /** Input payload the reasoner wants to pass to the action function. */
  input: Record<string, string | number | boolean | null>;
  /** Optional reasoning trace for audit/diagnostics. Not used for governance decisions. */
  reasoning?: string;
};

export type ReasonerInput = {
  task: Task;
  /** Names of actions currently discoverable given the task state-space. */
  availableActions: string[];
  agentRole: string;
  rolePrompt: string;
  /** Retrieved memory/context injected by the memory retrieval step. */
  context?: string;
};

export type ReasonerPort = {
  /**
   * Reason about the current task state and return a proposed action request.
   * Returns Err when the model cannot produce a valid proposal (e.g., no available
   * actions, model failure, safety refusal).
   */
  reason: (input: ReasonerInput) => Promise<Result<ActionRequest, string>>;
};
