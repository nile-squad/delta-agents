# Spec Guidelines

A spec is a contract. It defines what must always be true, what must never happen, and why decisions were made. It is not a manual, not a reference, not a how-to.

## What a Spec Is

A spec answers three questions:

1. **Why** — what reasoning led to this design, what alternatives were rejected, what tradeoffs were accepted
2. **What must hold** — invariants that, if violated, are bugs
3. **What must never happen** — prohibitions that, if violated, are incidents

Everything else belongs in code, comments, or reference docs.

## What a Spec Is Not

- **Not an API reference.** Type definitions, method signatures, parameter tables — these belong in code and JSDoc. A spec that repeats what `types.ts` already says is maintenance debt. Reference the file, don't duplicate it.
- **Not a tutorial.** How to use the system belongs in a README or usage guide. A spec assumes the reader already knows or can find the interface.
- **Not a changelog.** History belongs in git. A spec documents the current state and the reasoning behind it, not every iteration that led here.
- **Not implementation detail.** Which function calls which, which file lives where, which line number — these change and rot. A spec describes the contract, not the wiring.

## Structure

Every spec must have these sections, in this order:

### Purpose

One paragraph. What this system does and why it exists. If you can't explain it in one paragraph, the system's boundaries are unclear.

### Principles

Numbered list. Each principle states the rule and briefly why. Principles are the foundation — every decision, invariant, and prohibition should trace back to one or more principles. If a principle doesn't have a "why," it's a preference, not a principle.

Principles are **aspirational** — they describe the system as it should be. If the current codebase violates a principle, that's a known gap, not a reason to weaken the principle.

### Decision Records

Each significant design choice gets a decision record with five fields:

- **Decision** — what was decided, in one sentence
- **Context** — what situation prompted the decision
- **Alternatives considered** — what other options were evaluated, and why they were rejected
- **Rationale** — why this option was chosen
- **Tradeoffs** — what we gave up or accepted as risk

Not every choice needs a record. Only decisions that are non-obvious, reversible, or have lasting impact. If the right answer is obvious and has no tradeoffs, it doesn't need a record.

Decision records are **timeless** — they explain why, not when. No dates, no "we decided on Tuesday." The reasoning stands regardless of when it was made.

### Invariants

Properties that must always be true. Written as declarative statements. If violated, it's a bug.

Invariants are **verifiable** — you should be able to write a test that would fail if the invariant were broken. If you can't write that test, the invariant is too vague.

### Prohibitions

Things that must never happen. If they do, it's a security incident or a critical bug.

Prohibitions are **absolute** — no exceptions, no "unless." If there's a legitimate exception, it's not a prohibition, it's an invariant with a condition.

### Follow-Up Work

Decisions that were deferred, known gaps between current code and principles, and items that need future design work. Each item states:

- **What** — the gap or deferred decision
- **Why it's deferred** — what's blocking it or why it's not urgent
- **Impact of deferring** — what risk or cost the current state carries

Follow-up work is **honest** — it acknowledges what's not yet done rather than pretending the system is complete. It prevents the same gaps from being rediscovered independently.

## Writing Rules

- **Present tense, declarative style.** "The engine owns the transaction lifecycle." Not "The engine will own" or "The engine should own."
- **Reference code, don't duplicate it.** "See `types.ts` for the full type definition." Not a copy of the type definition.
- **Be concise.** If a section can be cut without losing meaning, cut it. A spec that isn't read is worthless.
- **One principle per item.** Don't bundle multiple rules into one principle. "Sanitization is a boundary concern" is one principle. "The engine is the gateway" is another.
- **No hedging.** "Should," "preferably," "ideally" have no place in a spec. Use "must," "never," "always." If something is a preference, it's not a principle or an invariant — it's a convention, and conventions belong in AGENTS.md or code comments, not in a spec.
- **No implementation specifics.** File paths, line numbers, function names — these change. Reference the module or concept, not the file. "The engine's `sanitizeTransaction()` function" is acceptable. "Line 607 of `payment-engine.ts`" is not.

## Review Checklist

Before finalizing a spec, verify:

- [ ] Every principle has a "why"
- [ ] Every decision record has all five fields
- [ ] Every invariant is testable — could you write a failing test if it were violated?
- [ ] Every prohibition is absolute — no "unless" or "except when"
- [ ] No type definitions, method signatures, or parameter tables that duplicate code
- [ ] No implementation specifics (file paths, line numbers) that will rot
- [ ] Follow-up work is honest about gaps, not aspirational wishlists
- [ ] The spec can be read in under 10 minutes
- [ ] A new developer could read this and understand the system's design philosophy, not just its API

## Relationship to Other Documents

| Document | Purpose | Owner |
|----------|---------|-------|
| Spec | Principles, decisions, invariants, prohibitions | Architect |
| AGENTS.md | Coding conventions, workflow rules, boundaries | Owner |
| context.md | Current state, patterns, gotchas, recent learnings | Architect |
| README | How to set up, run, and use the system | Any |
| Code comments | Why specific code exists, edge cases, warnings | Developer |

Specs don't replace AGENTS.md (conventions) or context.md (current state). They complement them. AGENTS.md says *how* we write code. Context.md says *what* the codebase looks like today. A spec says *why* the system is designed this way and *what must always be true*.