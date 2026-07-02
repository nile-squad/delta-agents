---
title: Types
description: Authoring and runtime type overview
---

# Types

## Authoring Types

You define these. `delta.*()` factories validate and return them.

| Type | Purpose |
|------|---------|
| `Action` | A single executable operation with a validation schema, optional anticipated risk and cost, optional prerequisites, and lifecycle hooks. See [Actions](/guide/basics/actions). |
| `Workflow` | An ordered set of phases describing a procedure. Optional `storyline` narrates the ideal user flow. See [Agents and Workflows](/guide/basics/agents-and-workflows). |
| `Phase` | A stage of a workflow with its actions, checkpoint flag, and supervision policy. Optional `storyline` narrates this phase's beat within the workflow arc. |
| `DataSource` | A named, owned store of governed CRUD operations. External sources start from a more cautious risk prior. |
| `Agent` | A role with its actions, workflows, data sources, skills, and channels. |
| `Tool` | A reusable, stateless utility visible to every agent. No prerequisites, no risk, no state impact. See [Tools and Memory](/guide/internals/tools-and-memory). |
| `Channel` | An inbound or outbound communication surface, e.g. a Chat SDK-backed Slack or WhatsApp thread. |
| `Skill` | A named capability description backed by a folder containing `SKILL.md`. Scoped at agent, phase, or action level. |
| `ModelDef` | A named model with its provider config, endpoint, API key, options, and vision/audio capability flags. See [Adapters](/guide/reference/adapters). |
| `ModelOptions` | Provider options forwarded to the model API: `temperature`, `topP`, `maxTokens`. |

## Runtime Types

The engine owns these. You read them via `delta.inspect(taskId)` — you never construct one directly.

| Type | Purpose |
|------|---------|
| `Task` | The unit of governance. Owns goal, budget, risk, trust, and audit history. |
| `Execution` | A single action run with cost and status. |
| `Checkpoint` | A recoverable state boundary. |
| `Cost` | Multi-axis resource measurement: tokens, duration, memory, latency, money, content. See [Cost and Budget](/guide/basics/cost-and-budget). |
| `SupervisionPolicy` | Strategy and retry limit applied when a phase fails. |
| `Memory` | A retrieved-on-demand piece of agent context. |
| `Commit` | An agent-supplied acknowledgment (with optional notes) that a workflow completed, or a voluntary checkpoint annotation in the free reasoning loop. |
| `Attachment` | An engine-issued (id-bearing) image, audio clip, or file supplied at `send` time. See [Attachments](/guide/basics/attachments). |

## Send Input

```ts
type SendInput = {
  goal: string;
  agentName: string;
  budget?: Cost;
  workflow?: string;
  input?: Record<string, string | number | boolean | null>;
  actionInputs?: Record<string, Record<string, string | number | boolean | null>>;
  attachments?: AttachmentInput[];
};
```

`workflow` runs the goal through a declared workflow deterministically; omitting it runs the free reasoning loop instead. `input`/`actionInputs` feed a deterministic workflow run. `attachments` is covered in full on the [Attachments](/guide/basics/attachments) page.
