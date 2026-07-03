# Delegation and Teams

An agent can hand off a scoped piece of work to another agent. Delegation exists to reduce complexity for a single agent; the engine keeps it from creating a new kind of complexity of its own.

## Teams

An agent optionally belongs to a team via `agent.team`. Teams scope collaboration: an agent may only delegate work to, or mention, an agent that shares its team. An agent with no team treats every other agent as an available peer; teams are opt-in, not required.

```ts
const researcher = delta.agent({ name: "researcher", role: "Researcher", team: "support" /* ... */ });
const writer = delta.agent({ name: "writer", role: "Writer", team: "support" /* ... */ });
```

A delegation or mention that targets an agent outside the team is rejected by the engine itself, not just hidden from the model.

## Delegate

Delegating creates a bounded child task that the teammate owns. The child task carries its own budget, risk, and trust state, scoped to the parent's remaining headroom: a child's budget is clamped to what the parent has left, and the amount granted is reserved from the parent immediately so two concurrent children cannot together be granted more than the parent has.

## Mention

A mention leaves a teammate a note without handing off work. It records a message attributed to the sending task, without spawning a child task. The note reaches the recipient's reasoning context the next time that agent runs, exactly once.

## Team Roster

Agents route work better when they know who is free and who is buried — the same intuition a person has walking into a shared workspace. The **roster** gives every agent that awareness: for each teammate, what they're currently working on and how loaded they are.

Load is reported against the concurrency model — one major task, up to two active subtasks, and an unbounded queue. A teammate is flagged **overloaded** when every slot is taken or a backlog has built up. The roster is folded into an agent's reasoning context automatically (scoped to its teammates), so delegations and mentions naturally flow toward idle teammates and away from overloaded ones.

The roster is derived from live task state, never stored, so it is always accurate. Developers can read it directly:

```ts
const everyone = await delta.roster();
const supportTeam = await delta.roster({ team: "support" });
// → [{ agent, status: "idle" | "busy", doing, load: { major, subtasks, queued, capacity, overloaded } }, ...]
```

## Mailbox: inbox, outbox, receipts, recall

Every agent has a durable inbox (messages addressed to it) and outbox (messages it sent). Delivery is **turn-only**: a message never interrupts a running task — it waits until the recipient's next turn reads it. That keeps an agent's focus intact while still guaranteeing the message lands.

- **Read receipts** are visible on both sides. When the recipient reads a message, the send is stamped with a read time that the sender can see on its outbox — you can tell whether, and when, a message was read.
- **Recall (unsend)** works while a message is still unread. Because delivery is turn-only, a sender has a clean window to retract a note before the recipient's next turn reads it; once read, recall is refused.
- **Bounded inboxes**: set `mailbox.inboxCap` to cap an inbox. When it's exceeded, the oldest **read** messages are evicted first — unread messages are never dropped.

```ts
const delta = await createDeltaEngine({ mailbox: { inboxCap: 100 } });
const mine = await delta.inbox({ agent: "writer" });   // unread first, recalled excluded
const sent = await delta.outbox({ agent: "researcher" }); // newest first, with read receipts
await delta.recall({ messageId });                        // Err if already read
```

## Bounded Concurrency

Delegation is structurally bounded, not just discouraged:

- A task may have at most two active delegated child tasks at a time. Additional delegations queue and are promoted as active children settle. The queue itself is unlimited.
- An agent owns at most one active top-level task at a time. A `send` call for an agent that already has one queues the new goal onto the existing task instead of starting a second one.

## Failure Propagation

A delegated failure never silently becomes a success. If the top-level task fails or is blocked while children are still active, the entire tree is aborted. If the top-level task completes but any child ended in failure or was blocked, the top-level result reflects the worst outcome among its children.

## Auditability

Delegation and mentions are attributed to the tasks and agents involved and are visible through `delta.inspect(taskId)` alongside every other execution and escalation for that task.
