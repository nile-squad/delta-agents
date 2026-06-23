/**
 * delta.dataSource({ ... }) — define a named, owned store of governed CRUD operations.
 *
 * A DataSource groups up to four operations (retrieve / create / update / delete)
 * over one data store, with ownership and content-type metadata. Each operation is
 * a full Action: it carries a schema and runs through the same execution gateway as
 * any other action, so a data read or write is governed identically (schema
 * validation, legality, approval, budget, risk, trust, audit).
 *
 * The factory is the sole registrar of its operations: pass operation definitions
 * here (do NOT pre-create them with delta.action). This lets ownership shape the
 * risk prior at registration time, consistently for both execution paths (the
 * free reasoner loop resolves an action from the registry, the workflow path from
 * the agent's action set, and both see the same registered object).
 *
 * Ownership and trust: an "external" source is less trusted by default. Its
 * operations get a raised risk prior, which seeds the Kalman estimator with a
 * lower initial execution-health expectation. That prior is not a permanent
 * penalty — it is overridden by evidence as the operation runs successfully, so
 * an external source "buys" trust through a track record rather than being granted
 * it up front (ADR-007).
 *
 * Throws on validation or registration failure because an invalid definition is a
 * programming error, not a recoverable runtime condition (AGENTS.md: "Critical
 * harm → throw fast").
 */

import type { Action, DataSource, DataSourceOwnership } from "./types";
import { DATA_SOURCE_OPERATIONS } from "./types";
import type { Registry } from "./registry";
import { validateDataSource } from "./validate";

/**
 * The risk floor applied to every operation of an external data source.
 * Moderate (3 of 5): external data is never treated as low-risk by default.
 */
export const EXTERNAL_RISK_FLOOR = 3 as const;

/**
 * Resolve an operation's effective risk prior from its data source's ownership.
 * Internal: the declared risk, unchanged (undefined stays a cold start).
 * External: at least the external floor; a higher declared risk is preserved.
 */
export const ownershipAdjustedRisk = (
  ownership: DataSourceOwnership,
  declared?: 1 | 2 | 3 | 4 | 5,
): (1 | 2 | 3 | 4 | 5) | undefined => {
  if (ownership === "internal") return declared;
  return Math.max(declared ?? EXTERNAL_RISK_FLOOR, EXTERNAL_RISK_FLOOR) as 1 | 2 | 3 | 4 | 5;
};

export const makeDefineDataSource = ({ registry }: { registry: Registry }) =>
  (definition: DataSource): DataSource => {
    const validation = validateDataSource(definition);
    if (validation.isErr) {
      throw new Error(`delta.dataSource validation failed: ${validation.error}`);
    }

    // Build ownership-adjusted operations and register each one. The adjusted
    // objects are what the agent and the gateway both see, so the risk prior is
    // applied uniformly.
    const adjusted: DataSource["actions"] = {};
    for (const op of DATA_SOURCE_OPERATIONS) {
      const action = definition.actions[op];
      if (action === undefined) continue;
      const adjustedAction: Action = {
        ...action,
        risk: ownershipAdjustedRisk(definition.ownership, action.risk),
      };
      const registered = registry.registerAction(adjustedAction);
      if (registered.isErr) {
        throw new Error(`delta.dataSource registration failed: ${registered.error}`);
      }
      adjusted[op] = adjustedAction;
    }

    const effective: DataSource = { ...definition, actions: adjusted };
    const result = registry.registerDataSource(effective);
    if (result.isErr) {
      throw new Error(`delta.dataSource registration failed: ${result.error}`);
    }

    return effective;
  };
