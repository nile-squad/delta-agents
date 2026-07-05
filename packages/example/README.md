# delta-agents example

A reference implementation for [delta-agents](https://github.com/nile-squad/delta-agents) — the AI agents framework with built in safety, governance and provenance.

The model proposes actions; the engine validates, authorizes, supervises, and audits before anything executes. This example shows what that looks like in practice.

## Scenario

An order support agent that can look up orders and issue refunds. The refund action moves money, so it's declared `requiresApproval: true` — the model can propose it, but the engine won't run it until a human signs off.

The example runs end to end with no API key and no database by default. Swap to a real model in one line.

## What it demonstrates

- **Governed actions** — schema-validated, risk-scored, audit-logged
- **Free-loop execution** — the model decides which action to take and when
- **Deterministic workflow** — a multi-phase SOP that runs the same way every time, model-agnostic
- **Human oversight** — a high-risk action blocks until approved, then resumes exactly where it left off

## Project structure

```
src/
  index.ts                     # Entry: creates the engine, runs two patterns (free-loop + workflow)
  agents/
    support-agent.ts           # delta-agents wiring: actions, agent, workflow definitions
  services/
    orders-service.ts          # Plain in-memory "orders backend" — ordinary domain logic, no delta
```

## Running

```bash
pnpm install
pnpm dev          # Bun — fast, no build step
```

Or with Node:

```bash
pnpm build
pnpm start
```

## Wiring a real model

By default the example uses a mock reasoner so it runs deterministically with zero setup. To use a real model, swap the `reasoner` option for `models`:

```ts
const delta = await createDeltaEngine({
  models: [{ name: "default", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY, default: true }],
  systemPrompt: "You are Acme Corp's order support agent. Always be helpful and concise.",
});
```

Everything else — actions, agent, send/approve/resume/inspect — stays the same. Governance never changes with the reasoning backend. That's the whole point.

## Persistent storage

This example uses the engine's default in-memory store (state resets each run). For a real, persistent run, swap it for `createDrizzleStore`:

```ts
import { createDrizzleStore } from "delta-agents";

const store = await createDrizzleStore("file:./example.db");
const delta = await createDeltaEngine({ store, models, systemPrompt });
```
