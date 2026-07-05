/**
 * Execution gateway types.
 *
 * GatewayInput packages everything the gateway needs: the action definition,
 * raw (unvalidated) input, current task state, the caller's declared approval
 * status, and a storage handle for writing the Execution record.
 *
 * GatewaySuccess is returned when fn() actually ran — even if fn itself
 * returned Err. The outer Result<GatewaySuccess, string> signals whether
 * the gateway completed its pipeline (fn ran) or blocked before fn (Err).
 * This two-level distinction prevents callers from inferring success from the
 * absence of an outer error (spec invariant 19, prohibition 18).
 */

import type { Result } from "slang-ts";
import type { Execution, Cost } from "../shared/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { Action, ActionContext } from "../authoring/types";
import type { StoragePort } from "../ports/storage-port";
import type { Diagnostics } from "../shared/diagnostics";

export type ApprovalStatus = "none" | "pending" | "approved" | "rejected";

export type GatewayInput = {
  action: Action;
  /** Raw, unvalidated input from the reasoner. Validated by action.schema before fn runs. */
  rawInput: Record<string, unknown>;
  state: TaskStateSnapshot;
  approvalStatus: ApprovalStatus;
  store: StoragePort;
  /**
   * Model tokens the reasoner spent proposing this action, reported by the
   * adapter. Folded into the execution's recorded cost so token budget
   * enforcement is real. Absent (mock) means zero token cost for this step.
   */
  reasoningCost?: Cost;
  /**
   * 0-based step index in the driving loop. Feeds the progress proxy used by
   * friction detection (distinct completions per attempted step). Defaults to 0.
   */
  stepIndex?: number;
  /**
   * Governed channel-send helper, threaded onto the ActionContext so an action
   * fn or hook can send a message. Built by the engine where the agent (and its
   * channels) is known. Absent for standalone gateway calls (e.g. unit tests).
   */
  communicate?: ActionContext["communicate"];
  /** Memory-write helper threaded onto the ActionContext (ctx.remember). */
  remember?: ActionContext["remember"];
  /**
   * The task's goal, threaded onto ActionContext.goal so an action fn, hook, or
   * guard can reason about intent. Absent for standalone gateway calls (e.g. a
   * unit test) that carry no goal.
   */
  goal?: ActionContext["goal"];
  /**
   * The enclosing workflow's name, threaded onto ActionContext.workflowName.
   * Absent in the free reasoner loop and in standalone gateway calls.
   */
  workflowName?: ActionContext["workflowName"];
  /** Attachments threaded onto ActionContext.attachments (parity with ToolContext). Absent or empty when the task carries none. */
  attachments?: ActionContext["attachments"];
  /** Memory-read helper threaded onto the ActionContext (ctx.recall). Counterpart of `remember`. */
  recall?: ActionContext["recall"];
  /** Read-only cost snapshot threaded onto ActionContext.budget so a long-running action can self-limit. Absent when the caller carries no budget. */
  budget?: ActionContext["budget"];
  /** Skills active at this action's invocation point. Threaded onto ctx.availableSkills. */
  availableSkills?: ActionContext["availableSkills"];
  /**
   * Workflow-level narrative, threaded onto ActionContext.storyline for action
   * fn and hooks. Absent in the free reasoner loop (no workflow context).
   */
  storyline?: ActionContext["storyline"];
  /**
   * Phase-level narrative beat, threaded onto ActionContext.phaseStoryline for
   * action fn and hooks. Absent in the free reasoner loop and at workflow scope.
   */
  phaseStoryline?: ActionContext["phaseStoryline"];
  /**
   * Per-engine diagnostics handle. When the `actions` module is enabled, the
   * gateway emits action-start / action-end events around fn. Absent in
   * standalone gateway calls (e.g. unit tests) — the gateway skips the
   * emission paths and behaves as before.
   */
  diagnostics?: Diagnostics;
};

export type GatewaySuccess = {
  /**
   * The Result returned by action.fn — Ok or Err.
   * The engine reads this to update trust/risk/completedActions.
   * Never inferred from the absence of a throw (prohibition 18).
   */
  fnResult: Result<unknown, string>;
  /** Execution record written to store before fn ran. Finalised after fn returns. */
  execution: Execution;
  /**
   * Snapshot updated with: spent cost, trust, risk, Kalman health, and (only on
   * Ok) completedActions. The caller persists this to the task record.
   */
  updatedSnapshot: TaskStateSnapshot;
  /**
   * Bayesian surprise magnitude [0,1] for this step (observed vs predicted
   * health). The loop forwards it to checkEscalation so a large divergence can
   * trigger oversight — previously this signal was never computed.
   */
  surpriseMagnitude: number;
};
