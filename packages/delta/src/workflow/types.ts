/**
 * Workflow control flow types.
 *
 * NextStep is returned by resolveNextStep after each action and controls
 * which position the phase runner moves to next. The three kinds map directly
 * to spec outcomes: keep going, end the phase cleanly, or end with failure.
 *
 * RunPhaseInput and RunWorkflowInput carry everything the runners need.
 * inputFor provides raw input for each action so the caller controls how
 * arguments are supplied (e.g. from reasoner output in Phase 8).
 */

import type { Phase, Workflow, Action, ActionContext, Skill } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { StoragePort } from "../ports/storage-port";
import type { ApprovalStatus } from "../execution/types";
import type { Diagnostics } from "../shared/diagnostics";

export type NextStep =
  | {
      kind: "continue";
      nextIndex: number;
      /**
       * True when this continuation was caused by a branch routing to a named
       * target (not natural sequential advancement). The phase runner uses this
       * to terminate after the jump target completes rather than continuing into
       * the rest of the sequential list — enforcing the decision-tree semantics
       * where each branch route leads to one terminal step (invariant 21).
       */
      viaJump: boolean;
    }
  | { kind: "end-success" }
  | { kind: "end-failure"; reason: string };

export type PhaseResult =
  | { status: "completed"; snapshot: TaskStateSnapshot }
  | {
      status: "failed";
      snapshot: TaskStateSnapshot;
      failedAction?: string;
      failedReason: string;
      /** Index of the action that failed — lets supervision `retry` resume from it. */
      failedIndex?: number;
    }
  // An action escalated mid-phase; the task is paused awaiting human oversight.
  | { status: "blocked"; snapshot: TaskStateSnapshot; reason: string };

export type WorkflowResult =
  | { status: "completed"; snapshot: TaskStateSnapshot }
  | {
      status: "failed";
      snapshot: TaskStateSnapshot;
      failedPhase?: string;
      failedReason: string;
    }
  // A phase escalated (or its supervision strategy escalated); task is paused.
  | { status: "blocked"; snapshot: TaskStateSnapshot; failedPhase?: string; reason: string };

export type RunPhaseInput = {
  phase: Phase;
  /** Lookup map: action name → Action definition. */
  actionRegistry: Map<string, Action>;
  state: TaskStateSnapshot;
  getApprovalStatus: (actionName: string) => ApprovalStatus;
  /** Returns raw (unvalidated) input for an action. Gateway validates it. */
  inputFor: (actionName: string) => Record<string, unknown>;
  store: StoragePort;
  /** Governed channel-send helper exposed to phase/action hooks via ctx.communicate. */
  communicate?: ActionContext["communicate"];
  /** Memory-write helper exposed to phase/action hooks via ctx.remember. */
  remember?: ActionContext["remember"];
  /** The task's goal, threaded onto ctx.goal for phase/action hooks and guards. Absent when the caller carries no goal. */
  goal?: ActionContext["goal"];
  /** Attachments threaded onto ctx.attachments (parity with ToolContext). Absent or empty when the task carries none. */
  attachments?: ActionContext["attachments"];
  /** Memory-read helper exposed to phase/action hooks via ctx.recall. */
  recall?: ActionContext["recall"];
  /** Read-only cost snapshot threaded onto ctx.budget so a long-running action can self-limit. */
  budget?: ActionContext["budget"];
  /** The enclosing workflow's name, threaded onto ctx.workflowName. Derived by runWorkflow from the workflow. */
  workflowName?: ActionContext["workflowName"];
  /** Index in the phase action list to begin at. Lets supervision `retry`
   *  resume from the failed action instead of re-running from the top.
   *  Defaults to 0 (run the whole phase). */
  startIndex?: number;
  /** True when `startIndex` points at a branch jump target (persisted as
   *  `currentActionViaJump` on the escalation checkpoint): the resumed phase
   *  must still terminate after that action completes, preserving the
   *  decision-tree semantics across a pause/resume boundary (invariant 21).
   *  Only meaningful together with `startIndex`. */
  startViaJump?: boolean;
  /** The agent's full declared skill set, used to resolve phase/action skill refs. */
  agentSkills?: Skill[];
  /**
   * Workflow-level narrative, plumbed from runWorkflow so phase hooks and
   * action fns receive it. Threaded onto ActionContext.storyline.
   */
  storyline?: string;
  /**
   * Per-engine diagnostics handle. Threaded into the gateway so opt-in
   * modules can emit structured events (e.g. action-start / action-end).
   * Optional so standalone unit tests can call runPhase directly without
   * wiring a full diagnostics handle — the gateway treats undefined as
   * "diagnostics disabled".
   */
  diagnostics?: Diagnostics;
  /** Whether to compute guidance lines from warning bands. Defaults to true. */
  guidanceEnabled?: boolean;
};

export type RunWorkflowInput = {
  workflow: Workflow;
  actionRegistry: Map<string, Action>;
  state: TaskStateSnapshot;
  getApprovalStatus: (actionName: string) => ApprovalStatus;
  inputFor: (actionName: string) => Record<string, unknown>;
  store: StoragePort;
  /** Governed channel-send helper exposed to workflow/phase/action hooks via ctx.communicate. */
  communicate?: ActionContext["communicate"];
  /** Memory-write helper exposed to workflow/phase/action hooks via ctx.remember. */
  remember?: ActionContext["remember"];
  /** The task's goal, threaded onto ctx.goal for workflow/phase/action hooks and guards. Absent when the caller carries no goal. */
  goal?: ActionContext["goal"];
  /** Attachments threaded onto ctx.attachments (parity with ToolContext). Absent or empty when the task carries none. */
  attachments?: ActionContext["attachments"];
  /** Memory-read helper exposed to workflow/phase/action hooks via ctx.recall. */
  recall?: ActionContext["recall"];
  /** Read-only cost snapshot threaded onto ctx.budget so a long-running action can self-limit. */
  budget?: ActionContext["budget"];
  /** The agent's full declared skill set, used to resolve phase/action skill refs. */
  agentSkills?: Skill[];
  /**
   * Per-engine diagnostics handle. Threaded into every phase + action so
   * opt-in modules can emit structured events. Same shape as the engine's
   * diagnostics — disabled modules pay zero overhead. Optional for direct
   * test callers; the engine always provides one.
   */
  diagnostics?: Diagnostics;
  /** Whether to compute guidance lines from warning bands. Defaults to true. */
  guidanceEnabled?: boolean;
};
