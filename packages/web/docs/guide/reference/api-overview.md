---
title: API Overview
description: The full delta.* method surface, authoring and runtime
---

# API Overview

`createDeltaEngine(config)` returns one object. Its methods split into two groups: authoring methods define capabilities and return the definition; runtime methods drive execution and own all runtime state.

## Authoring Methods

| Method | Purpose |
|--------|---------|
| `delta.action(def)` | Define a named, schema-validated operation. Returns the definition. |
| `delta.workflow(def)` | Define an ordered procedure composed of phases. Returns the definition. |
| `delta.dataSource(def)` | Define a named, owned store of governed CRUD operations. Returns the definition. |
| `delta.tool(def)` | Define a reusable, stateless utility available to every agent. Returns the definition. |
| `delta.agent(def)` | Define a role with its allowed actions, workflows, data sources, skills, and channels. Returns the definition. |

There is no `delta.phase()`. A phase is a plain object passed directly inside `delta.workflow({ phases: [...] })`.

## Runtime Methods

| Method | Purpose |
|--------|---------|
| `delta.deploy(agent)` | Activate a defined agent. Required before `send`. |
| `delta.send(input)` | Hand a goal to a named agent and run it to completion or until blocked. Returns `SendResult`. |
| `delta.approve(approvalId)` | Approve a pending human approval request. Call `resume` after approving. |
| `delta.reject(approvalId)` | Reject a pending human approval request. The action stays permanently blocked — the engine never re-opens a rejected approval. |
| `delta.pause(taskId)` | Suspend a running task and write a checkpoint. |
| `delta.resume(taskId)` | Resume a paused or blocked task from its latest checkpoint. |
| `delta.inspect(taskId)` | Read the full governance state: task, executions, checkpoint, escalations, approvals. |
| `delta.lastTask(agentName)` | Return the most recent task for a named agent, without the caller needing to store a `TaskID`. |
| `delta.cleanup(options?)` | Manually prune old completed tasks and consumed messages, and evict expired cache entries. Destructive parts are opt-in. |

## SendResult

`send` and `resume` return `Ok(SendResult)`. `SendResult.status` is one of:

| Status | Meaning |
|--------|---------|
| `completed` | All actions finished. |
| `blocked` | Waiting on a human decision (approval or escalation). |
| `failed` | Non-recoverable failure. |
| `queued` | The agent was already busy; the goal was attached to its existing task. No new task was created. |
| `pendingCommit` | The agent has uncommitted workflow work; call `delta.resume(taskId)` to let it commit. |

See [Getting Started](/guide/start/getting-started) for a full walkthrough, and [Types](/guide/reference/types) for the shape of every definition and runtime type.
