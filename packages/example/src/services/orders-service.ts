export type Order = {
  id: string;
  customer: string;
  item: string;
  amount: number;
  status: "placed" | "shipped" | "delivered" | "refunded";
};

export type Receipt = {
  receiptId: string;
  orderId: string;
  amount: number;
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

export const findOrder = (orderId: string): Order | null => orders.get(orderId) ?? null;

export const refundOrder = (orderId: string, amount: number): Receipt => {
  const order = orders.get(orderId);
  if (order !== undefined) {
    orders.set(orderId, { ...order, status: "refunded" });
  }
  return { receiptId: `RCPT-${orderId}`, orderId, amount };
};
