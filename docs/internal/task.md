# Task: System Prompt + Time Awareness

## Goal
1. `createDeltaEngine({ systemPrompt?: string, timezone?: string })` — global org instructions passed to all agents. Static content only, baked into the system message prefix so it hits the model's prompt cache.
2. Time awareness injected into the user message (not system) — current message gets current timestamp + timezone + humanized time, older messages get relative time ("4 hours ago") so the model perceives time gaps across the conversation.

## Design Decisions
- **System prompt**: engine-level only, passed to all agents. Static, cacheable prefix in system message.
- **Time injection**: in the user message (varying content), NOT the system message (cacheable prefix).
- **Prior messages**: ALL messages (caller + teammate + agent comms) loaded from store, formatted as a transcript with relative time.
- **Current time format**: humanized + ISO + timezone: `"Current time: 2:30 PM WAT (2026-07-01T13:30:00Z)"`
- **Relative time**: `formatDistanceToNow` from date-fns → "4 hours ago", "2 days ago", "just now"
- **Timezone**: engine config, default to system timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`

## Plumbing

```
DeltaEngineConfig { systemPrompt?, timezone? }
  → createOpenAIReasoner({ ..., systemPrompt })  [baked into system message prefix]
  → scheduler.ts stepTask: build currentTimestamp + load priorMessages from store
    → reasonInput { ..., currentTimestamp, priorMessages }
      → buildMessages: system message gets systemPrompt prefix; user message gets time + transcript
```

## Files to Modify

### 1. `src/engine/types.ts` — DeltaEngineConfig
Add two fields after `reasonerRetry?`:
- `systemPrompt?: string` — JSDoc: "Global org instructions passed to all agents. Static content baked into the system message prefix for prompt cache hits. Must not contain time or varying content."
- `timezone?: string` — JSDoc: "Timezone for humanized time in reasoner messages (e.g. 'Africa/Lagos'). Defaults to the system timezone. Grounds agents with time awareness."

### 2. `src/ports/reasoner-port.ts` — ReasonerInput
Add two fields after `context?: string`:
- `currentTimestamp?: { iso: string; humanized: string; timezone: string }` — JSDoc: "Current time injected into the user message for time awareness. Built by the engine before each reason() call."
- `priorMessages?: Array<{ sender: string; content: string; relativeTime: string }>` — JSDoc: "Prior conversation transcript with relative time labels, loaded from the message store. Gives the model time-gap awareness across the conversation."

### 3. `src/ports/openai-reasoner.ts`
- **`OpenAIReasonerConfig`** (line ~35): add `systemPrompt?: string`
- **`buildMessages`** (line 244):
  - Destructure `systemPrompt, currentTimestamp, priorMessages` from input
  - **System message** (line 250): prepend `systemPrompt` if defined, BEFORE the `You are ${agentRole}` line. Add a blank line separator. This keeps the cacheable prefix: `[systemPrompt]\n\nYou are ${agentRole}...`
  - **User message** (line 271): 
    - If `currentTimestamp` defined, prepend as first line: `Current time: ${humanized} (${iso})`
    - If `priorMessages` defined and non-empty, add a block AFTER the current time line, BEFORE the task goal: 
      ```
      
      Prior conversation:
      [${relativeTime}] ${sender}: ${content}
      ...
      ```
    - Then the existing `Task goal:` line and rest

### 4. `src/engine/create-delta-engine.ts`
- Destructure `systemPrompt` and `timezone` from config (near line 91 area)
- In `resolveReasoner` (line 117-124): pass `systemPrompt` to `createOpenAIReasoner({ ..., systemPrompt })`
- Store `timezone` in a closure variable for the scheduler to use (or pass to stepTask)

### 5. `src/engine/scheduler.ts`
- In `stepTask` (around line 206), before building `reasonInput`:
  - Build `currentTimestamp`: 
    ```ts
    const now = new Date();
    const tz = configTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const currentTimestamp = {
      iso: now.toISOString(),
      humanized: formatInTimeZone(now, tz, "h:mm a zzz"),
      timezone: tz,
    };
    ```
  - Load prior messages: `const msgsResult = await store.getMessages(task.id);` — if Ok, map each to `{ sender, content: stringify(payload), relativeTime: formatDistanceToNow(createdAt) }`. Sort by createdAt ascending. Handle payload being Json (stringify if object).
  - Add both to `reasonInput`:
    ```ts
    const reasonInput = {
      ...,
      currentTimestamp,
      ...(priorMessages.length > 0 ? { priorMessages } : {}),
    };
    ```
- Import `formatInTimeZone` from `date-fns-tz` and `formatDistanceToNow` from `date-fns`

### 6. Tests — `tests/integration/time-awareness.spec.ts`
- **Test 1**: systemPrompt appears in system message. Use a custom mock reasoner that captures the input, verify `systemPrompt` is threaded. OR: test buildMessages directly if exported. Check if buildMessages is exported — if not, test via a captured reasoner.
- **Test 2**: currentTimestamp is built and passed. Verify it has iso, humanized, timezone.
- **Test 3**: priorMessages loaded from store with relative time. Create messages with old timestamps, run a task, verify the reasoner received priorMessages with relativeTime strings.
- **Test 4**: systemPrompt is NOT in the user message (cache safety). Verify separation.

Use `createMockReasoner` with a custom response that captures the input. Follow existing test patterns.

## Verification
- `pnpm test` — all tests pass
- `tsc --noEmit` — no type errors

## Important Notes
- Use `safeTry` over try/catch for the store.getMessages call
- No `any`, no `unknown`
- `type` over `interface`, no `enum`
- Match existing code style
- JSDoc explains WHY
- date-fns and date-fns-tz are already installed deps
- payload is `Json` type — use `typeof payload === "string" ? payload : JSON.stringify(payload)` to extract content
- Do NOT add time/varying content to the system message — it breaks prompt caching
- Mock reasoner ignores extra fields, so no mock changes needed for ReasonerInput additions