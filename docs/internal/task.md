# Agent Commit Feature — Task Spec

## Goal
Agents must call a `commit(notes?)` tool after completing a workflow to mark a checkpoint with optional notes. Notes are loaded into context on future runs. Search tool lets agents pull older commits on demand. Committing is mandatory for workflows (hard-block new tasks until committed), optional for free-loop tasks.

## Design

### New types (`src/shared/types.ts`)
```ts
type Commit = {
  id: string;
  taskId: string;
  agentName: string;
  workflowName: string | null;  // null for free-loop commits
  notes: string | null;
  checkpointId: string | null;
  createdAt: Date;
};

type CommitQuery = {
  query?: string;
  workflowName?: string;
  allAgents?: boolean;
  limit?: number;
};
```

### New status
Add `"pendingCommit"` to `ExecutionStatus` union.

### New ID generator (`src/shared/id.ts`)
`commitId = (): string => generateId("cmt_")`

### New StoragePort methods (`src/ports/storage-port.ts`)
```ts
saveCommit: (commit: Commit) => Promise<Result<Commit, string>>;
getCommitsByAgent: (agentName: string, limit?: number) => Promise<Result<Commit[], string>>;
searchCommits: (query: CommitQuery, currentAgent: string) => Promise<Result<Commit[], string>>;
```

### Drizzle schema (`db/models/schema.ts` + `db/models/migrate.ts`)
```sql
CREATE TABLE IF NOT EXISTS commits (
  id            TEXT    PRIMARY KEY,
  task_id       TEXT    NOT NULL,
  agent_name    TEXT    NOT NULL,
  workflow_name TEXT,
  notes         TEXT,
  checkpoint_id TEXT,
  created_at    INTEGER NOT NULL
);
```

### Config (`src/engine/types.ts`)
```ts
commitContextLimit?: number;   // default 10
commitMaxRetries?: number;      // default 3
```

## Progress

### ✅ Phase 1 — Types & Storage
All commit types, StoragePort methods, in-memory + drizzle + cached-store implementations, drizzle schema/DDL, barrel exports. Typecheck clean.

### ✅ Phase 2 — Commit Step
`runCommitStep()` — constrained reasoner turn after workflow completes. Builds commit prompt, calls reasoner once (no tools, `commitMode` flag), extracts notes from `kind: "done"` reason. Auto-commits on exhaustion. Retries via `retryWithJitter`.

### ✅ Phase 3 — Hard Block + Resume
`send()` hard-blocks new tasks if agent has `pendingCommit` status. `resumeTask` accepts `pendingCommit` and re-runs the commit step. `commitMode` flag in OpenAI reasoner bypasses tool assembly, only offers `finish_task`.

### ✅ Phase 4 — Context Injection
Recent N commits fetched in `stepTask` (after memory retrieval, before mentions), formatted as bullet list, injected as `commitContext` on `ReasonerInput`. Rendered as `"Recent commits:"` section in the user message. `commitContextLimit` threaded from `DeltaEngineConfig` → `createDeltaEngine` → `send()`/`resume()` → `runSendLoop` → `runScheduler` → `stepTask`.

### ✅ Phase 5 — Search Tool
`system:search_commits` internal tool added. Tool definition + builder in `openai-reasoner.ts`. New `kind: "search-commits"` variant on `ReasonerDecision`. Scheduler handler calls `store.searchCommits()` and returns result in `lastToolInfoResult` (same pattern as `tool-info`). Always offered (no dependency on tool history).

### ✅ Phase 6 — Free-loop Optional Commit
`system:commit` tool added for free-loop tasks. Tool definition + builder in `openai-reasoner.ts`. New `kind: "commit"` variant on `ReasonerDecision`. Scheduler handler creates a `Commit` record (with `workflowName: null` for free-loop), links to latest checkpoint, saves via `store.saveCommit()`. Task continues running after commit — does NOT change task status. Always offered in non-commit mode.

### ✅ Phase 7 — Tests
Unit tests: `commit-step.spec.ts` (formatCommitContext, runCommitStep — finish_task commit, auto-commit on exhaustion, reasoner-failure fallback, pendingCommit status transition), `in-memory-store.spec.ts` + `drizzle-store.spec.ts` (commit CRUD + searchCommits filters), `cached-store.spec.ts` (commit pass-through), `openai-reasoner.spec.ts` (commitMode tool assembly, commitContext rendering, search_commits/commit tool-call parsing). Integration: `agent-commit.spec.ts` — post-workflow commit, commit context injection + `commitContextLimit`, hard block + resume from `pendingCommit`, free-loop `system:commit`, `system:search_commits`. 911 tests pass, typecheck clean.

## Impact
- New entity, no breaking changes to existing types
- New StoragePort methods (required, not optional — all adapters must implement)
- New task status value (additive)
- New internal tools (system:commit, system:search_commits)
- Engine config gains two optional fields