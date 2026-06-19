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
import type { Execution } from "../shared/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { Action } from "../authoring/types";
import type { StoragePort } from "../ports/storage-port";

export type ApprovalStatus = "none" | "pending" | "approved";

export type GatewayInput = {
  action: Action;
  /** Raw, unvalidated input from the reasoner. Validated by action.schema before fn runs. */
  rawInput: Record<string, unknown>;
  state: TaskStateSnapshot;
  approvalStatus: ApprovalStatus;
  store: StoragePort;
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
   * Snapshot updated with: spent cost, trust, risk, and (only on Ok) completedActions.
   * The caller persists this to the task record.
   */
  updatedSnapshot: TaskStateSnapshot;
};
