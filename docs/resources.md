# DataSources

A `DataSource` is a named, owned store of governed CRUD operations. It groups up to four operations (`retrieve`, `create`, `update`, `delete`) over one data store, with ownership and content-type metadata. Each operation is a full action, so a data read or write is governed exactly like any other action: schema validation, legality, approval, budget, risk, trust, and a TaskID-attributable audit record.

See [ADR-007](./ADR-007-datasource-design.md) for the design decisions (the spec left parts of the `DataSource` contract undefined) and [architecture.md](./architecture.md) for the execution gateway every operation flows through.

## Defining a DataSource

Pass the operations directly to `delta.dataSource` (it is the sole registrar of its operations, so do not create them with `delta.action` first):

```ts
const userDb = delta.dataSource({
  name: "user-db",
  description: "the application user store",
  ownership: "internal",
  contentType: "application/json",
  actions: {
    retrieve: {
      name: "user-db.retrieve",
      description: "read a user record by id",
      schema: z.object({ id: z.string() }),
      risk: 2,
      fn: async ({ id }) => Ok(await db.users.find(id)),
    },
  },
});

const agent = delta.agent({
  name: "support-agent",
  description: "answers user questions",
  role: "Support",
  rolePrompt: "Help the user.",
  actions: [],
  dataSources: [userDb],
});
```

When the agent is defined, the engine flattens every attached data source's operations into the agent's reachable action set. From that point the operations are discovered and governed exactly like any other action, so they can be used in the free reasoner loop or referenced by name in a workflow phase.

## Fields

| Field | Meaning |
|-------|---------|
| `name` | Unique data source name. |
| `description` | What the store holds and why the agent uses it. |
| `ownership` | `"internal"` (the system owns the store) or `"external"` (a third party owns it). External data is less trusted by default: each operation's risk prior is floored at moderate (3 of 5), so it starts with a lower execution-health expectation and earns trust through a successful track record (the floor is a prior, overridden by evidence, not a permanent penalty). A higher declared `risk` is preserved. Also recorded as audit metadata so an operator can see whether the agent touched data outside its trust boundary. |
| `contentType` | Free-form descriptor of the records the source holds (for example `"application/json"`). |
| `authentication` | Optional. `{ type: string }` describing the mechanism only (for example `"oauth2"`). Never a credential: the operation `fn` owns its own secrets through its closure, and the engine never stores or transmits secrets. |
| `actions` | The defined operations: `retrieve`, `create`, `update`, `delete`. At least one is required. Each is a full action. |

## Why operations are full actions

The execution gateway is schema-first: every operation must carry a schema (invariant 4), and governance is defined on actions. A bare function cannot be governed. Promoting each CRUD operation to an action means a data read or write passes through the same single chokepoint as everything else, with no DataSource-specific execution path to audit separately. See [ADR-007](./ADR-007-datasource-design.md).

## Limits and conventions

- Operation names are not auto-namespaced. Two data sources that each define an operation literally named `retrieve` would collide in the registry. Namespace by convention (`user-db.retrieve`, `orders.retrieve`).
- A DataSource is authoring-time state held in the registry; nothing about it is written to the storage port.

See [delta-agents.spec.md](../internal/delta-agents.spec.md) for the canonical specification.
