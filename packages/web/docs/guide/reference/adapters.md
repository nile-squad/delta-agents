---
title: Adapters
description: Storage, model, and channel adapters
---

# Adapters

## Storage

```ts
import { createInMemoryStore, createDrizzleStore } from "delta-agents";

// In-memory (default): fast, isolated, lost on restart.
const store = createInMemoryStore();

// Drizzle + libsql: persistent.
const store = await createDrizzleStore("file:./delta.db");
// Or in-memory libsql:
const store = await createDrizzleStore();
```

`pause`/`resume` read and write checkpoints through the storage port, so a persistent adapter lets a task survive a process restart. The default in-memory store does not.

## Models

Models are defined on the engine and referenced by agents by name. At least one must carry `default: true`.

```ts
const delta = await createDeltaEngine({
  // Engine-level defaults. Per-model values override these.
  endpoint: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  options: { temperature: 0.1 },

  models: [
    { name: "fast", model: "gpt-4o-mini", default: true },
    { name: "smart", model: "gpt-4o", vision: true, options: { temperature: 0.3, topP: 0.9 } },
    { name: "multimodal", model: "gpt-4o-audio-preview", vision: true, audio: true },
    { name: "local", model: "llama3.2", endpoint: "http://localhost:11434/v1", apiKey: "ollama" },
    {
      name: "reasoning",
      model: "o3-mini",
      endpoint: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      // no options — o-series reasoning models reject sampling params
    },
  ],
});
```

Any OpenAI-compatible endpoint works by setting `endpoint`/`apiKey` per model — OpenAI, OpenRouter, or a local server. `vision: true` / `audio: true` declare that a model accepts image / audio content; see [Attachments](/guide/basics/attachments).

An agent references a model by name; omitting `model` uses the engine default. `delta.agent()` validates the model name immediately — an unknown name throws before any task runs.

```ts
const researcher = delta.agent({ name: "researcher", model: "smart", /* ... */ });
const worker = delta.agent({ name: "worker", /* model omitted — uses default */ /* ... */ });
```

### Testing Without a Real Model

```ts
import { createMockReasoner } from "delta-agents";

const delta = await createDeltaEngine({
  reasoner: createMockReasoner({
    responses: [{ actionName: "greet", input: { name: "world" } }],
  }),
});
```

### Reasoner Resilience

A model call can fail: a network error, an exhausted rate limit, malformed JSON, or a turn that doesn't call a tool. Each reasoner step retries with jittered exponential backoff; when retries are exhausted the task escalates to a human (a `reasoner-failure` escalation, paused and resumable) rather than failing outright.

```ts
const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [{ name: "default", model: "gpt-4o-mini", default: true }],
  // Defaults: 3 attempts, 200ms base, 5s cap, 0.3 jitter. Partial overrides merge.
  providerRetry: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10_000 },
});
```

## Channels

delta-agents is transport-agnostic. Wire any [Chat SDK](https://www.npmjs.com/package/chat) thread into a governed channel:

```ts
import { createChatSdkChannel } from "delta-agents";

// thread is any object with a .post(text: string) method.
const channel = createChatSdkChannel({ thread, type: "slack" });

const agent = delta.agent({
  name: "...",
  // ...
  channels: [channel],
});
```
