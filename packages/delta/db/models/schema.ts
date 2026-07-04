/**
 * Drizzle ORM table definitions for delta-agents runtime state.
 *
 * Every runtime entity (task, execution, checkpoint, approval, escalation,
 * message, queue) is defined here. All database code lives in db/models per
 * the project's architecture rule. The drizzle-store adapter imports these
 * definitions to build type-safe queries.
 *
 * JSON columns store complex nested objects as TEXT (JSON.stringify/parse
 * happens in the store layer). Timestamps are stored as INTEGER (ms epoch)
 * for full millisecond precision and straightforward conversion.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── Tasks ──────────────────────────────────────────────────────────────────────

export const tasks = sqliteTable("tasks", {
  id:            text("id").primaryKey(),
  rootId:        text("root_id").notNull(),
  parentId:      text("parent_id"),
  status:        text("status").notNull(),
  goal:          text("goal").notNull(),
  assignedAgent: text("assigned_agent").notNull(),
  workflow:      text("workflow"),
  currentPhase:  text("current_phase"),
  budget:        text("budget").notNull(),     // JSON: Cost
  risk:          text("risk").notNull(),       // JSON: RiskState
  trust:         text("trust").notNull(),      // JSON: TrustState
  createdAt:     integer("created_at").notNull(), // ms epoch
  updatedAt:     integer("updated_at").notNull(), // ms epoch
});

// ── Task Trees ─────────────────────────────────────────────────────────────────

export const taskTrees = sqliteTable("task_trees", {
  rootTaskId:      text("root_task_id").primaryKey(),
  activeChildren:  text("active_children").notNull(),  // JSON: string[]
  queuedChildren:  text("queued_children").notNull(),  // JSON: string[]
  maxConcurrency:  integer("max_concurrency").notNull(),
});

// ── Executions ─────────────────────────────────────────────────────────────────

export const executions = sqliteTable("executions", {
  id:        text("id").primaryKey(),
  taskId:    text("task_id").notNull(),
  action:    text("action").notNull(),
  startedAt: integer("started_at").notNull(), // ms epoch
  endedAt:   integer("ended_at"),             // ms epoch, nullable
  status:    text("status").notNull(),
  cost:      text("cost").notNull(),          // JSON: Cost
});

// ── Checkpoints ────────────────────────────────────────────────────────────────

export const checkpoints = sqliteTable("checkpoints", {
  id:        text("id").primaryKey(),
  taskId:    text("task_id").notNull(),
  phase:     text("phase"),
  state:     text("state").notNull(),         // JSON: JsonRecord
  createdAt: integer("created_at").notNull(), // ms epoch
});

// ── Approval Requests ──────────────────────────────────────────────────────────

export const approvalRequests = sqliteTable("approval_requests", {
  id:              text("id").primaryKey(),
  taskId:          text("task_id").notNull(),
  action:          text("action").notNull(),
  reason:          text("reason").notNull(),
  status:          text("status").notNull(),
  rejectionReason: text("rejection_reason"), // reviewer's stated reason, set on rejection
  createdAt:       integer("created_at").notNull(), // ms epoch
});

// ── Escalations ────────────────────────────────────────────────────────────────

export const escalations = sqliteTable("escalations", {
  id:        text("id").primaryKey(),
  taskId:    text("task_id").notNull(),
  trigger:   text("trigger").notNull(),
  reason:    text("reason").notNull(),
  createdAt: integer("created_at").notNull(), // ms epoch
});

// ── Messages ───────────────────────────────────────────────────────────────────

export const messages = sqliteTable("messages", {
  id:        text("id").primaryKey(),
  taskId:    text("task_id").notNull(),
  sender:    text("sender").notNull(),
  receiver:  text("receiver").notNull(),
  payload:   text("payload").notNull(),       // JSON: Json
  createdAt: integer("created_at").notNull(), // ms epoch
  consumed:    integer("consumed").notNull().default(0), // 0/1: mention delivered to receiver
  deliveredAt: integer("delivered_at"),                  // ms epoch, null until surfaced
  readAt:      integer("read_at"),                        // ms epoch, null until read (the receipt)
  recalledAt:  integer("recalled_at"),                    // ms epoch, null unless sender unsent it
});

// ── Memories ───────────────────────────────────────────────────────────────────

export const memories = sqliteTable("memories", {
  id:        text("id").primaryKey(),
  taskId:    text("task_id").notNull(),
  agentName: text("agent_name").notNull(),
  kind:      text("kind").notNull(),
  content:   text("content").notNull(),
  createdAt: integer("created_at").notNull(), // ms epoch
});

// ── Commits ────────────────────────────────────────────────────────────────────

export const commits = sqliteTable("commits", {
  id:           text("id").primaryKey(),
  taskId:       text("task_id").notNull(),
  agentName:    text("agent_name").notNull(),
  workflowName: text("workflow_name"),
  notes:        text("notes"),
  checkpointId: text("checkpoint_id"),
  createdAt:    integer("created_at").notNull(), // ms epoch
});

// ── Queues ─────────────────────────────────────────────────────────────────────

export const queues = sqliteTable("queues", {
  id:        text("id").primaryKey(),
  taskId:    text("task_id").notNull(),
  pending:   text("pending").notNull(),   // JSON: string[]
  active:    text("active").notNull(),    // JSON: string[]
  completed: text("completed").notNull(), // JSON: string[]
});
