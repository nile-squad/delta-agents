# DataSources

> **Status:** Planned, not implemented. There is no `DataSource` authoring type in the current codebase. This document records the intended design so it is not mistaken for a shipped feature.

The canonical specification describes a `DataSource` authoring type: a developer-configured handle to an internal or external data store that an agent can read from and write to under governance. As of this writing none of it exists in `src/`. There is no `delta.dataSource` method on the engine, no `DataSource` type, and no execution path that touches one. Do not write code against this document.

## What is shipped today

Agents reach data through **actions**, not DataSources. An action wraps a `fn` that the developer supplies; that `fn` is free to call a database, an HTTP API, or any other resource. The governance the engine provides (schema validation, legality, approval gates, budget, risk, trust, audit) applies to the action, not to a typed data handle. See [architecture.md](./architecture.md) for the execution gateway and [the authoring API](./architecture.md#two-tier-authoring-versus-runtime).

So the capability "an agent reads from a store" already works through `delta.action`. What a `DataSource` would add is a first-class, declarative authoring type with built-in CRUD semantics and ownership metadata, rather than a hand-written `fn`.

## Intended shape (from the spec, not yet built)

When implemented, a `DataSource` is expected to carry:

- `name` and `description`.
- `ownership`: internal (the system owns the data) or external (a third party owns it). This is expected to influence default risk and approval posture.
- `contentType`: the shape of the records the source holds.
- `authentication`: how the engine authenticates to the source.
- CRUD actions: `retrieve`, `create`, `update`, `delete`, each governed through the same execution gateway as a normal action.

These are intentions drawn from the specification, not a contract. The field names and semantics may change when the type is actually built.

See [delta-agents.spec.md](../delta-agents.spec.md) for the canonical specification.
