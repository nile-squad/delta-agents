/**
 * Per-agent loop detection + tool budget enforcement.
 *
 * Tools are stateless utilities the reasoner can call repeatedly, so they need
 * rate limits (cooldowns, per-phase / per-task caps) and a hard spend budget
 * to prevent infinite loops and runaway cost. The LoopDetector tracks this
 * state per agentName for the lifetime of one scheduler run; it is created
 * fresh per `runScheduler` call (loop detection is about within-run loops,
 * not cross-run).
 *
 * Design choices:
 * - O(1) per-operation lookups via Maps. Counters and timestamps live on a
 *   single tracker per agent, not a global flat map.
 * - Phase and task scopes tracked separately: `phaseToolCounts` resets when
 *   the current workflow phase changes; `taskToolCounts` survives phases but
 *   resets when the task settles. This lets a tool be capped per phase
 *   (common case: "5 searches per phase") and per task (rare, hard ceiling).
 * - `toolSpend` accumulates the cost of every successful tool call. The
 *   budget check compares the would-be cumulative (previous + this call's
 *   cost) against the declared budget, so a blocked call never adds to spend.
 * - All block reasons are humanized — the model sees them in the next
 *   `reason()` call and is expected to choose a different approach.
 *   Cooldowns / caps are not silently enforced: the model needs to know why
 *   the call was refused so it can adapt.
 */

import { createLogger } from "../shared/logger";
import type { Cost } from "../shared/types";
import { addCosts, isOverBudget } from "../shared/cost";

const log = createLogger("loop-detector");

/** Per-agent live state for loop detection and budget tracking. */
type AgentActivityTracker = {
  lastToolCall?: { name: string; timestamp: number };
  lastActionCall?: { name: string; timestamp: number };
  /** Tool call counts that reset on each phase change. */
  phaseToolCounts: Map<string, number>;
  /** Tool call counts that reset only when the task settles. */
  taskToolCounts: Map<string, number>;
  /** Cumulative cost per tool, accumulated over the task (budget scope). */
  toolSpend: Map<string, Cost>;
};

export type LoopDetector = {
  /**
   * Check if calling `toolName` would violate a cooldown. Returns a humanized
   * block reason when the same tool was called too recently, undefined when
   * the call is allowed. The reasoner surfaces the reason on its next turn.
   */
  checkToolCooldown: (agentName: string, toolName: string, cooldownMs: number) => string | undefined;
  /**
   * Check if calling `toolName` would exceed a max-calls limit. `scope` selects
   * which counter to inspect ("phase" or "task"). Returns a humanized block
   * reason when at the limit, undefined when allowed.
   */
  checkMaxCalls: (agentName: string, toolName: string, maxCalls: number, scope: "phase" | "task") => string | undefined;
  /**
   * Check if adding `cost` to the cumulative spend would exceed the tool's
   * declared budget. Returns a humanized block reason when over budget,
   * undefined when within. A blocked call does NOT add to spend (caller is
   * expected to skip `recordToolSpend` on the same call).
   */
  checkBudget: (agentName: string, toolName: string, cost: Cost, budget: Cost) => string | undefined;
  /** Record a tool call: stamps the last-call timestamp and bumps counters. */
  recordToolCall: (agentName: string, toolName: string) => void;
  /** Add `cost` to the per-tool cumulative spend (only when the call proceeds). */
  recordToolSpend: (agentName: string, toolName: string, cost: Cost) => void;
  /** Reset per-phase counters for the agent (called on phase change). */
  resetPhase: (agentName: string) => void;
  /** Reset every counter + spend for the agent (called on task settle). */
  resetTask: (agentName: string) => void;
};

/** Lazily build a tracker for an agent on first access. */
const trackerFor = (
  trackers: Map<string, AgentActivityTracker>,
  agentName: string,
): AgentActivityTracker => {
  const existing = trackers.get(agentName);
  if (existing !== undefined) return existing;
  const created: AgentActivityTracker = {
    phaseToolCounts: new Map(),
    taskToolCounts: new Map(),
    toolSpend: new Map(),
  };
  trackers.set(agentName, created);
  return created;
};

/**
 * Build a fresh per-run loop detector. Maps are owned by the closure so the
 * detector carries no other state — pass it through the scheduler and let
 * the GC reclaim it when the run ends.
 */
export const createLoopDetector = (): LoopDetector => {
  const trackers = new Map<string, AgentActivityTracker>();

  return {
    checkToolCooldown: (agentName, toolName, cooldownMs) => {
      const tracker = trackerFor(trackers, agentName);
      const last = tracker.lastToolCall;
      if (last === undefined || last.name !== toolName) return undefined;
      const now = Date.now();
      if (now - last.timestamp < cooldownMs) {
        const reason = "This tool was just called. Wait for it to finish before calling again.";
        log.warn("tool call blocked: cooldown active", { action: toolName });
        return reason;
      }
      return undefined;
    },

    checkMaxCalls: (agentName, toolName, maxCalls, scope) => {
      const tracker = trackerFor(trackers, agentName);
      const counts = scope === "phase" ? tracker.phaseToolCounts : tracker.taskToolCounts;
      const current = counts.get(toolName) ?? 0;
      if (current >= maxCalls) {
        const reason = `This tool has been called the maximum number of times (${maxCalls}) for this ${scope}.`;
        log.warn(`tool call blocked: max calls per ${scope} reached`, { action: toolName });
        return reason;
      }
      return undefined;
    },

    checkBudget: (agentName, toolName, cost, budget) => {
      const tracker = trackerFor(trackers, agentName);
      const previous = tracker.toolSpend.get(toolName);
      // would-be cumulative: previous spend + this call's cost
      const wouldBe = previous === undefined ? cost : addCosts(previous, cost);
      if (isOverBudget(wouldBe, budget)) {
        const reason = "This tool's budget is exhausted. Try a different approach.";
        log.warn("tool call blocked: budget exhausted", { action: toolName });
        return reason;
      }
      return undefined;
    },

    recordToolCall: (agentName, toolName) => {
      const tracker = trackerFor(trackers, agentName);
      tracker.lastToolCall = { name: toolName, timestamp: Date.now() };
      tracker.phaseToolCounts.set(toolName, (tracker.phaseToolCounts.get(toolName) ?? 0) + 1);
      tracker.taskToolCounts.set(toolName, (tracker.taskToolCounts.get(toolName) ?? 0) + 1);
    },

    recordToolSpend: (agentName, toolName, cost) => {
      const tracker = trackerFor(trackers, agentName);
      const previous = tracker.toolSpend.get(toolName);
      const next = previous === undefined ? cost : addCosts(previous, cost);
      tracker.toolSpend.set(toolName, next);
    },

    resetPhase: (agentName) => {
      const tracker = trackerFor(trackers, agentName);
      tracker.phaseToolCounts.clear();
    },

    resetTask: (agentName) => {
      const tracker = trackerFor(trackers, agentName);
      tracker.phaseToolCounts.clear();
      tracker.taskToolCounts.clear();
      tracker.toolSpend.clear();
      tracker.lastToolCall = undefined;
      tracker.lastActionCall = undefined;
    },
  };
};
