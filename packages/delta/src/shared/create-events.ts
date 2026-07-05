export type DeltaEventPayloads = {
  // Engine lifecycle (scheduler ticks)
  "step-start": { taskId: string; step: number };
  "step-end": { taskId: string; step: number; kind: string };
  // Action execution
  "action-start": { action: string; taskId: string; executionId: string };
  "action-end": { action: string; taskId: string; executionId: string; status: string; durationMs: number };
  // Commit step
  "commit-step-attempt": { taskId: string; attempt: number; workflowName: string };
  "commit-step-done": { taskId: string; workflowName: string; hasNotes: boolean };
  "commit-step-auto-commit": { taskId: string; workflowName: string };
  // Human oversight
  "approval-requested": { taskId: string; action: string; approvalId: string; reason: string };
  "approval-resolved": { taskId: string; action: string; approvalId: string; decision: "approved" | "rejected" };
  "escalation-raised": { taskId: string; trigger: string; reason: string };
  // Task lifecycle
  "task-completed": { taskId: string; agentName: string; goal: string };
  "task-blocked": { taskId: string; agentName: string; reason: string };
  "task-failed": { taskId: string; agentName: string; reason: string };
};

export type DeltaEventName = keyof DeltaEventPayloads;

export type DeltaEvents = {
  on: <E extends DeltaEventName>(event: E, handler: (data: DeltaEventPayloads[E]) => void) => () => void;
  off: <E extends DeltaEventName>(event: E, handler: (data: DeltaEventPayloads[E]) => void) => void;
};

export type DeltaEventsInternal = DeltaEvents & {
  emit: <E extends DeltaEventName>(event: E, data: DeltaEventPayloads[E]) => void;
};

export const createEvents = (): DeltaEventsInternal => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();

  const on = <E extends DeltaEventName>(event: E, handler: (data: DeltaEventPayloads[E]) => void): (() => void) => {
    let set = handlers.get(event);
    if (set === undefined) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as (data: unknown) => void);
    return () => { set!.delete(handler as (data: unknown) => void); };
  };

  const off = <E extends DeltaEventName>(event: E, handler: (data: DeltaEventPayloads[E]) => void): void => {
    handlers.get(event)?.delete(handler as (data: unknown) => void);
  };

  const emit = <E extends DeltaEventName>(event: E, data: DeltaEventPayloads[E]): void => {
    handlers.get(event)?.forEach((h) => h(data));
  };

  return { on, off, emit };
};
