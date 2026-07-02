# delta-agents-example

A reference implementation showing how to build with [delta-agents](https://github.com/hussein-kizz/delta-agents), a deterministic governance/control-plane engine for AI agents.

## Scenario

An order support agent that can:

- **`lookup-order`** — read-only, low risk. Looks up a mock order by id.
- **`issue-refund`** — moves money, `requiresApproval: true`. The agent can *propose* a refund, but delta-agents' execution gateway refuses to run it until a human calls `delta.approve(...)`.

`src/index.ts` sends a goal ("look up the order and refund the customer"), lets the run block on the refund's approval gate, approves it, resumes the task, and prints the full governance audit trail (task status, trust score, risk, and every execution) via `delta.inspect(...)`.

The example runs end to end with **no API key and no database** — it uses `createMockReasoner` (scripted to request the same actions a real model would) and the engine's default in-memory store.

## Project structure

```
src/
  index.ts                     # Entry point: creates the engine, deploys the agent,
                                # sends the goal, approves the refund, resumes, inspects.
  agents/
    support-agent.ts           # delta-agents wiring: the lookup-order and issue-refund
                                # actions, and the support-agent definition.
  services/
    orders-service.ts          # Plain in-memory "orders backend" the actions call into —
                                # ordinary domain logic, no delta-agents in here.
```

## Running

With Bun (fast path, no build step):

```bash
pnpm install
pnpm dev
```

With plain Node:

```bash
pnpm install
pnpm build
pnpm start
```

## Wiring a real model

By default the example uses `createMockReasoner` so it runs deterministically with zero setup. To use a real model instead, swap the `reasoner` option in `src/index.ts` for `models`:

```ts
const delta = await createDeltaEngine({
  models: [{ name: "default", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY, default: true }],
});
```

Everything else — the actions, the agent, and the `send` / `approve` / `resume` / `inspect` calls — stays exactly the same either way. Governance never changes with the reasoning backend.

## Persistent storage

This example uses the engine's default in-memory store (state resets each run). For a real, persistent run, swap it for `createDrizzleStore`:

```ts
import { createDrizzleStore } from "delta-agents";

const store = await createDrizzleStore("file:./example.db"); // libsql-backed, on disk
const delta = await createDeltaEngine({ store, reasoner });
```
