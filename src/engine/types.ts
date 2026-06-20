/**
 * Engine assembly types.
 *
 * DeltaEngineConfig carries the adapters and limits that shape engine behaviour
 * at construction time. Defaults keep the engine fully functional with no
 * external dependencies so tests never need to wire up real storage or model APIs.
 *
 * DeltaEngine is the single facade the developer interacts with — authoring methods
 * define capabilities, runtime methods drive execution. The internals stay decoupled;
 * only the facade is unified (spec §Delta DX, context.md §DX Pattern).
 */

import type { Result } from "slang-ts";
import type { Cost, Task, Execution, Checkpoint, ApprovalRequest, EscalationRecord } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort } from "../ports/reasoner-port";
import type { Action, Workflow, Phase, Agent } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";

export type DeltaEngineConfig = {
  /** Persistence adapter. Defaults to an isolated in-memory store. */
  store?: StoragePort;
  /** Reasoning adapter. Defaults to the mock reasoner (Phase 10 adds OpenAI). */
  reasoner?: ReasonerPort;
  /**
   * Maximum reasoner iterations per task.
   * Prevents an unbounded reasoning loop from running forever.
   * Default: 100.
   */
  maxStepsPerTask?: number;
};

export type SendInput = {
  goal: string;
  agentName: string;
  /** Budget ceiling for this task. Defaults to { tokens: 10_000, durationMs: 300_000 }. */
  budget?: Cost;
  /**
   * Name of a workflow the agent declares. When set, the task runs
   * deterministically through the workflow engine (phases in declared order)
   * instead of the free reasoner loop (the C-a coexistence model: a task with an
   * assigned workflow is reasoner-less; workflow-less tasks use the reasoner).
   * The agent must declare the workflow or the send fails.
   */
  workflow?: string;
  /**
   * Shared input bag handed to every action in the workflow run. Each action's
   * schema validates the subset it needs (the gateway rejects anything invalid).
   * Per-action reasoner-filled inputs are a future refinement; for now a single
   * bag covers the deterministic-workflow case. Ignored for the reasoner loop.
   */
  input?: Record<string, string | number | boolean | null>;
};

export type SendResult = {
  taskId: string;
  /**
   * completed — all actions ran. blocked — waiting on a human decision.
   * failed — non-recoverable. queued — agent was busy, so the inbound goal was
   * attached as a message to its existing task and no new task was created
   * (spec §No New Task When Work Is Pending; taskId is the existing task's id).
   */
  status: "completed" | "failed" | "blocked" | "queued";
  snapshot: TaskStateSnapshot;
  /** Populated when status is "blocked", "failed", or "queued". */
  reason?: string;
};

export type InspectResult = {
  /** Current task record — status, budget, risk, trust. */
  task: Task;
  /** All execution records for the task in creation order. */
  executions: Execution[];
  /** Latest recoverable state boundary, or null if no checkpoint exists yet. */
  latestCheckpoint: Checkpoint | null;
  /** All escalation events raised during the task's lifetime (invariant 13). */
  escalations: EscalationRecord[];
  /** Approvals waiting for a human decision. */
  pendingApprovals: ApprovalRequest[];
};

export type DeltaEngine = {
  // ── Authoring methods (define capabilities) ────────────────────────────────
  /** Define an executable operation. Validated and registered immediately. */
  action: <TInput extends Record<string, unknown>>(def: Action<TInput>) => Action<TInput>;
  /** Define an ordered procedure composed of phases. */
  workflow: (def: Workflow) => Workflow;
  /** Define a phase within a workflow. */
  phase: (def: Phase) => Phase;
  /** Define a role with its allowed actions and workflows. */
  agent: (def: Agent) => Agent;

  // ── Runtime methods (drive execution) ─────────────────────────────────────
  /** Mark a defined agent as active. The agent must already be registered via delta.agent(). */
  deploy: (agent: Agent) => void;
  /**
   * Hand a goal to a named agent and drive execution to completion (or until blocked).
   * Creates a new TaskID, runs the reasoner loop, and returns the terminal result.
   * If the agent is already busy, no new task is created: the goal is queued as a
   * message on its existing task and the result status is "queued" (invariant 26).
   * Returns Err only when the agent is unknown or persistence fails.
   */
  send: (input: SendInput) => Promise<Result<SendResult, string>>;
  /**
   * Approve a pending human approval request.
   * After approving, call resume(taskId) to continue a blocked task.
   */
  approve: (approvalId: string) => Promise<Result<ApprovalRequest, string>>;
  /** Suspend a task and save its current state as a checkpoint. */
  pause: (taskId: string) => Promise<Result<void, string>>;
  /**
   * Resume a paused or blocked task from its latest checkpoint.
   * Runs the reasoner loop from the saved state.
   */
  resume: (taskId: string) => Promise<Result<SendResult, string>>;
  /**
   * Read the full governance state for a task: task record, executions,
   * latest checkpoint, escalations, and pending approvals.
   * All entries are TaskID-attributable (invariants 1, 8, 9, 13).
   */
  inspect: (taskId: string) => Promise<Result<InspectResult, string>>;
  /**
   * Return the most recent task for a named agent.
   * An agent always has a retrieval path to its latest task without requiring
   * the caller to store the TaskID (invariant 25).
   */
  lastTask: (agentName: string) => Promise<Result<Task | null, string>>;
};
