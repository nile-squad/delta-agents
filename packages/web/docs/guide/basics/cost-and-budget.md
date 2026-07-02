# Cost and Budget

Cost is a multi-axis vector, not a single number. The engine tracks and enforces every axis a budget declares.

```ts
type Money = {
  value: number;     // amount in the currency's minor unit (e.g. cents for USD), integer
  currency: string;  // ISO 4217 code, e.g. "USD", "EUR", "NGN"
};

type ContentCost = {
  count: number;
  bytes: number;
  unitType?: "tokens" | "pages" | "images" | "bytes";
  itemSize?: number;
};

type Cost = {
  tokens: number;      // model token usage
  durationMs: number;  // wall-clock execution time
  memory?: number;     // memory footprint, developer-chosen unit
  latency?: number;    // added delay beyond execution time, e.g. a network round-trip
  money?: Money;        // financial cost, as an explicit amount + currency
  content?: ContentCost; // attachment/content resource consumption
};
```

## A Budget Enforces Only What It Declares

`tokens` and `durationMs` are always enforced. `memory`, `latency`, and `money` are enforced only when the budget declares a limit for that axis — an undeclared axis is unlimited, not zero.

```ts
await delta.send({
  goal: "...",
  agentName: "support-agent",
  budget: { tokens: 5000, durationMs: 30_000, memory: 64 },
});
```

## Money Is an Amount and a Currency

`money` is never a bare number — it always carries its currency alongside the amount, so governance math never silently mixes regions:

```ts
budget: { tokens: 5000, durationMs: 30_000, money: { value: 500, currency: "USD" } }
```

Cost axes are trusted to use consistent units within a task, the same way `memory`/`latency` already are: the engine does not cross-validate that every `money` value on a task shares one currency. Keep a task's cost consistent the same way you would keep its `memory` unit consistent.

## Declared Cost Is a Prior, Never a Ceiling

An action's `estimatedCost` seeds the engine's Kalman estimator with a starting expectation. It shapes what the engine predicts; it never caps what the action is actually allowed to cost. See [Execution Gateway](/guide/internals/execution-gateway) for how a budget is projected against a workflow before it runs.

## Content Cost

`content` tracks attachment/content resource consumption — `count` and `bytes` are populated automatically when a goal carries [attachments](/guide/basics/attachments). `unitType` and `itemSize` are left for a tool to fill in with a richer per-type measure (pages parsed, tokens produced by a vision call, and so on) once such a tool exists. No budget enforces a content limit yet; the axis exists so a future tool can report cost without another shape change.
