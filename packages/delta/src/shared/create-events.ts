export type DeltaEventPayloads = {
  // Engine lifecycle (scheduler ticks)
  "step-start": { taskId: string; agentName: string; step: number };
  "step-end": { taskId: string; agentName: string; step: number; kind: string };
  // Action execution
  "action-start": { action: string; agentName: string; taskId: string; executionId: string };
  "action-end": { action: string; agentName: string; taskId: string; executionId: string; status: string; durationMs: number };
  // Commit step
  "commit-step-attempt": { taskId: string; agentName: string; attempt: number; workflowName: string };
  "commit-step-done": { taskId: string; agentName: string; workflowName: string; hasNotes: boolean };
  "commit-step-auto-commit": { taskId: string; agentName: string; workflowName: string };
  // Human oversight
  "approval-requested": { taskId: string; agentName: string; action: string; approvalId: string; reason: string };
  "approval-resolved": { taskId: string; agentName: string; action: string; approvalId: string; decision: "approved" | "rejected" };
  "escalation-raised": { taskId: string; agentName: string; trigger: string; reason: string };
  // Task lifecycle
  "task-completed": { taskId: string; agentName: string; goal: string };
  "task-blocked": { taskId: string; agentName: string; reason: string };
  "task-failed": { taskId: string; agentName: string; reason: string };
};

export type DeltaEventName = keyof DeltaEventPayloads;

/**
 * Common envelope stamped onto every delivered event.
 *
 * WHY: every event that reaches a subscriber must be timestamped so an audit
 * log or a live UI feed can order and age events without each emission site
 * remembering to attach the time. `emit` stamps `Date.now()` once, centrally,
 * so the guarantee holds uniformly — including for events bridged in from the
 * diagnostics system, which never construct the envelope themselves.
 */
export type DeltaEventEnvelope = { timestamp: number };

/** What a subscriber actually receives: the declared payload plus the envelope. */
export type DeltaEventDelivered<E extends DeltaEventName> = DeltaEventPayloads[E] & DeltaEventEnvelope;

export type DeltaEvents = {
  on: <E extends DeltaEventName>(event: E, handler: (data: DeltaEventDelivered<E>) => void) => () => void;
  off: <E extends DeltaEventName>(event: E, handler: (data: DeltaEventDelivered<E>) => void) => void;
};

export type DeltaEventsInternal = DeltaEvents & {
  // Callers emit the BARE payload; `emit` adds the timestamp before delivery.
  emit: <E extends DeltaEventName>(event: E, data: DeltaEventPayloads[E]) => void;
};

export const createEvents = (): DeltaEventsInternal => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();

  const on = <E extends DeltaEventName>(event: E, handler: (data: DeltaEventDelivered<E>) => void): (() => void) => {
    let set = handlers.get(event);
    if (set === undefined) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as (data: unknown) => void);
    return () => { set!.delete(handler as (data: unknown) => void); };
  };

  const off = <E extends DeltaEventName>(event: E, handler: (data: DeltaEventDelivered<E>) => void): void => {
    handlers.get(event)?.delete(handler as (data: unknown) => void);
  };

  const emit = <E extends DeltaEventName>(event: E, data: DeltaEventPayloads[E]): void => {
    // Stamp the envelope once, centrally: every delivered event carries a
    // timestamp without any callsite (or the diagnostics bridge) doing it.
    const enveloped: DeltaEventDelivered<E> = { ...data, timestamp: Date.now() };
    handlers.get(event)?.forEach((h) => h(enveloped));
  };

  return { on, off, emit };
};
