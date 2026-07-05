/**
 * Interleaving task scheduler — the engine's cooperative multitasking core.
 *
 * A single `delta.send` (or `resume`) may grow into a small supervision tree: a
 * root task that delegates scoped sub-goals to child tasks. The scheduler drives
 * the whole tree to completion within one call, advancing every runnable task by
 * exactly one step per pass (deterministic round-robin). This is the "spawn +
 * poll later" model: a delegation registers a child and returns immediately, and
 * the parent keeps making progress while up to two children run interleaved.
 *
 * Why a step-able loop instead of run-to-completion recursion:
 * The reasoner → gateway cycle is naturally a loop. Factoring out a single
 * `stepTask` lets the scheduler own *when* each task advances, which is what
 * makes interleaving — and the binary supervision tree's two-active-slot bound —
 * expressible without threads. Execution stays single-threaded and fully
 * ordered, so the audit trail and checkpoint writes replay deterministically.
 *
 * Boundedness is structural (spec §Decision: Binary Supervision Tree):
 *   - at most two active children per tree (invariant 15, via requestSlot)
 *   - additional delegations queue FIFO and are promoted on slot release
 *     (invariant 16, via releaseSlot)
 *   - a child's budget is clamped to the parent's remaining headroom
 *     (invariant 18, via enforceSubtaskScope)
 *   - aborting the root cascades to every descendant (invariant 17)
 */

import { option } from "slang-ts";
import type { Option } from "slang-ts";
import type { Task, Checkpoint, Cost, TaskTree } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort, DelegationRequest } from "../ports/reasoner-port";
import type { Registry } from "../authoring/registry";
import type { Agent, Action } from "../authoring/types";
import { buildAvailableSkills, resolveSkillRefs } from "../skills";
import type { TaskStateSnapshot } from "../state-space/types";
import type { SendResult } from "./types";
import { snapshotFromTask, snapshotToJson } from "../state-space/task-state";
import { isOverBudget, addCosts, remainingCost } from "../shared/cost";
import { discoverActions } from "../state-space/discover-actions";
import { runGateway } from "../execution/execution-gateway";
import { applyPostStepGovernance, getApprovalStatusForAction, requestApproval, recordAutoApproval, approvalRequired, describeRejection, raiseEscalation } from "../oversight";
import { retryWithJitter, defaultRetryOptions } from "../infra";
import type { RetryOptions } from "../infra";
import { dispatchCommunication, makeContextCommunicate } from "../comms";
import { retrieveContext, makeContextRemember } from "../memory";
import { computeActionValue } from "../governance";
import { computeRosterEntries } from "./roster";
import { enforceSubtaskScope, requestSlot, releaseSlot, abortEntireTree } from "../supervision";
import { initialRiskState, initialTrust } from "../governance";
import { taskId, checkpointId, messageId } from "../shared/id";
import { formatInTimeZone } from "date-fns-tz";
import { formatDistanceToNow } from "date-fns";
import { toJSONSchema } from "zod";
import { createLoopDetector } from "./loop-detector";
import type { LoopDetector } from "./loop-detector";
import type { Logger } from "../shared/logger-types";
import type { Diagnostics } from "../shared/diagnostics";
import { formatCommitContext } from "./commit-step";
import { handleToolExecution, handleToolInfo, handleSearchCommits, handleFreeLoopCommit } from "./tool-dispatch";

// ── Step outcome ────────────────────────────────────────────────────────────

/**
 * The result of advancing one task by a single step. The scheduler decides what
 * to do with each: keep stepping, register a child, or settle the task.
 */
export type StepOutcome =
  // An action ran (fn returned Ok or Err); keep the task running next pass.
  | { kind: "stepped"; snapshot: TaskStateSnapshot }
  // The reasoner asked to delegate a scoped sub-goal.
  | { kind: "delegate"; snapshot: TaskStateSnapshot; delegation: DelegationRequest }
  // The reasoner signalled done, or no actions remain discoverable.
  | { kind: "natural-done"; snapshot: TaskStateSnapshot }
  // Waiting on a human (approval or escalation) — settle as blocked/paused.
  | { kind: "blocked"; snapshot: TaskStateSnapshot; reason: string }
  // Non-recoverable — settle as failed.
  | { kind: "failed"; snapshot: TaskStateSnapshot; reason: string };

// Tool output truncation (TOOL_OUTPUT_LIMIT, truncateToolOutput) moved to
// ./tool-dispatch, alongside the tool-execution branch that uses it. Neither
// was previously exported from this module.

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * A single task's live execution state inside the scheduler. One runner per
 * active task in the tree (root + up to two children).
 */
type Runner = {
  task: Task;
  agent: Agent;
  snapshot: TaskStateSnapshot;
  step: number;
  maxSteps: number;
  settled: boolean;
  result: SendResult | null;
  /** Ids of caller messages already drained into this task's goal (idempotency). */
  consumed: Set<string>;
  /** Phase observed at the end of the last step — used to detect phase changes and reset per-phase counters. */
  previousPhase?: string;
};

/** Build a runner for a task, seeding the drain-idempotency set from the snapshot. */
export const makeRunner = ({
  task,
  agent,
  snapshot,
  maxSteps,
}: {
  task: Task;
  agent: Agent;
  snapshot: TaskStateSnapshot;
  maxSteps: number;
}): Runner => ({
  task,
  agent,
  snapshot,
  step: 0,
  maxSteps,
  settled: false,
  result: null,
  consumed: new Set(snapshot.consumedMessages ?? []),
  previousPhase: snapshot.currentPhase,
});

// ── Single step ──────────────────────────────────────────────────────────────

