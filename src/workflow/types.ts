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
  /** Index in the phase action list to begin at. Lets supervision `retry`
   *  resume from the failed action instead of re-running from the top.
   *  Defaults to 0 (run the whole phase). */
  startIndex?: number;
  /** The agent's full declared skill set, used to resolve phase/action skill refs. */
  agentSkills?: Skill[];
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
  /** The agent's full declared skill set, used to resolve phase/action skill refs. */
  agentSkills?: Skill[];
};
