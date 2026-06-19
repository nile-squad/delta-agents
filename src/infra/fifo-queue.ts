/**
 * Generic FIFO queue.
 *
 * FIFO ordering is required by the spec for all pending work: tasks, subtasks,
 * messages, escalations (spec §Queueing Model). Deterministic order enables
 * audit replay and prevents priority inversion under load.
 *
 * Array-backed with O(n) dequeue. Acceptable for supervision-bounded concurrency
 * (max 2 active subtasks + bounded queue depth). Replace with a linked-list
 * implementation if profiling reveals queue pressure.
 */

export type FifoQueue<T> = {
  /** Add an item to the back of the queue. */
  enqueue: (item: T) => void;
  /** Remove and return the front item, or undefined if empty. */
  dequeue: () => T | undefined;
  /** Return the front item without removing it, or undefined if empty. */
  peek: () => T | undefined;
  /** Number of items currently in the queue. */
  size: () => number;
  /** True when the queue contains no items. */
  isEmpty: () => boolean;
  /** Snapshot of all items in queue order. Mutations to the returned array do not affect the queue. */
  toArray: () => T[];
};

export const createFifoQueue = <T>(): FifoQueue<T> => {
  const items: T[] = [];

  return {
    enqueue: (item) => { items.push(item); },
    dequeue: () => items.shift(),
    peek: () => items[0],
    size: () => items.length,
    isEmpty: () => items.length === 0,
    toArray: () => [...items],
  };
};