/** Return a snapshot with lastDecisionError actually dropped (no dangling key). */
const stripDecisionError = (s: TaskStateSnapshot): TaskStateSnapshot => {
  const { lastDecisionError: _cleared, ...rest } = s;
  return rest;
};

/**
 * Advance one task by exactly one reasoner → gateway step. Pure of scheduling
 * concerns: it never touches the task tree, never promotes a sibling, and never
 * writes a terminal task status. It returns an outcome and lets the scheduler
 * own all multi-task orchestration and status transitions.
 */
const stepTask = async ({
  task,
  agent,
  snapshot: inputSnapshot,
  step,
  reasoner,
  registry,
  store,
  providerRetry,
  timezone,
  loopDetector,
  diagnostics,
  commitContextLimit,
  maxInvalidDecisionRetries = 3,
  guidanceEnabled = true,
}: {
  task: Task;
  agent: Agent;
  snapshot: TaskStateSnapshot;
  step: number;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
  providerRetry: RetryOptions;
  /** Timezone for humanized time in reasoner user messages. Falls back to the system tz. */
  timezone?: string;
  /** Per-run loop detector; gates tool calls by cooldown / max-calls / budget. */
  loopDetector: LoopDetector;
  /** Per-engine diagnostics handle. Threaded so the engine module can emit
   * step-start / step-end events when diagnostics.engine is enabled. */
  diagnostics: Diagnostics;
  /** Max recent commits to inject into reasoner context. */
  commitContextLimit?: number;
  /** Max consecutive invalid model decisions fed back for correction before failing. */
  maxInvalidDecisionRetries?: number;
  /** Whether to compute guidance lines from warning bands. */
  guidanceEnabled?: boolean;
}): Promise<StepOutcome> => {
  // Bounded invalid-decision feedback: a prior rejection (unknown action /
  // schema-invalid input) is surfaced to the model once via lastError, then
  // stripped — ANY valid decision this turn resets the counter. Only the two
  // invalid branches below re-attach it (incremented).
  const priorErrorOpt = option(inputSnapshot.lastDecisionError);
  const snapshot: TaskStateSnapshot = priorErrorOpt.isSome
    ? stripDecisionError(inputSnapshot)
    : inputSnapshot;

  /** Feed an invalid decision back to the model, or fail once retries are exhausted. */
  const invalidDecision = (reason: string): StepOutcome => {
    const consecutiveCount = (priorErrorOpt.isSome ? priorErrorOpt.value.consecutiveCount : 0) + 1;
    if (consecutiveCount > maxInvalidDecisionRetries) {
      return {
        kind: "failed",
        snapshot,
        reason: `invalid decision retries exhausted after ${consecutiveCount} consecutive attempt(s): ${reason}`,
      };
    }
    return { kind: "stepped", snapshot: { ...snapshot, lastDecisionError: { reason, consecutiveCount } } };
  };

  // 1. Discover legal actions for the agent in the current state.
  const agentActionsResult = registry.getActionsForAgent(agent.name);
  if (agentActionsResult.isErr) {
    return { kind: "failed", snapshot, reason: agentActionsResult.error };
  }
  const discovery = discoverActions({ agentActions: agentActionsResult.value, state: snapshot });

  // No discoverable actions — all reachable work is done (or gated). Natural exit.
  if (discovery.available.length === 0) {
    return { kind: "natural-done", snapshot };
  }

  // Order discoverable actions by Bellman value (immediate + discounted expected
  // future cost) so the reasoner sees cheaper paths first (spec §Bellman
  // Optimization: path selection). Actions with no declared estimatedCost have an
  // unknown cost and rank last — the engine prefers known-cheap paths and defers
  // the unpredictable ones. Tokens are the value scalar.
  const remaining = remainingCost(snapshot.budget, snapshot.spent);
  const valueOf = (action: Action): number | null =>
    action.estimatedCost === undefined
      ? null
      : computeActionValue({ immediateCost: action.estimatedCost, expectedFutureCost: remaining }).totalValue;
  const rankedActions = [...discovery.available].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return va - vb;
  });

  // Retrieve relevant memory on demand (spec principle 4) — the agent's most
  // relevant prior memories for this goal, injected as reasoner context rather
  // than carried in the loop.
  const retrieved = await retrieveContext({ store, agentName: agent.name, query: task.goal });

  // Retrieve recent commits so the agent can reference its own past work.
  // Best-effort: a store error or empty result yields no commit context —
  // the step must still proceed (same pattern as memory retrieval).
  let commitContextStr = "";
  const commitsResult = await store.getCommitsByAgent(agent.name, commitContextLimit);
  if (commitsResult.isOk && commitsResult.value.length > 0) {
    commitContextStr = formatCommitContext(commitsResult.value);
  }

  // Deliver mentions: fold any undelivered notes a teammate left for this agent
  // into the reasoning context (informational, not a goal change), and mark each
  // consumed so a mention reaches its recipient exactly once across all of its
  // tasks. Caller-queue messages use the per-task drain instead, so they are
  // excluded here by sender.
  const inbound = await store.getMessagesByReceiver(agent.name);
  const mentionLines: string[] = [];
  if (inbound.isOk) {
    for (const m of inbound.value) {
      // Skip caller-queue messages (per-task drain), already-read mentions, and
      // any the sender recalled before this turn read them.
      if (m.sender === "caller" || m.consumed === true || m.recalledAt !== undefined) continue;
      mentionLines.push(`Teammate ${m.sender} mentioned you: ${String(m.payload)}`);
      // Folding a mention into this turn IS the read: stamp the receipt (visible
      // to the sender's outbox) via markMessageRead, falling back to the legacy
      // consumed marker for adapters that don't support receipts.
      if (store.markMessageRead !== undefined) await store.markMessageRead(m.id, new Date());
      else await store.markMessageConsumed(m.id);
    }
  }
  const reasonContext = [retrieved.context, ...mentionLines].filter((s) => s.length > 0).join("\n");

  // 2. Ask the reasoner what to do next. Delegation targets are every other
  // deployed agent (an agent does not delegate to itself; the supervision tree
  // and budget scoping bound the rest).
  //
  // The reasoner is the least reliable part of the system: a model call can fail
  // with a network error, a maxed-out rate limit, malformed JSON, or simply not
  // calling a tool. Each step is retried with jittered exponential backoff so a
  // transient failure does not sink the task (spec: resilience at the model
  // boundary). The same input is replayed on each attempt.
  // Delegation and mention targets are the agent's teammates: agents sharing its
  // team (or every other agent when it has no team). This scopes collaboration to
  // the team so an agent never hands work to, or pulls in, an agent outside it.
  const teammates = registry.getTeammates(agent.name);

  // Surface skills to the reasoner. Content is read from each skill's SKILL.md;
  // skills without a SKILL.md are omitted entirely (convention: SKILL.md required).
  const availableSkills = await buildAvailableSkills(agent.skills ?? []);

  // ── Time awareness (user message only — keeps the system prefix cacheable) ──
  // Current time: ISO for machine + humanized for the model + tz for grounding.
  // Prior conversation: messages on this task with relative-time labels so the
  // model can reason about gaps across the conversation. A transient store read
  // failure is swallowed — an empty prior-messages list is fine, the rest of
  // the step must still proceed.
  const now = new Date();
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currentTimestamp = {
    iso: now.toISOString(),
    humanized: formatInTimeZone(now, tz, "h:mm a zzz"),
    timezone: tz,
  };

  const msgsResult = await store.getMessages(task.id);
  let priorMessages: Array<{ sender: string; content: string; relativeTime: string }> = [];
  if (msgsResult.isOk) {
    priorMessages = msgsResult.value
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((m) => ({
        sender: m.sender,
        content: typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload),
        relativeTime: formatDistanceToNow(m.createdAt, { addSuffix: true }),
      }));
  }

  // Team roster for the reasoner: what each teammate is doing and how loaded, so
  // the model can route delegations/mentions to idle teammates and away from
  // overloaded ones. Scoped to teammates (same set as availableAgents).
  const rosterEntries = teammates.length > 0
    ? await computeRosterEntries({ store, agentNames: teammates })
    : [];

  const reasonInput = {
    task: { ...task, risk: snapshot.risk, trust: snapshot.trust, updatedAt: new Date() },
    availableActions: rankedActions.map((a) => a.name),
    // Full action schemas (description + JSON schema) so the model sees exactly
    // what input each legal action expects. zod/v3 authoring schemas are bridged
    availableActionSchemas: rankedActions.map((a) => ({
      name: a.name,
      description: a.description,
      schema: toJSONSchema(a.schema) as Record<string, unknown>,
    })),
    // Lightweight tool menu: name + description. The reasoner surfaces the
    // full schema on demand via system:get_tool_schema (progressive disclosure).
    availableTools: registry.listTools().map((name) => {
      const toolResult = registry.getTool(name);
      return toolResult.isOk
        ? { name: toolResult.value.name, description: toolResult.value.description }
        : { name, description: "" };
    }),
    availableAgents: teammates,
    ...(rosterEntries.length > 0 ? { roster: rosterEntries } : {}),
    availableChannels: (agent.channels ?? []).filter((c) => c.enabled).map((c) => c.type),
    availableSkills,
    agentRole: agent.role,
    rolePrompt: agent.rolePrompt,
    currentTimestamp,
    ...(priorMessages.length > 0 ? { priorMessages } : {}),
    ...(reasonContext.length > 0 ? { context: reasonContext } : {}),
    ...(commitContextStr.length > 0 ? { commitContext: commitContextStr } : {}),
    // Tool context: prior history and last info request, surfaced in the user
    // message so the model can build on results it has already seen.
    ...(snapshot.toolHistory !== undefined && snapshot.toolHistory.length > 0 ? { toolHistory: snapshot.toolHistory } : {}),
    ...(snapshot.attachments !== undefined && snapshot.attachments.length > 0 ? { attachments: snapshot.attachments } : {}),
    ...(snapshot.lastToolInfoResult !== undefined ? { toolInfoResult: snapshot.lastToolInfoResult } : {}),
    // Prior invalid decision (unknown action / schema-invalid input), surfaced
    // so the model can correct itself instead of repeating the rejection.
    ...(priorErrorOpt.isSome
      ? { lastError: { reason: priorErrorOpt.value.reason, attempt: priorErrorOpt.value.consecutiveCount, maxAttempts: maxInvalidDecisionRetries } }
      : {}),
    // Live governance readings so the model can self-correct (slow down, prefer
    // cheaper paths, wrap up) before hitting a gate. Time-varying by nature —
    // the adapter renders it in the user message, never the cacheable prefix.
    governanceState: {
      riskScore: snapshot.risk.currentRisk,
      trustScore: snapshot.trust.score,
      spent: snapshot.spent,
      budget: snapshot.budget,
    },
    // Guidance lines: warning-band advisory text so the model can self-correct
    // before hitting escalation thresholds. Conditionally included when non-empty,
    // matching how lastError is handled.
    ...(snapshot.guidance !== undefined && snapshot.guidance.length > 0 ? { guidance: snapshot.guidance } : {}),
  };
  const reasonResult = await retryWithJitter({
    fn: () => reasoner.reason(reasonInput),
    options: providerRetry,
  });

  // Retries exhausted. A persistent model/API failure is exactly the kind of
  // unknown that human oversight exists for (principle 8): escalate rather than
  // silently fail. The escalation record is TaskID-attributable and the task is
  // paused (the scheduler persists a blocked outcome as "paused"), so a human can
  // inspect the failure and resume once the upstream issue is resolved.
  if (reasonResult.isErr) {
    await raiseEscalation({
      taskId: task.id,
      trigger: "reasoner-failure",
      reason: `reasoner failed after ${providerRetry.maxAttempts} attempt(s): ${reasonResult.error}`,
      store,
    });
    return {
      kind: "blocked",
      snapshot,
      reason: `reasoner failed after ${providerRetry.maxAttempts} attempt(s), escalated for human review: ${reasonResult.error}`,
    };
  }

  const decision = reasonResult.value;

  if (decision.kind === "done") {
    return { kind: "natural-done", snapshot };
  }

  // Delegation is handled by the scheduler (it owns the tree + slots). Scoped to
  // the team: an agent may only delegate to a teammate. This is enforced here, not
  // just by what the reasoner is offered, so the boundary holds even if a reasoner
  // proposes an out-of-team target. A registered agent on another team is rejected
  // here; an unknown agent falls through to the scheduler's clearer "not found".
  if (decision.kind === "delegate") {
    const target = decision.delegation.agentName;
    if (registry.getAgent(target).isOk && !teammates.includes(target)) {
      return {
        kind: "failed",
        snapshot,
        reason: `cannot delegate to "${target}": not a teammate of "${agent.name}"`,
      };
    }
    return { kind: "delegate", snapshot, delegation: decision.delegation };
  }

  // A mention references a teammate and leaves them a note on this task. Unlike
  // delegation it spawns no child task; it records a TaskID-attributable
  // agent-to-agent Message and the loop continues. It is scoped to the team: a
  // mention of a non-teammate is rejected (the agent cannot reach outside it).
  if (decision.kind === "mention") {
    const { agentName: mentioned, message } = decision.mention;
    if (!teammates.includes(mentioned)) {
      return {
        kind: "failed",
        snapshot,
        reason: `cannot mention "${mentioned}": not a teammate of "${agent.name}"`,
      };
    }
    const saved = await store.saveMessage({
      id: messageId(),
      taskId: snapshot.taskId,
      sender: agent.name,
      receiver: mentioned,
      payload: message,
      createdAt: new Date(),
    });
    if (saved.isErr) {
      return { kind: "failed", snapshot, reason: `failed to record mention: ${saved.error}` };
    }
    return { kind: "stepped", snapshot };
  }

  // Communication routes through the shared dispatch (resolve channel → approval
  // gate → send → record Message). A send is a step: success continues the loop,
  // a required approval blocks, a transport/channel failure fails the task.
  if (decision.kind === "communicate") {
    const comm = await dispatchCommunication({
      agent,
      channelType: decision.communication.channel,
      body: decision.communication.body,
      taskId: snapshot.taskId,
      agentName: snapshot.agentName,
      phase: snapshot.currentPhase,
      store,
    });
    if (comm.kind === "sent") {
      // Charge the send latency to the task's spend (cost is multi-axis).
      return { kind: "stepped", snapshot: { ...snapshot, spent: addCosts(snapshot.spent, comm.cost) } };
    }
    if (comm.kind === "approval-required") return { kind: "blocked", snapshot, reason: comm.reason };
    return { kind: "failed", snapshot, reason: comm.reason };
  }

  // Tool execution: validate the model-supplied input against the tool's
  // schema, then run the tool fn with a TaskID-attributable context. Extracted
  // to ./tool-dispatch (handleToolExecution) — see that module for the full
  // behavior (loop detection ordering, truncation, history recording).
  if (decision.kind === "tool") {
    return handleToolExecution({ decision, agent, task, snapshot, registry, loopDetector });
  }

  // Tool-info: the model wants a tool's schema, the full history, or a single
  // history entry. Extracted to ./tool-dispatch (handleToolInfo) — synchronous,
  // no I/O beyond the registry lookup already available here.
  if (decision.kind === "tool-info") {
    return handleToolInfo({ decision, snapshot, registry });
  }

  // Search commits — model wants to query the commit store for past records.
  // Extracted to ./tool-dispatch (handleSearchCommits).
  if (decision.kind === "search-commits") {
    return handleSearchCommits({ decision, snapshot, store, agent });
  }

  // Free-loop commit — model voluntarily records a checkpoint with optional
  // notes. Extracted to ./tool-dispatch (handleFreeLoopCommit). Unlike the
  // post-workflow commit step, this does NOT change task status or end the task.
  if (decision.kind === "commit") {
    return handleFreeLoopCommit({ decision, task, agent, snapshot, store });
  }

  const { actionName, input, reasoningCost } = decision.request;

  // 3. Look up the action definition. An unknown name is a malformed model
  // output, not a task-level failure — feed it back for correction (bounded).
  const actionResult = registry.getAction(actionName);
  if (actionResult.isErr) {
    return invalidDecision(`reasoner requested unknown action "${actionName}"`);
  }
  const action = actionResult.value;

  // 3.5. Predictive (MPC) budget check — one-step horizon. The free loop's only
  // knowable future is the action the model just proposed; anything beyond it
  // is an epistemic boundary (prohibition 14), as is an action with no declared
  // estimatedCost. Refuse to execute when the *known* projected cost already
  // exceeds the budget (spec §Model Predictive Control) — mirrors the workflow
  // pre-flight block in runtime.ts.
  if (action.estimatedCost !== undefined) {
    const projected = addCosts(
      addCosts(snapshot.spent, reasoningCost ?? { tokens: 0, durationMs: 0 }),
      action.estimatedCost,
    );
    if (isOverBudget(projected, snapshot.budget)) {
      await raiseEscalation({
        taskId: task.id,
        trigger: "budget-violation",
        reason: `projected cost of action "${actionName}" (${projected.tokens} tokens / ${projected.durationMs}ms including spend to date) exceeds budget before execution (MPC)`,
        store,
      });
      return {
        kind: "blocked",
        snapshot,
        reason: `escalated: action "${actionName}" is projected to exceed the task budget before execution (MPC)`,
      };
    }
  }

  // 4. Resolve approval status; auto-request and block when required-but-absent.
  // The `{ untilTrust }` waiver applies ONLY when no request exists yet: once
  // the task's trust reaches the declared threshold the gate is auto-approved
  // (audited via recordAutoApproval).
  const approvalStatusResult = await getApprovalStatusForAction({ taskId: task.id, action: actionName, store });
  let approvalStatus = approvalStatusResult.isOk ? approvalStatusResult.value : "none";

  // A rejection is final (prohibition 11) — but final for the ACTION, not the
  // task. Feed the reviewer's reason back (bounded, same counter as invalid
  // decisions) so the model routes around the closed gate instead of the task
  // dead-blocking on every resume. The gateway's own rejected-block still
  // stands should this branch ever be bypassed (defense in depth).
  if (approvalRequired(action.requiresApproval) && approvalStatus === "rejected") {
    const rejection = await describeRejection({ taskId: task.id, action: actionName, store });
    return invalidDecision(
      `${rejection} — this action will not be approved; choose a different approach or finish with a report of what you could not do`,
    );
  }

  if (approvalRequired(action.requiresApproval) && approvalStatus === "none") {
    const untilTrustOpt = option(
      typeof action.requiresApproval === "object" ? action.requiresApproval.untilTrust : undefined,
    );
    if (untilTrustOpt.isSome && snapshot.trust.score >= untilTrustOpt.value) {
      await recordAutoApproval({
        taskId: task.id,
        action: actionName,
        reason: `auto-approved: trust ${snapshot.trust.score.toFixed(2)} >= ${untilTrustOpt.value} (declared waiver)`,
        store,
      });
      approvalStatus = "approved";
    } else {
      const reqResult = await requestApproval({
        taskId: task.id,
        action: actionName,
        reason: `action "${actionName}" requires human approval before execution`,
        store,
      });
      const approvalIdStr = reqResult.isOk ? reqResult.value.id : "(unavailable)";
      return {
        kind: "blocked",
        snapshot,
        reason: `approval-required: action "${actionName}" needs human sign-off — approval id: ${approvalIdStr}`,
      };
    }
  }

  // 5. Run through the execution gateway. The action fn / hooks get governed
  // ctx helpers bound to this agent + task: channel-send and memory-write.
  const communicate = makeContextCommunicate({ agent, taskId: task.id, agentName: agent.name, store });
  const remember = makeContextRemember({ store, taskId: task.id, agentName: agent.name });
  // Per-action skills override the agent-level set when declared; otherwise the
  // full agent skill set (already built for the reasoner above) is forwarded.
  let actionAvailableSkills = availableSkills;
  if (action.skills !== undefined) {
    const refsResult = resolveSkillRefs(action.skills, agent.skills ?? []);
    if (refsResult.isErr) {
      return { kind: "failed", snapshot, reason: `skill resolution failed for action "${action.name}": ${refsResult.error}` };
    }
    actionAvailableSkills = await buildAvailableSkills(refsResult.value);
  }
  const gwResult = await runGateway({ action, rawInput: input, state: snapshot, approvalStatus, store, reasoningCost, stepIndex: step, communicate, remember, availableSkills: actionAvailableSkills });

  if (gwResult.isErr) {
    if (gwResult.error.startsWith("approval-required:")) {
      return { kind: "blocked", snapshot, reason: gwResult.error };
    }
    // Schema-invalid input is a malformed model output — feed back (bounded),
    // same as an unknown action. Every other gateway block keeps failing.
    if (gwResult.error.startsWith("schema-invalid:")) {
      return invalidDecision(gwResult.error);
    }
    return { kind: "failed", snapshot, reason: gwResult.error };
  }

  const { fnResult, updatedSnapshot, surpriseMagnitude } = gwResult.value;
  let next = updatedSnapshot;

  // 6. Post-step governance (escalation + trust/risk persistence), shared with
  // the workflow path. An escalation pauses the task and surfaces as blocked.
  const gov = await applyPostStepGovernance({ taskId: task.id, snapshot: next, surpriseMagnitude, store, guidanceEnabled });
  next = gov.snapshot;
  if (gov.kind === "escalated") {
    return { kind: "blocked", snapshot: next, reason: gov.reason };
  }

  // 7. Checkpoint after a successful action so pause/resume has a recovery point.
  if (fnResult.isOk) {
    const ckpt: Checkpoint = {
      id: checkpointId(),
      taskId: task.id,
      state: snapshotToJson(next),
      createdAt: new Date(),
    };
    await store.saveCheckpoint(ckpt);
  }

  return { kind: "stepped", snapshot: next };
};

