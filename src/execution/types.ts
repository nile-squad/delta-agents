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
