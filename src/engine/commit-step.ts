/**
 * Commit step — a constrained reasoner turn after a workflow completes.
 *
 * Workflows are reasoner-less: the engine runs phases deterministically. But
 * the agent must acknowledge completion by calling finish_task (optionally with
 * a summary). This acknowledgement is persisted as a Commit record linked to
 * the latest checkpoint, so future runs can surface the agent's own notes in
 * their context.
 *
 * The commit step is mandatory for workflows. If the agent does not commit
 * after `maxRetries` turns, the engine auto-commits with no notes so the task
 * does not hang forever. If the reasoner fails entirely (API error, malformed
 * response), the task stays "pendingCommit" and send() returns that status —
 * the caller can resume to retry the commit step.
 *
 * For free-loop tasks, the commit tool is optional (Phase 6) — the agent can
 * call it during the normal send loop, but the post-workflow commit step does
 * not run.
 */

import { Ok, Err } from "slang-ts";
import type { Result } from "slang-ts";
import type { Task, Commit } from "../shared/types";
import type { StoragePort } from "../ports/storage-port";
import type { ReasonerPort } from "../ports/reasoner-port";
import type { Agent } from "../authoring/types";
import type { TaskStateSnapshot } from "../state-space/types";
import type { RetryOptions } from "../infra";
import { retryWithJitter } from "../infra";
import { commitId } from "../shared/id";
import type { Logger } from "../shared/logger-types";
import type { Diagnostics } from "../shared/diagnostics";
import type { SendResult } from "./types";
import { formatDistanceToNow } from "date-fns";

const COMMIT_MAX_RETRIES_DEFAULT = 3;

/**
 * Format recent commits as a human-readable bullet list for the reasoner context.
 *
 * Each commit shows its workflow name (or "free-loop"), notes (or "no notes"),
 * and relative time. The format is designed for the model — humanized, no
 * internal IDs or mechanics (AGENTS.md: user-facing messages must be humanized).
 */
export const formatCommitContext = (commits: Commit[]): string => {
  if (commits.length === 0) return "";
  return commits
    .map((c) => {
      const source = c.workflowName ?? "free-loop";
      const notes = c.notes ?? "no notes";
      const ago = formatDistanceToNow(c.createdAt, { addSuffix: true });
      return `- [${source}] ${notes} (${ago})`;
    })
    .join("\n");
};

/**
 * Build the context string that prompts the agent to commit.
 *
 * The prompt is humanized (AGENTS.md: no internal mechanics in user-facing
 * text). It tells the agent what to do without exposing engine internals.
 */
const buildCommitPrompt = (workflowName: string, attempt: number): string => {
  const base = `You just completed the workflow "${workflowName}". Call finish_task to finalize your work. You may include a brief summary of what you accomplished as the reason — this will be saved for your reference in future tasks.`;
  if (attempt > 0) {
    return `${base}\n\nThis is reminder ${attempt + 1}. You must call finish_task to complete this task. No other actions are available.`;
  }
  return base;
};

/**
 * Save a commit record and mark the task completed.
 */
const finalizeCommit = async ({
  task,
  agent,
  store,
  workflowName,
  notes,
  checkpointId,
  snapshot,
}: {
  task: Task;
  agent: Agent;
  store: StoragePort;
  workflowName: string;
  notes: string | null;
  checkpointId: string | null;
  snapshot: TaskStateSnapshot;
}): Promise<SendResult> => {
  const commit: Commit = {
    id: commitId(),
    taskId: task.id,
    agentName: agent.name,
    workflowName,
    notes,
    checkpointId,
    createdAt: new Date(),
  };

  const saveResult = await store.saveCommit(commit);
  if (saveResult.isErr) {
    // Log the failure but don't block completion — the task is done, the
    // commit record is metadata. A missing commit note is better than a
    // task stuck in pendingCommit forever.
    // The logger is not threaded here to keep the function pure; the caller
    // logs if needed.
  }

  await store.updateTask(task.id, { status: "completed", updatedAt: new Date() });
  return { taskId: task.id, status: "completed", snapshot };
};

