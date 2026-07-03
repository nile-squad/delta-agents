/**
 * Contextual action discovery — pure function.
 *
 * Returns only the actions that are legal in the current task state.
 * The reasoner port receives exactly this list. Actions outside it do not
 * exist from the reasoner's perspective (spec §Decision: Contextual Action
 * Discovery, prohibition 3).
 *
 * Discovery is the primary mechanism that reduces hallucination and invalid
 * action requests: a model cannot request what it cannot see.
 *
 * The discovery result is a snapshot — it is valid at the moment it is taken
 * and must be re-derived after any state change (completed action, checkpoint,
 * budget update, escalation). The engine never caches discovery results across
 * state transitions.
 */

import type { Action } from "../authoring/types";
import type { TaskStateSnapshot } from "./types";
import { checkLegality } from "./check-legality";

export type DiscoveryResult = {
  // Actions currently legal and discoverable.
  available: Action[];
  // Actions in the agent's set that are currently illegal, with reasons.
  // Included for diagnostics and oversight — never sent to the reasoner.
  blocked: Array<{ action: Action; reason: string }>;
};

/**
 * Discover which of the agent's actions are legal in the current state.
 *
 * @param agentActions - The full set of actions registered for this agent.
 * @param state        - Current task state snapshot.
 */
export const discoverActions = ({
  agentActions,
  state,
}: {
  agentActions: Action[];
  state: TaskStateSnapshot;
}): DiscoveryResult => {
  const available: Action[] = [];
  const blocked: Array<{ action: Action; reason: string }> = [];

  for (const action of agentActions) {
    const result = checkLegality({ action, state });
    if (result.legal) {
      available.push(action);
    } else {
      blocked.push({ action, reason: result.reason });
    }
  }

  return { available, blocked };
};
