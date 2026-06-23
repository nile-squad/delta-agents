/**
 * delta.dataSource({ ... }) — define a named, owned store of governed CRUD operations.
 *
 * A DataSource groups up to four operations (retrieve / create / update / delete)
 * over one data store, with ownership and content-type metadata. Each operation is
 * a full Action: it carries a schema and runs through the same execution gateway as
 * any other action, so a data read or write is governed identically (schema
 * validation, legality, approval, budget, risk, trust, audit). Create the operations
 * with delta.action (which registers them), then attach them here.
 *
 * Validates the definition at call time and registers the DataSource so it is
 * inspectable. An agent reaches the store by listing the DataSource in
 * `dataSources`; delta.agent then flattens its operations into the agent's
 * reachable action set (ADR-007).
 *
 * Throws on validation or registration failure because an invalid definition is a
 * programming error, not a recoverable runtime condition (AGENTS.md: "Critical
 * harm → throw fast").
 */

import type { DataSource } from "./types";
import type { Registry } from "./registry";
import { validateDataSource } from "./validate";

export const makeDefineDataSource = ({ registry }: { registry: Registry }) =>
  (definition: DataSource): DataSource => {
    const validation = validateDataSource(definition);
    if (validation.isErr) {
      throw new Error(`delta.dataSource validation failed: ${validation.error}`);
    }

    const result = registry.registerDataSource(definition);
    if (result.isErr) {
      throw new Error(`delta.dataSource registration failed: ${result.error}`);
    }

    return definition;
  };