// ── Scheduler ────────────────────────────────────────────────────────────────

/** Map a terminal SendResult status to the persisted task status. */
const taskStatusFor = (status: SendResult["status"]): Task["status"] =>
  status === "completed" ? "completed" : status === "blocked" ? "paused" : "failed";

/**
 * Drive a root task and any subtasks it delegates to completion.
 *
 * Each pass advances every still-running task by one step (deterministic
 * round-robin, parent before children). The loop ends when no runner is left
 * running; the root task's terminal result is returned.
 */
export const runScheduler = async ({
  root,
  reasoner,
  registry,
  store,
  maxSteps,
  providerRetry = defaultRetryOptions,
  timezone,
  logger,
  diagnostics,
  loopDetector: passedLoopDetector,
  commitContextLimit = 10,
  maxInvalidDecisionRetries,
  guidanceEnabled = true,
}: {
  root: Runner;
  reasoner: ReasonerPort;
  registry: Registry;
  store: StoragePort;
  maxSteps: number;
  providerRetry?: RetryOptions;
  /** Timezone for humanized time in reasoner user messages; falls back to system tz in stepTask. */
  timezone?: string;
  /** Per-engine logger threaded from the engine factory. */
  logger: Logger;
  /** Per-engine diagnostics handle. Threaded into the main loop so opt-in
   * modules (engine, actions, ...) can emit structured events. */
  diagnostics: Diagnostics;
  /** Per-run loop detector. When omitted, the scheduler builds a fresh one —
   * loop detection is about within-run loops, so a fresh detector per
   * runScheduler call is the natural default. */
  loopDetector?: LoopDetector;
  /** Max recent commits to inject into reasoner context (default 10). */
  commitContextLimit?: number;
  /** Max consecutive invalid model decisions fed back before failing (defaulted in stepTask). */
  maxInvalidDecisionRetries?: number;
  /** Whether to compute guidance lines from warning bands. */
  guidanceEnabled?: boolean;
}): Promise<SendResult> => {
  const rootId = root.task.rootId;
  const runners: Runner[] = [root];
  let treeInitialized = false;
  // Fresh loop detector per scheduler run: counters and spend start at zero
  // for every agent. The same instance is reused across all steps in this run.
  const loopDetector = passedLoopDetector ?? createLoopDetector({ logger });
  // Engine diagnostics: pre-resolve once so the main loop does not pay the
  // Map lookup on every step. Returns the shared no-op when diagnostics.engine
  // is disabled — the methods are no-ops and inlined away by the JIT.
  const engineDiag = diagnostics.for("engine");

  const findRunner = (id: string): Option<Runner> => option(runners.find((r) => r.task.id === id));

  /** Create the supervision tree lazily — only a task that actually delegates needs one. */
  const ensureTree = async (): Promise<TaskTree> => {
    const existing = await store.getTaskTree(rootId);
    if (existing.isOk) {
      treeInitialized = true;
      return existing.value;
    }
    const tree: TaskTree = { rootTaskId: rootId, activeChildren: [], queuedChildren: [], maxConcurrency: 2 };
    await store.saveTaskTree(tree);
    treeInitialized = true;
    return tree;
  };

  /** Load a queued child task and add it as an active runner. */
  const startRunner = async (childTaskId: string): Promise<void> => {
    const taskResult = await store.getTask(childTaskId);
    if (taskResult.isErr) return;
    const childTask = taskResult.value;
    const agentResult = registry.getAgent(childTask.assignedAgent);
    if (agentResult.isErr) return;
    await store.updateTask(childTaskId, { status: "running", updatedAt: new Date() });
    runners.push(
      makeRunner({
        task: { ...childTask, status: "running" },
        agent: agentResult.value,
        snapshot: { ...snapshotFromTask(childTask), status: "running" },
        maxSteps,
      }),
    );
  };

  // ── H2: Rehydrate active child runners on resume ────────────────────────────
  // When a task is resumed after a pause, its supervision tree may already
  // contain active children that were running before the pause. Without
  // rehydration, those children are silently dropped and their work is lost.
  // We load each non-terminal activeChild from the persisted tree and push a
  // runner via startRunner so they are driven to completion alongside the root.
  //
  // Guards: (a) skip ids already in runners (duplicate guard — the root runner
  //   is already present); (b) skip children whose status is terminal
  //   (completed/failed/aborted — they settled before the pause); (c) skip
  //   on a missing/Err task record or unknown agent — do not abort the whole
  //   resume for one bad child.
  const existingTree = await store.getTaskTree(rootId);
  if (existingTree.isOk) {
    treeInitialized = true;
    const terminalStatuses = new Set<string>(["completed", "failed", "aborted"]);
    for (const childId of existingTree.value.activeChildren) {
      if (findRunner(childId).isSome) continue; // (a) already a runner
      const childTaskResult = await store.getTask(childId);
      if (childTaskResult.isErr) continue; // (c) missing task
      const childTask = childTaskResult.value;
      if (terminalStatuses.has(childTask.status)) continue; // (b) already terminal
      const agentCheck = registry.getAgent(childTask.assignedAgent);
      if (agentCheck.isErr) continue; // (c) unknown agent
      await startRunner(childId);
    }
  }

  /** Settle a runner: record its result, persist status, and do tree bookkeeping. */
  const settle = async (runner: Runner, result: SendResult): Promise<void> => {
    runner.settled = true;
    runner.result = result;
    await store.updateTask(runner.task.id, { status: taskStatusFor(result.status), updatedAt: new Date() });

    // Child finished → refund its unused reservation to the parent and free its
    // slot. The parent reserved the child's full budget at delegation; the child
    // only actually consumed `spent`, so return the difference. Net parent spend
    // across delegate + settle is exactly the child's real spend.
    const parentId = runner.task.parentId;
    if (parentId !== undefined && treeInitialized) {
      const parentOpt = findRunner(parentId);
      if (parentOpt.isSome) {
        const refund = remainingCost(runner.snapshot.budget, runner.snapshot.spent);
        parentOpt.value.snapshot = { ...parentOpt.value.snapshot, spent: remainingCost(parentOpt.value.snapshot.spent, refund) };
        const parentResultOpt = option(parentOpt.value.result);
        if (parentResultOpt.isSome) parentOpt.value.result = { ...parentResultOpt.value, snapshot: parentOpt.value.snapshot };
      }
      const treeResult = await store.getTaskTree(rootId);
      if (treeResult.isOk) {
        const released = releaseSlot(treeResult.value, runner.task.id);
        await store.updateTaskTree(rootId, {
          activeChildren: released.tree.activeChildren,
          queuedChildren: released.tree.queuedChildren,
        });
        const promoted = option(released.promoted);
        if (promoted.isSome) await startRunner(promoted.value);
      }
    }

    // Root failed/blocked while children are live → cascade the abort (invariant 17).
    if (runner.task.id === rootId && result.status !== "completed" && treeInitialized) {
      await abortEntireTree({ rootTaskId: rootId, store });
      for (const r of runners) {
        if (!r.settled && r.task.id !== rootId) {
          r.settled = true;
          r.result = {
            taskId: r.task.id,
            status: "failed",
            snapshot: r.snapshot,
            reason: "aborted: parent tree aborted",
          };
        }
      }
    }
  };

  /** Register a delegated child: scope its budget, create it, take or queue a slot. */
  const handleDelegate = async (parent: Runner, delegation: DelegationRequest): Promise<void> => {
    const agentResult = registry.getAgent(delegation.agentName);
    if (agentResult.isErr) {
      await settle(parent, {
        taskId: parent.task.id,
        status: "failed",
        snapshot: parent.snapshot,
        reason: `delegate failed: agent "${delegation.agentName}" not found`,
      });
      return;
    }

    const requested: Cost = delegation.budget ?? remainingCost(parent.snapshot.budget, parent.snapshot.spent);
    const childBudget = enforceSubtaskScope({
      requestedBudget: requested,
      parentBudget: parent.snapshot.budget,
      parentSpent: parent.snapshot.spent,
    });

    // Reserve the child's budget against the parent up front (debit parent spend
    // by the granted budget). This makes invariant 18 structural: concurrent
    // delegations draw from a shrinking pool, so two children can never each be
    // granted the parent's full remaining. The unused remainder is refunded when
    // the child settles, so the parent ultimately spends only what the child did.
    parent.snapshot = { ...parent.snapshot, spent: addCosts(parent.snapshot.spent, childBudget) };

    const id = taskId();
    const now = new Date();
    const childTask: Task = {
      id,
      rootId,
      parentId: parent.task.id,
      status: "pending",
      goal: delegation.goal,
      assignedAgent: delegation.agentName,
      budget: childBudget,
      risk: initialRiskState(),
      trust: initialTrust(),
      createdAt: now,
      updatedAt: now,
    };
    await store.saveTask(childTask);

    const tree = await ensureTree();
    const slot = requestSlot(tree, id);
    await store.updateTaskTree(rootId, {
      activeChildren: slot.tree.activeChildren,
      queuedChildren: slot.tree.queuedChildren,
    });

    if ("granted" in slot) {
      await store.updateTask(id, { status: "running", updatedAt: new Date() });
      runners.push(
        makeRunner({
          task: { ...childTask, status: "running" },
          agent: agentResult.value,
          // The child carries the parent's budget/spend so the legality guard can
          // block it the moment the parent's budget is exhausted (invariant 18).
          snapshot: {
            ...snapshotFromTask(childTask),
            status: "running",
            parentBudget: parent.snapshot.budget,
            parentSpent: parent.snapshot.spent,
          },
          maxSteps,
        }),
      );
    }
    // Otherwise the child is queued; startRunner promotes it on a slot release.
  };

  /**
   * Drain unconsumed caller messages into the task's goal (H5b). Returns true
   * when at least one was folded in, so the caller keeps the task running to
   * actually handle the new work instead of settling.
   */
  const drainMessages = async (runner: Runner): Promise<boolean> => {
    const msgsResult = await store.getMessages(runner.task.id);
    if (msgsResult.isErr) return false;
    const fresh = msgsResult.value.filter((m) => m.sender === "caller" && !runner.consumed.has(m.id));
    if (fresh.length === 0) return false;

    for (const m of fresh) runner.consumed.add(m.id);
    const appended = fresh.map((m) => String(m.payload)).join("; ");
    runner.task = { ...runner.task, goal: `${runner.task.goal}\n[queued] ${appended}` };
    runner.snapshot = {
      ...runner.snapshot,
      consumedMessages: [...(runner.snapshot.consumedMessages ?? []), ...fresh.map((m) => m.id)],
    };
    // Checkpoint the consumed ids now so the drain is idempotent across a later
    // resume — otherwise, if no action runs after this drain, the consumed set is
    // never persisted and the same messages would be folded in again (D4).
    await store.saveCheckpoint({
      id: checkpointId(),
      taskId: runner.task.id,
      state: snapshotToJson(runner.snapshot),
      createdAt: new Date(),
    });
    return true;
  };

  // ── Main round-robin loop ───────────────────────────────────────────────
  while (true) {
    const active = runners.filter((r) => !r.settled);
    if (active.length === 0) break;

    for (const runner of active) {
      if (runner.settled) continue; // a sibling's abort cascade may have settled it mid-pass

      if (runner.step >= runner.maxSteps) {
        await settle(runner, {
          taskId: runner.task.id,
          status: "failed",
          snapshot: runner.snapshot,
          reason: `task exceeded ${runner.maxSteps}-step limit`,
        });
        continue;
      }

      // Refresh a child's view of the parent budget from the parent's *current*
      // spend, so the legality guard (invariant 18) reflects live interleaving
      // rather than a stale delegation-time copy (D2). When the parent exhausts
      // its budget, the child's actions become illegal on the very next step.
      if (runner.task.parentId !== undefined) {
        const parentOpt = findRunner(runner.task.parentId);
        if (parentOpt.isSome) {
          runner.snapshot = {
            ...runner.snapshot,
            parentBudget: parentOpt.value.snapshot.budget,
            parentSpent: parentOpt.value.snapshot.spent,
          };
        }
      }

      // Engine instrumentation (PoC): step-start before the step, step-end
      // after with the outcome kind. Two emission points per step; the
      // disabled path is provably zero overhead.
      engineDiag.event("step-start", { taskId: runner.task.id, step: runner.step });
      const outcome = await stepTask({
        task: runner.task,
        agent: runner.agent,
        snapshot: runner.snapshot,
        step: runner.step,
        reasoner,
        registry,
        store,
        providerRetry,
        timezone,
        loopDetector,
        diagnostics,
        commitContextLimit,
        maxInvalidDecisionRetries,
        guidanceEnabled,
      });
      runner.step++;
      runner.snapshot = outcome.snapshot;
      engineDiag.event("step-end", { taskId: runner.task.id, step: runner.step, kind: outcome.kind });

      // Phase-change detection: when the snapshot's currentPhase differs from
      // what the runner last saw, reset per-phase tool counters so phase-scoped
      // limits are bound to the phase, not the whole task. Free-loop tasks
      // (no workflow) never change phase, so the reset is a no-op for them.
      if (outcome.snapshot.currentPhase !== runner.previousPhase) {
        loopDetector.resetPhase(runner.agent.name);
        runner.previousPhase = outcome.snapshot.currentPhase;
      }

      if (outcome.kind === "stepped") continue;

      if (outcome.kind === "delegate") {
        await handleDelegate(runner, outcome.delegation);
        continue;
      }

      if (outcome.kind === "blocked") {
        await settle(runner, { taskId: runner.task.id, status: "blocked", snapshot: outcome.snapshot, reason: outcome.reason });
        continue;
      }

      if (outcome.kind === "failed") {
        await settle(runner, { taskId: runner.task.id, status: "failed", snapshot: outcome.snapshot, reason: outcome.reason });
        continue;
      }

      // natural-done: drain queued caller messages first; if any arrived, keep
      // running to handle them rather than settling.
      const drained = await drainMessages(runner);
      if (drained) continue;

      // A task that stopped while over budget did not finish cleanly — completion
      // would misreport an exhausted run as success (spec §Cost Friction Detection).
      if (isOverBudget(runner.snapshot.spent, runner.snapshot.budget)) {
        await settle(runner, {
          taskId: runner.task.id,
          status: "failed",
          snapshot: runner.snapshot,
          reason: "task halted with budget exhausted",
        });
        continue;
      }

      // A subtask whose only reason it has nothing left to do is an exhausted
      // parent budget did NOT finish its work — it was starved out of scope
      // (invariant 18). Reporting it completed would hide unfinished work (D2).
      if (
        runner.snapshot.parentBudget !== undefined &&
        runner.snapshot.parentSpent !== undefined &&
        isOverBudget(runner.snapshot.parentSpent, runner.snapshot.parentBudget)
      ) {
        await settle(runner, {
          taskId: runner.task.id,
          status: "failed",
          snapshot: runner.snapshot,
          reason: "subtask halted: parent budget exhausted — cannot exceed parent scope (invariant 18)",
        });
        continue;
      }

      await settle(runner, { taskId: runner.task.id, status: "completed", snapshot: runner.snapshot });
    }
  }

  // ── Aggregate the subtree's outcome into the root result (D1) ─────────────
  // The root's own loop may reach "completed" while a delegated child settled
  // failed or blocked. A parent is not done until its subtree is: a delegated
  // failure must never be reported up as success, and a child blocked on human
  // oversight must surface as blocked. (The free loop has no per-child
  // supervision policy; this propagation is its minimal failure handling.)
  const rootResult: SendResult =
    root.result ?? {
      taskId: root.task.id,
      status: "failed",
      snapshot: root.snapshot,
      reason: "scheduler ended without a root result",
    };
  if (rootResult.status !== "completed") return rootResult;

  const childResults = runners.filter((r) => r.task.id !== rootId).map((r) => r.result);

  const failedChildOpt = option(childResults.find((r) => r !== null && r.status === "failed"));
  if (failedChildOpt.isSome) {
    await store.updateTask(rootId, { status: "failed", updatedAt: new Date() });
    return {
      ...rootResult,
      status: "failed",
      reason: `delegated subtask "${failedChildOpt.value.taskId}" failed: ${failedChildOpt.value.reason ?? "(no reason)"}`,
    };
  }

  const blockedChildOpt = option(childResults.find((r) => r !== null && r.status === "blocked"));
  if (blockedChildOpt.isSome) {
    await store.updateTask(rootId, { status: "paused", updatedAt: new Date() });
    return {
      ...rootResult,
      status: "blocked",
      reason: `delegated subtask "${blockedChildOpt.value.taskId}" is blocked awaiting human oversight: ${blockedChildOpt.value.reason ?? "(no reason)"}`,
    };
  }

  return rootResult;
};
