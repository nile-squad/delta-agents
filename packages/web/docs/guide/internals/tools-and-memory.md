# Tools and Memory

## Tools

A tool is a reusable, stateless utility registered at the engine level. Unlike an action, a tool has no prerequisites, no risk, no state impact, and no budget of its own; it provides reasoning context rather than changing system state. Web search, a calculation, or a document lookup are typical tools. An action changes business state; a tool informs the model.

Tools are visible to every agent across all tasks. You define a `Tool` object and declare it — along with any [builtin tools](/guide/basics/builtin-tools) (like `document-extract`) — in the engine's `tools` config, in one place. Any registered tool, builtin or custom, is also invokable directly from your code with `delta.tools.invoke()`.

```ts
const webSearch: Tool = {
  name: "web-search",
  description: "Search the web for current information",
  schema: z.object({ query: z.string() }),
  fn: async ({ data }) => {
    const { query } = data as { query: string };
    const results = await searchEngine.query(query);
    return Ok(results);
  },
  limits: {
    maxCallsPerPhase: 10,
    maxCallsPerTask: 50,
    cooldownMs: 1000,
  },
  budget: { tokens: 1000, money: { value: 500, currency: "USD" } },
};

const delta = await createDeltaEngine({
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
  tools: { custom: [webSearch] },
});
```

A tool's `fn` receives a single `{ data, ctx }` object — `data` is the schema-validated input (typed `unknown`, since `Tool` is not generic over its schema), and `ctx` is the `ToolContext` described below.

### Limits

The engine enforces per-tool limits declared on `limits`: a cooldown between calls, a maximum number of calls per phase, and a maximum number of calls per task. When a limit is hit, the engine blocks the call and returns a message the agent can act on, rather than silently ignoring the request.

### Progressive Disclosure

Tools use progressive disclosure to keep the model's context efficient: the model sees a menu of tool names and descriptions on every turn, and a tool's full schema is fetched on demand only when the model needs it. Actions work the opposite way; their full schemas are always included, because actions are task-specific and the model needs complete schema information to execute business logic correctly.

### Tool Hints

A phase or action may declare advisory tool hints, suggesting which tools are useful for that step. All tools remain visible regardless of hints; a hint is a suggestion, not a restriction.

```ts
const phase = {
  name: "research",
  description: "Gather customer data",
  actions: ["lookup-customer"],
  checkpoint: true,
  tools: ["web-search"],
};
```

### Tool History

Every tool call is logged for audit: agent, phase, timestamp, input, output, and token count. History entries are truncated by default; the full result for a specific call can be retrieved on demand.

### Internal Tools

Tool names starting with `system:` are reserved for framework-provided capabilities; a user-registered tool cannot use that prefix. These are always available to a deployed agent, without being declared in the `tools` config:

| Tool | Purpose |
|------|---------|
| `system:use_tool` | Execute a named tool with the given input. |
| `system:get_tool_schema` | Return a tool's full input schema on demand (progressive disclosure). |
| `system:get_tool_history` | Return the full tool history recorded so far on the task. |
| `system:get_tool_history_entry` | Return a single history entry by index, including the full (untruncated) output. |
| `system:search_commits` | Search past commit records by keyword, workflow, or across agents. |
| `system:commit` | Voluntarily record a checkpoint with notes without ending the task (free reasoning loop only). |

### Attachments

A tool's `ctx` also carries the task's attachments (images, audio, or files supplied at `send` time), so a tool can read one by id — for example, an extraction tool that reads the contents of an attached file. See [Attachments](/guide/basics/attachments) for the full picture, including how images and audio differ from files and the vision/audio capability requirements.

## Memory

Memory is retrieved on demand, not carried forward as a growing transcript. An agent writes a memory during an action and can retrieve one it owns in a later task, instead of the engine threading the full history of every prior task into the model's context on every call.

## Skills

A skill is a named capability description backed by a folder containing a `SKILL.md` file. Skills are scoped at three levels, and only the declared skills are active at each:

- **Agent level** — active throughout the agent's free reasoning.
- **Phase level** — active only while that phase runs.
- **Action level** — overrides the phase-level set for that action's invocation.

```ts
import { type Skill } from "delta-agents";

const refundSkill: Skill = {
  name: "refunds",
  description: "Handles customer refund requests",
  folder: "./skills/refunds/",
};

const agent = delta.agent({
  name: "support-agent",
  skills: [refundSkill],
  // ...
});
```

A phase or action can reference a skill by name (resolved against the agent's declared skills) instead of repeating the full definition.
