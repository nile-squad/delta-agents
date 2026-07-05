import type { Action, Agent, DeltaEngine, Workflow } from "delta-agents";
import { Ok, Err } from "delta-agents";
import { z } from "zod";
import { findOrder, refundOrder, type Receipt } from "../services/orders-service";

export const ACTIONS = {
  lookupOrder: "lookup-order",
  issueRefund: "issue-refund",
  checkStock: "check-stock",
  shipOrder: "ship-order",
} as const;

export const AGENT_NAME = "support-agent";
export const WF_NAME = "order-fulfillment";

const buildLookupOrder = (delta: DeltaEngine): Action =>
  delta.action({
    name: ACTIONS.lookupOrder,
    description: "Look up an order by its ID — customer, item, amount, status",
    risk: 1,
    schema: z.object({ orderId: z.string() }),
    fn: async ({ orderId }) => {
      const order = findOrder(orderId as string);
      if (order === null) return Err(`order not found: ${orderId as string}`);
      return Ok(order);
    },
  });

const buildIssueRefund = (delta: DeltaEngine): Action =>
  delta.action({
    name: ACTIONS.issueRefund,
    description: "Issue a refund for an order. Moves real money — always requires human sign-off.",
    risk: 4,
    requiresApproval: true,
    schema: z.object({ orderId: z.string(), amount: z.number().positive(), reason: z.string() }),
    fn: async ({ orderId, amount, reason }) => {
      const receipt = refundOrder(orderId as string, amount as number);
      console.log(`  refunded $${amount as number} on ${orderId as string}: ${reason as string}`);
      return Ok(receipt);
    },
  });

const buildCheckStock = (delta: DeltaEngine): Action =>
  delta.action({
    name: ACTIONS.checkStock,
    description: "Check whether an item is in stock",
    risk: 1,
    schema: z.object({ itemId: z.string() }),
    fn: async ({ itemId }) => {
      const inStock = Math.random() > 0.3;
      console.log(`  stock check for ${itemId as string}: ${inStock ? "in stock" : "out of stock"}`);
      return Ok({ itemId, inStock });
    },
  });

const buildShipOrder = (delta: DeltaEngine): Action =>
  delta.action({
    name: ACTIONS.shipOrder,
    description: "Ship an order to the customer. Updates order status to shipped.",
    risk: 2,
    schema: z.object({ orderId: z.string(), carrier: z.string().optional() }),
    fn: async ({ orderId, carrier }) => {
      console.log(`  shipped ${orderId as string} via ${(carrier as string) ?? "standard"}`);
      return Ok({ orderId, carrier: carrier ?? "standard", shipped: true });
    },
  });

export const createSupportAgent = (delta: DeltaEngine): Agent => {
  const lookupOrder = buildLookupOrder(delta);
  const issueRefund = buildIssueRefund(delta);

  return delta.agent({
    name: AGENT_NAME,
    description: "Handles order support: order lookup and refund processing",
    role: "Order Support Specialist",
    rolePrompt: "Help customers resolve order issues. Start by looking up the order, then determine next steps.",
    actions: [lookupOrder, issueRefund],
  });
};

export const createFulfillmentWorkflow = (delta: DeltaEngine): Workflow =>
  delta.workflow({
    name: WF_NAME,
    description: "Fulfill an order: check stock, ship, confirm",
    version: "1.0.0",
    phases: [
      {
        name: "check",
        description: "Verify stock availability",
        actions: [ACTIONS.checkStock],
        checkpoint: true,
      },
      {
        name: "ship",
        description: "Ship the order to the customer",
        actions: [
          { action: ACTIONS.checkStock, onSuccess: "ship" },
          { action: ACTIONS.shipOrder },
        ],
        checkpoint: true,
      },
    ],
  });

export const createFulfillmentAgent = (delta: DeltaEngine): Agent => {
  const checkStock = buildCheckStock(delta);
  const shipOrder = buildShipOrder(delta);
  const fulfillmentWorkflow = createFulfillmentWorkflow(delta);

  return delta.agent({
    name: "fulfillment-agent",
    description: "Fulfills orders: checks stock and ships items",
    role: "Fulfillment Specialist",
    rolePrompt: "Process orders through the fulfillment workflow — check stock, then ship.",
    actions: [checkStock, shipOrder],
    workflows: [fulfillmentWorkflow],
  });
};
