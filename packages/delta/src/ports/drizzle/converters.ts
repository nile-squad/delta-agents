// ── Row → domain type converters ──────────────────────────────────────────────

import type {
  Task,
  TaskTree,
  Execution,
  Checkpoint,
  ApprovalRequest,
  EscalationRecord,
  EscalationTrigger,
  Message,
  Memory,
  Commit,
  Queue,
  Cost,
  RiskState,
  TrustState,
  Json,
  JsonRecord,
  ExecutionStatus,
} from "../../shared/types";
import {
  tasks,
  taskTrees,
  executions,
  checkpoints,
  approvalRequests,
  escalations,
  messages,
  memories,
  commits,
  queues,
} from "../../../db/models/schema";

export const toTask = (r: typeof tasks.$inferSelect): Task => ({
  id:            r.id,
  rootId:        r.rootId,
  parentId:      r.parentId ?? undefined,
  status:        r.status as ExecutionStatus,
  goal:          r.goal,
  assignedAgent: r.assignedAgent,
  workflow:      r.workflow ?? undefined,
  currentPhase:  r.currentPhase ?? undefined,
  budget:        JSON.parse(r.budget) as Cost,
  risk:          JSON.parse(r.risk) as RiskState,
  trust:         JSON.parse(r.trust) as TrustState,
  createdAt:     new Date(r.createdAt),
  updatedAt:     new Date(r.updatedAt),
});

export const toTaskTree = (r: typeof taskTrees.$inferSelect): TaskTree => ({
  rootTaskId:     r.rootTaskId,
  activeChildren: JSON.parse(r.activeChildren) as string[],
  queuedChildren: JSON.parse(r.queuedChildren) as string[],
  maxConcurrency: 2,
});

export const toExecution = (r: typeof executions.$inferSelect): Execution => ({
  id:        r.id,
  taskId:    r.taskId,
  action:    r.action,
  startedAt: new Date(r.startedAt),
  endedAt:   r.endedAt !== null && r.endedAt !== undefined ? new Date(r.endedAt) : undefined,
  status:    r.status as ExecutionStatus,
  cost:      JSON.parse(r.cost) as Cost,
});

export const toCheckpoint = (r: typeof checkpoints.$inferSelect): Checkpoint => ({
  id:        r.id,
  taskId:    r.taskId,
  phase:     r.phase ?? undefined,
  state:     JSON.parse(r.state) as JsonRecord,
  createdAt: new Date(r.createdAt),
});

export const toApprovalRequest = (r: typeof approvalRequests.$inferSelect): ApprovalRequest => ({
  id:        r.id,
  taskId:    r.taskId,
  action:    r.action,
  reason:    r.reason,
  status:    r.status as ApprovalRequest["status"],
  ...(r.rejectionReason !== null && r.rejectionReason !== undefined ? { rejectionReason: r.rejectionReason } : {}),
  createdAt: new Date(r.createdAt),
});

export const toEscalationRecord = (r: typeof escalations.$inferSelect): EscalationRecord => ({
  id:        r.id,
  taskId:    r.taskId,
  trigger:   r.trigger as EscalationTrigger,
  reason:    r.reason,
  createdAt: new Date(r.createdAt),
});

export const toMessage = (r: typeof messages.$inferSelect): Message => ({
  id:        r.id,
  taskId:    r.taskId,
  sender:    r.sender,
  receiver:  r.receiver,
  payload:   JSON.parse(r.payload) as Json,
  createdAt: new Date(r.createdAt),
  consumed:  r.consumed === 1,
  ...(r.deliveredAt !== null && r.deliveredAt !== undefined ? { deliveredAt: new Date(r.deliveredAt) } : {}),
  ...(r.readAt !== null && r.readAt !== undefined ? { readAt: new Date(r.readAt) } : {}),
  ...(r.recalledAt !== null && r.recalledAt !== undefined ? { recalledAt: new Date(r.recalledAt) } : {}),
});

export const toQueue = (r: typeof queues.$inferSelect): Queue => ({
  id:        r.id,
  taskId:    r.taskId,
  pending:   JSON.parse(r.pending) as string[],
  active:    JSON.parse(r.active) as string[],
  completed: JSON.parse(r.completed) as string[],
});

export const toMemory = (r: typeof memories.$inferSelect): Memory => ({
  id:        r.id,
  taskId:    r.taskId,
  agentName: r.agentName,
  kind:      r.kind,
  content:   r.content,
  createdAt: new Date(r.createdAt),
});

export const toCommit = (r: typeof commits.$inferSelect): Commit => ({
  id:           r.id,
  taskId:       r.taskId,
  agentName:    r.agentName,
  workflowName: r.workflowName,
  notes:        r.notes,
  checkpointId: r.checkpointId,
  createdAt:    new Date(r.createdAt),
});
