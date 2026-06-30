# ADR-007: DataSource Authoring Type

> **Status:** Accepted (2026-06-23).

## Context

The specification lists a `DataSource` authoring type (spec §DataSource) but leaves its contract undefined in three places: the `contentType` field references an undefined `ContentTypes` type, `authentication` references an undefined `Authentication` type, and each CRUD slot is typed as a bare `Fn` that is never defined. The spec's `Agent` type also has no field that references a data source, so there is no specified path from a DataSource to an agent or to execution.

Building the feature therefore required deciding the contract. This record states the decisions and why, so a reviewer can change them deliberately rather than discover them by reading code. The implementation is intentionally minimal and faithful to the engine's existing governance model rather than an invented superset.

## Decisions

1. **Each operation is a full `Action`, and the factory registers it.** The execution gateway is schema-first: every executable operation must carry a Zod schema (invariant 4), and governance (legality, approval, budget, risk, trust, audit) is defined on actions. A bare function cannot be governed. So each defined CRUD operation (`retrieve` / `create` / `update` / `delete`) is an `Action`, and a data read or write is governed identically to any other action with no DataSource-specific execution path. `delta.dataSource` is the sole registrar of its operations (the developer passes operation definitions, not pre-registered actions). This is what lets ownership shape the risk prior at registration time, consistently for both execution paths: the free reasoner loop resolves an action from the registry and the workflow path from the agent's action set, and both must see the same registered object.

2. **`contentType` is a free-form string.** The spec's `ContentTypes` is undefined, and AGENTS.md prohibits `enum`. A descriptive string (for example `"application/json"`) carries the intent without inventing a closed set that the spec never fixed.

3. **`authentication` is a non-secret descriptor only.** It is `{ type: string }`, the mechanism (for example `"oauth2"`, `"api-key"`, `"iam"`), never a credential. Each operation `fn` owns its own secrets through its closure, exactly as a plain action's `fn` does today. The engine never stores or transmits secrets (AGENTS.md secrets posture). This sidesteps secret handling entirely while still recording how an integration authenticates for the audit surface.

4. **`ownership` shapes the risk prior: external is less trusted by default.** External data must earn trust through a track record rather than being granted it up front. So every operation of an `ownership: "external"` source gets its risk prior floored at moderate (`EXTERNAL_RISK_FLOOR = 3` of 5); a higher declared risk is preserved, a lower one is raised to the floor. Internal operations keep their declared risk unchanged (undefined stays a cold start). The floor is a *prior*, not a permanent penalty: it seeds the Kalman estimator with a lower initial execution-health expectation, and that expectation is overridden by evidence as the operation runs successfully. An external source that performs reliably converges to the same health and trust as any other; one that misbehaves escalates sooner because it started with less benefit of the doubt. `ownership` remains inspectable audit metadata as well, so an operator can see per task whether the agent touched data outside its trust boundary.

5. **Agents reference data sources via a new `dataSources?: DataSource[]` field.** At definition time `delta.agent` flattens every attached DataSource's operations into the agent's effective `actions` set (de-duplicated by name). Once an operation is in the action set, contextual discovery, the gateway, and the workflow engine all govern it with no special-casing. The `dataSources` array is preserved on the registered agent for inspection. This mirrors how the engine already treats `Channel` (an authoring type that extends the spec's set and is handled as label-plus-functions).

## Consequences

- A DataSource adds a named, owned grouping with `ownership` / `contentType` / `authentication` metadata over governed CRUD actions. It is sugar plus audit metadata over the existing action machinery, not a new execution path. This is the smallest change that realizes the spec's intent without inventing the undefined types.
- Operation names are the developer's responsibility (the examples namespace them, for example `user-db.retrieve`). The engine does not auto-namespace, so two data sources that both define an operation named `retrieve` would collide in the registry; namespacing by convention avoids it. Auto-namespacing is a possible future refinement.
- Persistence: a DataSource is authoring-time state in the registry, like an action or workflow. Nothing about it is written to the storage port.

See [resources.md](./resources.md) for the developer-facing documentation and [delta-agents.spec.md](../internal/delta-agents.spec.md) for the canonical specification.
