import { describe, it, expect } from "vitest";
import { createFifoQueue } from "../../../src/infra";

describe("FifoQueue", () => {
  it("starts empty", () => {
    const q = createFifoQueue<number>();
    expect(q.isEmpty()).toBe(true);
    expect(q.size()).toBe(0);
  });

  it("enqueues and dequeues in FIFO order", () => {
    const q = createFifoQueue<string>();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    expect(q.dequeue()).toBe("a");
    expect(q.dequeue()).toBe("b");
    expect(q.dequeue()).toBe("c");
  });

  it("peek returns the front item without removing it", () => {
    const q = createFifoQueue<number>();
    q.enqueue(10);
    q.enqueue(20);
    expect(q.peek()).toBe(10);
    expect(q.size()).toBe(2); // unchanged
    expect(q.peek()).toBe(10); // still 10
  });

  it("peek on empty queue returns undefined", () => {
    const q = createFifoQueue<number>();
    expect(q.peek()).toBeUndefined();
  });

  it("dequeue on empty queue returns undefined", () => {
    const q = createFifoQueue<number>();
    expect(q.dequeue()).toBeUndefined();
  });

  it("isEmpty becomes false after enqueue and true after all items are removed", () => {
    const q = createFifoQueue<string>();
    q.enqueue("x");
    expect(q.isEmpty()).toBe(false);
    q.dequeue();
    expect(q.isEmpty()).toBe(true);
  });

  it("size tracks enqueue and dequeue correctly", () => {
    const q = createFifoQueue<number>();
    q.enqueue(1);
    q.enqueue(2);
    expect(q.size()).toBe(2);
    q.dequeue();
    expect(q.size()).toBe(1);
    q.dequeue();
    expect(q.size()).toBe(0);
  });

  it("toArray returns items in queue order", () => {
    const q = createFifoQueue<string>();
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");
    expect(q.toArray()).toEqual(["first", "second", "third"]);
  });

  it("toArray returns a copy — mutations do not affect the queue", () => {
    const q = createFifoQueue<string>();
    q.enqueue("item");
    const snapshot = q.toArray();
    snapshot.push("injected");
    // Queue itself must not change
    expect(q.size()).toBe(1);
    expect(q.toArray()).toEqual(["item"]);
  });

  it("large insertion order is preserved (100 items)", () => {
    const q = createFifoQueue<number>();
    const items = Array.from({ length: 100 }, (_, i) => i);
    items.forEach((n) => q.enqueue(n));
    const dequeued: number[] = [];
    while (!q.isEmpty()) {
      const item = q.dequeue();
      if (item !== undefined) dequeued.push(item);
    }
    expect(dequeued).toEqual(items);
  });

  it("works with object items", () => {
    const q = createFifoQueue<{ id: string; value: number }>();
    q.enqueue({ id: "a", value: 1 });
    q.enqueue({ id: "b", value: 2 });
    expect(q.dequeue()).toEqual({ id: "a", value: 1 });
    expect(q.dequeue()).toEqual({ id: "b", value: 2 });
  });
});
