# delta-agents example

A working example for the published [delta-agents](https://github.com/nile-squad/delta-agents) npm package. Shows two patterns: a free-loop agent with human oversight, and a deterministic workflow.

## What it demonstrates

- **Governed actions** — schema-validated, risk-scored, audit-logged
- **Human oversight via events** — the `approval-requested` event drives the review loop; no polling with `inspect`
- **Free-loop execution** — the model decides which action to take and when
- **Deterministic workflow** — a multi-phase SOP that runs the same way every time, model-agnostic

## Prerequisites

- Node 18+ or Bun
- `OPENAI_API_KEY` set in the environment

## Project structure

```
src/
  index.ts        # Entry: creates the engine, runs two patterns
  agents/
    support-agent.ts  # delta-agents wiring: actions, agent, workflow definitions
  services/
    orders-service.ts # Plain in-memory "orders backend" — ordinary domain logic
```

## Install

```bash
pnpm install
```

## Run

```bash
# Node
OPENAI_API_KEY=sk-... pnpm build && pnpm start

# Bun (no build step)
OPENAI_API_KEY=sk-... pnpm dev
```

## Wiring a real model

The example expects `OPENAI_API_KEY` in the environment. It uses `gpt-4o-mini` by default; swap the `model` field or the `models` array for a different OpenAI-compatible provider.

## Persistent storage

This example uses the engine's default in-memory store. For a persistent run, swap it for a Drizzle-backed store:

```ts
import { createDrizzleStore } from "delta-agents";

const store = await createDrizzleStore("file:./example.db");
const delta = await createDeltaEngine({ store, apiKey, models, systemPrompt });
```
