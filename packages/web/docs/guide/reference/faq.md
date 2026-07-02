# FAQ

Common questions about delta-agents, with answers that reflect the current implementation.

## How do actions report success and failure?

Every action's `fn` returns a `Result`: `Ok(value)` for success, `Err(message)` for failure. There is no throwing to signal a business failure. A thrown error inside `fn` is caught by the engine and treated as `Err`, so a crash inside an action never crashes the task.

```ts
fn: async ({ customerId }) => {
  const record = await db.customer.find(customerId);
  if (record === null) return Err(`no customer found with id "${customerId}"`);
  return Ok(record);
},
```

## Does the model call actions directly?

No. The model can only propose an action by name and input. The engine's execution gateway validates the input against the action's schema, checks whether the action is currently legal and approved, and only then runs `fn`. See [Execution Gateway](/guide/internals/execution-gateway).

## What happens if the model proposes an action that is not currently allowed?

It is rejected before `fn` runs. An action is only reachable when it is part of the agent's declared actions or workflows, and when its declared prerequisites (other actions or workflows) have completed.

## What happens when a budget is exceeded?

`send` accepts a multi-axis `budget` (tokens, duration, and optionally memory, latency, money). The engine tracks spend against every axis the budget declares. Exceeding a budgeted axis raises an escalation and pauses the task for human review rather than continuing silently. See [Human Oversight and Approvals](/guide/basics/human-oversight-and-approvals).

## How do I configure a real model provider?

Pass `models` to `createDeltaEngine`. Each entry is a `ModelDef` with a `name`, the underlying `model` id, and optional `endpoint`/`apiKey` overrides. Agents reference a model by name; omitting `model` on an agent uses the engine's default.

```ts
const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [
    { name: "fast", model: "gpt-4o-mini", default: true },
    {
      name: "local",
      model: "llama3.2",
      endpoint: "http://localhost:11434/v1",
      apiKey: "ollama",
    },
  ],
});
```

This works with OpenAI, OpenRouter, or any OpenAI-compatible endpoint (including a local one) by setting `endpoint` and `apiKey` per model.

## How do I test agents without calling a real model?

Pass a `reasoner` override built with `createMockReasoner`, scripted with the exact action requests you want it to produce:

```ts
import { createMockReasoner } from "delta-agents";

const delta = await createDeltaEngine({
  reasoner: createMockReasoner({
    responses: [{ actionName: "greet", input: { name: "world" } }],
  }),
});
```

Everything else, actions, agents, workflows, approvals, stays identical whether the reasoner is mocked or backed by a real model.

## What happens if a model call fails?

Each reasoner call is retried with jittered backoff. If it still fails after the configured retries, the task escalates to a human instead of failing outright, so a transient network error or rate limit is recoverable through `resume` rather than fatal.

## Can a task survive a process restart?

Yes, if a persistent storage adapter is configured. `createDrizzleStore` backs the engine with libsql; `pause` and `resume` read and write checkpoints through the same storage port, so a new process can resume a task from its last checkpoint. `createInMemoryStore`, the default, does not survive a restart.

## How is this different from giving a model a large toolset directly?

A model with unrestricted tool access can call a tool in a state where it makes no sense, spiral into unbounded cost through retries or runaway delegation, or run an irreversible action with no approval gate or audit trail. delta-agents keeps every one of those decisions in the engine: the model proposes, the engine authorizes, and governance does not change with model capability. See the [root README](https://github.com/hussein-kizz/delta-agents#readme) for the full problem statement.

## Is delta-agents production ready?

The project is pre-1.0. The core engine, governance logic, supervision strategies, workflow execution, delegation, and human oversight are implemented and tested; the public API shape is considered final, and breaking changes before 1.0 will be documented.
