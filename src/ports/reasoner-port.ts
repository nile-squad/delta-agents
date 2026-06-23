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
 * What the reasoner returns when it wants to hand a scoped sub-goal to another
 * agent. Delegation is bounded (spec §Delegation Is Bounded): the engine creates
 * a child task whose budget is clamped to the parent's remaining headroom
 * (invariant 18) and whose execution is governed by the binary supervision tree
 * (at most two active subtasks, invariant 15; the rest queue, invariant 16).
 */
export type DelegationRequest = {
  /** The scoped objective handed to the child agent. */
  goal: string;
  /** Name of a registered agent that will own the child task. */
  agentName: string;
  /**
   * Requested child budget. Clamped to the parent's remaining budget before the
   * child runs — a subtask never gains authority beyond its parent scope. When
   * omitted, the child inherits the parent's entire remaining budget.
   */
  budget?: Cost;
};

/**
 * What the reasoner returns when it wants to send a message through one of the
 * agent's bound channels (Slack, email, WhatsApp, …). The channel instance is
 * already recipient/thread-bound (the Chat SDK thread it wraps), so only the
 * channel selector and the message body are needed. The engine routes it to the
 * channel, optionally gates it behind human approval, and records a
 * TaskID-attributable Message (invariant 9).
 */
export type CommunicationRequest = {
  /** Type of the bound channel to send through (must match one the agent declares). */
  channel: string;
  /** The message body to send. */
  body: string;
};

/**
 * What the reasoner returns when it wants to mention a teammate: reference a
 * named agent on the same team and leave them a note on this task. Unlike
 * delegation, a mention does not spawn a child task or hand off work; it records
 * a TaskID-attributable agent-to-agent Message (sender → receiver). It is scoped
 * to the agent's team: the engine rejects a mention of a non-teammate.
 */
export type MentionRequest = {
  /** Name of a teammate (an agent sharing this agent's `team`). */
  agentName: string;
  /** The note left for the mentioned teammate. */
  message: string;
};

/**
 * A reasoner decision is explicit: commit to one action, delegate a scoped
 * sub-goal, mention a teammate, communicate through a channel, or declare the
 * task done. Completion is never inferred from the reasoner failing or running
 * out — those are distinct, observable outcomes (a clean `done` versus an `Err`
 * model/API failure). This keeps `status: "completed"` trustworthy.
 */
export type ReasonerDecision =
  | { kind: "act"; request: ActionRequest }
  | { kind: "delegate"; delegation: DelegationRequest }
  | { kind: "mention"; mention: MentionRequest }
  | { kind: "communicate"; communication: CommunicationRequest }
  | { kind: "done"; reason?: string };

export type ReasonerInput = {
  task: Task;
  /** Names of actions currently discoverable given the task state-space. */
  availableActions: string[];
  /**
   * Names of agents this agent may delegate a scoped sub-goal to. Constrains the
   * `delegate` decision the way `availableActions` constrains `act`: the model
   * cannot delegate to an agent outside this set. Empty (or absent) means
   * delegation is not offered this turn.
   */
  availableAgents?: string[];
  /**
   * Channel types this agent may send through. Constrains the `communicate`
   * decision; empty (or absent) means communication is not offered this turn.
   */
  availableChannels?: string[];
  /**
   * Active skills available to this agent, surfaced so the model knows its
   * specialized capabilities. Inactive skills are omitted. `content` is the
   * skill's loaded body, present when the engine is configured with a `loadSkill`
   * loader (the library does not assume a filesystem, so the consumer provides
   * it); absent when no loader is configured or loading failed.
   */
  availableSkills?: Array<{ name: string; description: string; content?: string }>;
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
