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
import type { Task, Cost } from "../shared/types";

// What the reasoner returns: a proposed action and the input it wants to pass.
export type ActionRequest = {
  /** Name of the action being requested. Must match a registered action name. */
  actionName: string;
  /** Input payload the reasoner wants to pass to the action function. */
  input: Record<string, string | number | boolean | null>;
  /** Optional reasoning trace for audit/diagnostics. Not used for governance decisions. */
  reasoning?: string;
  /**
   * Model tokens consumed producing this proposal, reported by the adapter from
   * the provider's usage metadata. The engine folds this into the action's
   * recorded cost so token budget enforcement is real (spec §Bellman: tokens are
   * the primary governance currency). Absent for adapters that cannot report
   * usage (e.g. the mock) — treated as zero.
   */
  reasoningCost?: Cost;
};

/**
 * A reasoner decision is explicit: either commit to one action, or declare the
 * task done. Completion is no longer inferred from the reasoner failing or
 * running out — those are distinct, observable outcomes (a clean `done` versus
 * an `Err` model/API failure). This keeps `status: "completed"` trustworthy.
 */
export type ReasonerDecision =
  | { kind: "act"; request: ActionRequest }
  | { kind: "done"; reason?: string };

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
   * Reason about the current task state and return an explicit decision:
   * `act` to commit to one action, or `done` when the task is finished.
   *
   * Returns Err only for genuine failures — model/API error, safety refusal,
   * or a malformed response. The engine maps Err to a failed task, never to
   * completion (a failed reasoner is not a finished task).
   */
  reason: (input: ReasonerInput) => Promise<Result<ReasonerDecision, string>>;
};
