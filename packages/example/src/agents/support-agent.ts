/**
 * Support agent — the delta-agents domain logic for this example.
 *
 * Two governed actions:
 *   - "lookup-order": read-only, low risk, no approval needed.
 *   - "issue-refund": moves money, high risk, `requiresApproval: true`. The
 *     engine's execution gateway will not run it until a human calls
 *     `delta.approve(approvalId)` — this is the whole point of delta-agents:
 *     the model can *propose* a refund, only the engine (gated by a human)
 *     can actually authorize it.
 *
 * Both actions are plain `delta.action()` definitions; the agent just lists
 * them. All delta-agents wiring lives here so `src/index.ts` stays a thin
 * entrypoint.
 */

import type { Action, Agent, DeltaEngine } from "delta-agents";
import { Ok, Err } from "delta-agents";
import { z } from "zod";
import { findOrder, refundOrder } from "../services/orders-service";

export const ACTION_NAMES = {
  lookupOrder: "lookup-order",
  issueRefund: "issue-refund",
} as const;

export const AGENT_NAME = "support-agent";

const buildLookupOrder = (delta: DeltaEngine): Action =>
  delta.action({
    name: ACTION_NAMES.lookupOrder,
    description: "Look up an order by its id",
    risk: 1,
    schema: z.object({ orderId: z.string() }),
    fn: async ({ orderId }) => {
      const order = findOrder(orderId as string);
      if (order === null) return Err(`no order found with id "${orderId as string}"`);
      console.log(`  [lookup-order] found ${order.id} — ${order.item} ($${order.amount}) for ${order.customer}`);
      return Ok(order);
    },
  });

const buildIssueRefund = (delta: DeltaEngine): Action =>
  delta.action({
    name: ACTION_NAMES.issueRefund,
    description: "Issue a refund for an order. Moves real money — always requires human sign-off.",
    risk: 4,
    requiresApproval: true,
    schema: z.object({
      orderId: z.string(),
      amount: z.number().positive(),
      reason: z.string(),
    }),
    fn: async ({ orderId, amount, reason }) => {
      const receipt = refundOrder(orderId as string, amount as number);
      console.log(`  [issue-refund] refunded $${amount as number} on ${orderId as string} (reason: ${reason as string})`);
      return Ok(receipt);
    },
  });

/** Define and return the support agent, wired to the given engine instance. */
export const createSupportAgent = (delta: DeltaEngine): Agent => {
  const lookupOrder = buildLookupOrder(delta);
  const issueRefund = buildIssueRefund(delta);

  return delta.agent({
    name: AGENT_NAME,
    description: "Handles order support requests: looks up orders and processes refunds",
    role: "Order Support Specialist",
    rolePrompt:
      "Help customers resolve order issues. Look up the order first, then decide whether a refund is warranted.",
    actions: [lookupOrder, issueRefund],
  });
};
