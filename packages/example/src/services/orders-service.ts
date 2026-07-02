/**
 * Orders "backend" for the support-agent example.
 *
 * A tiny in-memory store standing in for a real orders database or API. Kept
 * deliberately separate from the delta-agents wiring in `src/agents/` so it
 * reads like a normal domain module a real backend would already have —
 * delta-agents governs *access* to it, it doesn't replace it.
 */

export type Order = {
  id: string;
  customer: string;
  item: string;
  amount: number;
  status: "placed" | "shipped" | "delivered" | "refunded";
};

const orders = new Map<string, Order>([
  [
    "ORD-1042",
    {
      id: "ORD-1042",
      customer: "Amara Chen",
      item: "Wireless Keyboard",
      amount: 49.99,
      status: "delivered",
    },
  ],
  [
    "ORD-2091",
    {
      id: "ORD-2091",
      customer: "Tunde Bakare",
      item: "Noise-Cancelling Headphones",
      amount: 129.5,
      status: "shipped",
    },
  ],
]);

/** Look up an order by id. Returns null when it doesn't exist — the caller
 * (the action fn) is responsible for turning that into a governed Result. */
export const findOrder = (orderId: string): Order | null => orders.get(orderId) ?? null;

/** Mark an order refunded and return a mock receipt. Throws never — the
 * "not found" case is checked by the caller before this runs. */
export const refundOrder = (orderId: string, amount: number): { receiptId: string; orderId: string; amount: number } => {
  const order = orders.get(orderId);
  if (order !== undefined) {
    orders.set(orderId, { ...order, status: "refunded" });
  }
  return { receiptId: `RCPT-${orderId}`, orderId, amount };
};