/**
 * Run the post-workflow commit step.
 *
 * Sets the task to "pendingCommit", then drives a constrained reasoner turn
 * where the only available action is finish_task. The agent's `reason` field
 * on the finish_task decision becomes the commit notes.
 *
 * - Agent calls finish_task → save Commit (notes = reason), task "completed".
 * - Agent calls something else → re-prompt (up to maxRetries).
 * - Reasoner API fails → retry with jitter (up to maxRetries), then auto-commit.
 * - All retries exhausted → auto-commit with no notes, task "completed".
 *
 * @returns SendResult with status "completed" on success, "pendingCommit" if
 *   the reasoner failed entirely and the task should be resumed later.
 */
export const runCommitStep = async ({
  task,
  agent,
  reasoner,
  store,
  workflowName,
  snapshot,
  maxRetries = COMMIT_MAX_RETRIES_DEFAULT,
  providerRetry,
  timezone,
  logger,
  diagnostics,
}: {
  task: Task;
  agent: Agent;
  reasoner: ReasonerPort;
  store: StoragePort;
  /** Workflow name for the commit record. Null for free-loop commits (Phase 6). */
  workflowName: string;
  /** The final snapshot from the completed workflow. */
  snapshot: TaskStateSnapshot;
  maxRetries?: number;
  providerRetry?: RetryOptions;
  timezone?: string;
  logger: Logger;
  diagnostics: Diagnostics;
}): Promise<SendResult> => {
  // Mark the task as pending commit so the hard block (Phase 3) can prevent
  // new tasks for this agent until the commit is finalized.
  await store.updateTask(task.id, { status: "pendingCommit", updatedAt: new Date() });

  // Link the commit to the latest checkpoint for audit traceability.
  const ckptResult = await store.getLatestCheckpoint(task.id);
  const checkpointId =
    ckptResult.isOk && ckptResult.value !== null ? ckptResult.value.id : null;

  const diag = diagnostics.for("engine");

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    diag.event("commit-step-attempt", { taskId: task.id, attempt, workflowName });

    const commitContext = buildCommitPrompt(workflowName, attempt);

    // Retry the reasoner call itself for transient API failures (jittered
    // backoff per AGENTS.md). A single attempt here = one reasoner call.
    const reasonResult = await retryWithJitter({
      fn: () => reasoner.reason({
        task,
        availableActions: [],
        agentRole: agent.role,
        rolePrompt: agent.rolePrompt,
        context: commitContext,
        commitMode: true,
        ...(timezone !== undefined
          ? {
              currentTimestamp: {
                iso: new Date().toISOString(),
                humanized: new Date().toLocaleString("en-US", { timeZone: timezone }),
                timezone,
              },
            }
          : {}),
      }),
      options: providerRetry,
    });

    if (reasonResult.isErr) {
      // Reasoner API failure — log and continue to the next attempt. The
      // underlying error + workflow + attempt are embedded in the message so
      // the entry is self-contained for triage (AGENTS.md: logs must carry
      // resolving context, never swallow the cause).
      logger.error(
        `Commit step reasoner call failed for task "${task.id}" (workflow="${workflowName}", attempt=${attempt}): ${reasonResult.error}`,
        { taskId: task.id },
      );
      continue;
    }

    const decision = reasonResult.value;

    if (decision.kind === "done") {
      // Agent committed — save the commit record with optional notes.
      diag.event("commit-step-done", { taskId: task.id, workflowName, hasNotes: decision.reason !== undefined });

      return finalizeCommit({
        task,
        agent,
        store,
        workflowName,
        notes: decision.reason ?? null,
        checkpointId,
        snapshot,
      });
    }

    // Agent didn't call finish_task — re-prompt with a stronger message.
    logger.warn(
      `Agent did not commit for task "${task.id}" (workflow="${workflowName}", attempt=${attempt}, decisionKind="${decision.kind}"), re-prompting`,
      { taskId: task.id },
    );
  }

  // All retries exhausted — auto-commit with no notes so the task doesn't
  // hang. The user said "agent can just commit without any notes" — this is
  // the engine enforcing that escape hatch.
  logger.warn(
    `Commit step exhausted retries for task "${task.id}" (workflow="${workflowName}", maxRetries=${maxRetries}), auto-committing with no notes`,
    { taskId: task.id },
  );

  diag.event("commit-step-auto-commit", { taskId: task.id, workflowName });

  return finalizeCommit({
    task,
    agent,
    store,
    workflowName,
    notes: null,
    checkpointId,
    snapshot,
  });
};