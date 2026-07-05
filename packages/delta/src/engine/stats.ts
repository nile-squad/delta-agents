/**
 * Agent stats and workflow benchmarks — derived read-models of performance and cost.
 *
 * Like `roster()`, these are computed on-demand from persisted data: tasks,
 * executions, and checkpoints. No separate analytics table; no async bookkeeping.
 * Each read re-derives from the authoritative store state, so they are always
 * consistent with reality (the same pattern as the roster).
 *
 * Three read-models:
 *   topAgents — per-agent ranking by completedTasks, successRate, or trustScore.
 *   agentStats — metrics for one agent: counts, success rate, cost, trust trajectory.
 *   workflowStats — metrics for one workflow: runs, success rate, cost, phase durations.
 */

import { Ok, Err, option } from "slang-ts";
import type { Result } from "slang-ts";
import type { StoragePort } from "../ports/storage-port";
import type { Task, Execution, Checkpoint, Cost } from "../shared";
import { addCosts, zeroCost } from "../shared/cost";
import { initialTrust } from "../governance/trust";

// ── Types ────────────────────────────────────────────────────────────────

export type AgentRanking = {
  agent: string;
  completedTasks: number;
  failedTasks: number;
  successRate: number;
  avgDurationMs: number;
  trustScore: number;
};

export type AgentStats = {
  completedTasks: number;
  failedTasks: number;
  successRate: number;
  avgCost: Cost;
  avgDurationMs: number;
  scoreOverTime: { at: Date; score: number }[];
};

export type WorkflowStats = {
  runs: number;
  completed: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
  avgCost: Cost;
  phases: { phase: string; avgDurationMs: number; runs: number }[];
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** A task's status is settled (execution complete, failed, or aborted). */
const isSettledStatus = (status: Task["status"]): boolean =>
  status === "completed" || status === "failed" || status === "aborted";

/** Sum a list of costs and return the average, rounding axes individually. */
const averageCosts = (costs: Cost[]): Cost => {
  if (costs.length === 0) return { tokens: 0, durationMs: 0 };
  const sum = costs.reduce((acc, c) => addCosts(acc, c), zeroCost());
  const avg: Cost = {
    tokens: Math.round(sum.tokens / costs.length),
    durationMs: Math.round(sum.durationMs / costs.length),
  };
  // Include optional axes only if at least one cost carried them.
  const hasMemory = costs.some((c) => c.memory !== undefined);
  const hasLatency = costs.some((c) => c.latency !== undefined);
  const hasMoney = costs.some((c) => c.money !== undefined);
  if (hasMemory) avg.memory = Math.round(sum.memory !== undefined ? sum.memory / costs.length : 0);
  if (hasLatency) avg.latency = Math.round(sum.latency !== undefined ? sum.latency / costs.length : 0);
  if (hasMoney && sum.money !== undefined) {
    avg.money = { value: Math.round(sum.money.value / costs.length), currency: sum.money.currency };
  }
  return avg;
};

// ── Compute functions ────────────────────────────────────────────────────

/**
 * Rank agents by a chosen metric. Ties break by completedTasks desc, then
 * agent name asc.
 *
 * Includes all deployed agents, even those with zero tasks (they appear as
 * zeros + trustScore 0.5). Unknown agent: not an error, simply omitted.
 */
export const computeTopAgents = async ({
  store,
  agentNames,
  by,
  limit = 10,
}: {
  store: StoragePort;
  agentNames: string[];
  by: "completedTasks" | "successRate" | "trustScore";
  limit?: number;
}): Promise<Result<AgentRanking[], string>> => {
  if (store.getTasksByAgent === undefined) {
    return Err("store does not support getTasksByAgent — required for topAgents");
  }

  const rankings: AgentRanking[] = [];
  for (const agent of agentNames) {
    const tasksRes = await store.getTasksByAgent(agent);
    // Best-effort like the roster: a store read failure degrades to omitting
    // that one agent rather than failing the whole ranking. An agent with no
    // tasks yields Ok([]) and ranks with zeros.
    if (tasksRes.isErr) continue;
    const allTasks = tasksRes.value;
    const settledTasks = allTasks.filter((t) => isSettledStatus(t.status));

    const completedTasks = settledTasks.filter((t) => t.status === "completed").length;
    const failedTasks = settledTasks.filter((t) => t.status === "failed" || t.status === "aborted").length;
    const successRate = settledTasks.length > 0 ? completedTasks / settledTasks.length : 0;
    const avgDurationMs = settledTasks.length > 0
      ? Math.round(
        settledTasks.reduce((sum, t) => sum + (t.updatedAt.getTime() - t.createdAt.getTime()), 0) /
        settledTasks.length,
      )
      : 0;
    // Trust score: most recent task (by updatedAt), or initial trust if none.
    const trustScore = allTasks.length > 0
      ? allTasks.reduce((a, b) => (b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a)).trust.score
      : initialTrust().score;

    rankings.push({ agent, completedTasks, failedTasks, successRate, avgDurationMs, trustScore });
  }

  // Sort by the chosen metric (desc), then completedTasks desc, then agent name asc.
  const sorted = rankings.sort((a, b) => {
    const byVal = by === "completedTasks"
      ? b.completedTasks - a.completedTasks
      : by === "successRate"
        ? b.successRate - a.successRate
        : b.trustScore - a.trustScore;
    if (byVal !== 0) return byVal;
    const completed = b.completedTasks - a.completedTasks;
    if (completed !== 0) return completed;
    return a.agent.localeCompare(b.agent);
  });

  return Ok(sorted.slice(0, limit));
};

/**
 * Stats for a single agent: counts, rates, cost, and trust progression.
 * Unknown agent: returns zero-valued stats (counts = 0, rates = 0, scores = []),
 * not an error.
 */
export const computeAgentStats = async ({
  store,
  agent,
}: {
  store: StoragePort;
  agent: string;
}): Promise<Result<AgentStats, string>> => {
  if (store.getTasksByAgent === undefined) {
    return Err("store does not support getTasksByAgent — required for agentStats");
  }

  // An unknown agent yields Ok([]) and produces zero-valued stats naturally;
  // an Err here is a genuine store failure and must surface, not read as zeros.
  const tasksRes = await store.getTasksByAgent(agent);
  if (tasksRes.isErr) return Err(`agentStats failed reading tasks for "${agent}": ${tasksRes.error}`);

  const allTasks = tasksRes.value;
  const settledTasks = allTasks.filter((t) => isSettledStatus(t.status));

  const completedTasks = settledTasks.filter((t) => t.status === "completed").length;
  const failedTasks = settledTasks.filter((t) => t.status === "failed" || t.status === "aborted").length;
  const successRate = settledTasks.length > 0 ? completedTasks / settledTasks.length : 0;
  const avgDurationMs = settledTasks.length > 0
    ? Math.round(
      settledTasks.reduce((sum, t) => sum + (t.updatedAt.getTime() - t.createdAt.getTime()), 0) /
      settledTasks.length,
    )
    : 0;

  // avgCost: per-task execution costs, averaged across settled tasks.
  const taskCosts: Cost[] = [];
  for (const task of settledTasks) {
    const execsRes = await store.getExecutionsByTask(task.id);
    if (execsRes.isOk) {
      let taskCost = zeroCost();
      for (const exec of execsRes.value) {
        taskCost = addCosts(taskCost, exec.cost);
      }
      taskCosts.push(taskCost);
    }
  }
  const avgCost = averageCosts(taskCosts);

  // scoreOverTime: trust.score at each settled task, ascending by updatedAt.
  const scoreOverTime = [...settledTasks]
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    .map((t) => ({ at: t.updatedAt, score: t.trust.score }));

  return Ok({
    completedTasks,
    failedTasks,
    successRate,
    avgCost,
    avgDurationMs,
    scoreOverTime,
  });
};

/**
 * Stats for a single workflow: runs, success rate, cost, and per-phase durations.
 * Unknown workflow: returns zero-valued stats, not an error.
 *
 * Phases are derived from checkpoints with the phase field set. For each settled
 * run, phases are ordered by createdAt (oldest-first); the i-th phase's duration
 * is (createdAt[i] - createdAt[i-1]) where createdAt[-1] = task.createdAt.
 * If a phase repeats in one run (retry), each occurrence counts as a separate run.
 */
export const computeWorkflowStats = async ({
  store,
  workflow,
}: {
  store: StoragePort;
  workflow: string;
}): Promise<Result<WorkflowStats, string>> => {
  if (store.getTasksByWorkflow === undefined) {
    return Err("store does not support getTasksByWorkflow — required for workflowStats");
  }
  if (store.getCheckpointsByTask === undefined) {
    return Err("store does not support getCheckpointsByTask — required for workflowStats");
  }

  // An unknown workflow yields Ok([]) and produces zero-valued stats naturally;
  // an Err here is a genuine store failure and must surface, not read as zeros.
  const tasksRes = await store.getTasksByWorkflow(workflow);
  if (tasksRes.isErr) return Err(`workflowStats failed reading tasks for "${workflow}": ${tasksRes.error}`);

  const allTasks = tasksRes.value;
  const settledTasks = allTasks.filter((t) => isSettledStatus(t.status));

  const runs = settledTasks.length;
  const completed = settledTasks.filter((t) => t.status === "completed").length;
  const failed = settledTasks.filter((t) => t.status === "failed" || t.status === "aborted").length;
  const successRate = runs > 0 ? completed / runs : 0;
  const avgDurationMs = runs > 0
    ? Math.round(
      settledTasks.reduce((sum, t) => sum + (t.updatedAt.getTime() - t.createdAt.getTime()), 0) / runs,
    )
    : 0;

  // Compute avgCost similarly.
  const taskCosts: Cost[] = [];
  for (const task of settledTasks) {
    const execsRes = await store.getExecutionsByTask(task.id);
    if (execsRes.isOk) {
      let taskCost = zeroCost();
      for (const exec of execsRes.value) {
        taskCost = addCosts(taskCost, exec.cost);
      }
      taskCosts.push(taskCost);
    }
  }
  const avgCost = runs > 0 ? averageCosts(taskCosts) : { tokens: 0, durationMs: 0 };

  // Derive phases from checkpoints. Collect (phase, duration) pairs across all runs,
  // then aggregate by phase name.
  const phaseStats = new Map<string, { durationMs: number; runs: number }[]>();
  const phaseOrder: string[] = []; // Track first-seen order.

  for (const task of settledTasks) {
    const ckptsRes = await store.getCheckpointsByTask(task.id);
    if (ckptsRes.isErr) continue;

    const phaseCheckpoints = ckptsRes.value.filter((c): c is Checkpoint & { phase: string } => c.phase !== undefined);
    let prevTime = task.createdAt.getTime();
    for (const ckpt of phaseCheckpoints) {
      const durationMs = ckpt.createdAt.getTime() - prevTime;
      if (!phaseStats.has(ckpt.phase)) {
        phaseStats.set(ckpt.phase, []);
        phaseOrder.push(ckpt.phase);
      }
      phaseStats.get(ckpt.phase)!.push({ durationMs, runs: 1 });
      prevTime = ckpt.createdAt.getTime();
    }
  }

  // Aggregate: average duration per phase, sum runs.
  const phases = phaseOrder.map((phase) => {
    const stats = phaseStats.get(phase)!;
    const avgDurationMs = Math.round(
      stats.reduce((sum, s) => sum + s.durationMs, 0) / stats.length,
    );
    return { phase, avgDurationMs, runs: stats.length };
  });

  return Ok({
    runs,
    completed,
    failed,
    successRate,
    avgDurationMs,
    avgCost,
    phases,
  });
};
