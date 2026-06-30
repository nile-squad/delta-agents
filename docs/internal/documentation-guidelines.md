# Documentation Guidelines

Internal standards for how documentation is written and maintained in delta-agents. Applies to all documentation: README, spec, ADRs, reference docs, internal docs, and context.md.

## 1. Purpose

Documentation exists to:

- Reduce onboarding time
- Preserve architectural intent
- Prevent knowledge loss
- Enable safe modification of the system

Documentation does NOT exist to:

- Market features
- Speculate about the future
- Sound impressive
- Replace clarity with verbosity

Clarity over persuasion. Accuracy over enthusiasm. Precision over volume.

## 2. Public vs Internal Boundary

Hard rule: if a package consumer would not benefit from a detail, but a maintainer needs to know it, it goes in `docs/internal/`, never in the README or public docs.

Never expose unnecessary technical details in public docs unless explicitly approved. If unsure whether a detail is consumer-relevant, it is not. Put it in `docs/internal/`.

### 2.1 Document Locations

| Location | Audience | Content |
|---------|----------|---------|
| `README.md` | Consumers | Install, quick start, API overview, concepts. No internal mechanics. |
| `AGENTS.md` | All agents | Coding rules, workflow discipline, delegation protocol, boundaries. |
| `context.md` | Agents | Current codebase state, patterns, gotchas, recent learnings. |
| `docs/*.md` (except `internal/`) | Consumers, integrators | Architecture overviews, supervision strategies, ADRs, resource guides. |
| `docs/internal/` | Maintainers only | Implementation maps, enforcement mechanisms, internal guidelines, principle-to-code traces, spec, spec guidelines. Anything a consumer does not need to use the framework. |

Only `README.md`, `AGENTS.md`, and `context.md` live at the project root. All other documentation lives under `docs/` or `docs/internal/`.

### 2.2 What Goes Where

Consumer-facing (README, public docs):

- How to install and configure
- How to define agents, workflows, actions
- What the framework does (at the contract level)
- Quick examples that work
- API surface

Maintainer-only (`docs/internal/`):

- Which function enforces which principle
- Internal control flow (gateway ordering, state machine transitions)
- Implementation maps (principle to code location)
- Internal guidelines (this document, spec guidelines)
- Debugging internals, diagnostic surface details
- Anything referencing specific file paths, line numbers, or internal function names that a consumer never calls

If a detail explains HOW the engine enforces something internally, it is maintainer-only. If it explains WHAT the engine guarantees, it is consumer-facing.

## 3. Truthfulness and Verification

### 3.1 No Speculative Content

Documentation MUST reflect only verified, implemented behavior.

Do NOT document:

- Planned features
- Roadmap ideas
- Assumed behavior
- Hypothetical endpoints
- Unimplemented flows

If future work must be referenced, it MUST be labeled clearly:

> Planned (Not Implemented)

### 3.2 Code Is the Source of Truth

All technical documentation MUST align exactly with the implementation.

- Use real function names
- Use actual parameter names
- Match true return structures
- Match real error formats
- Verify examples against working code

If documentation and code conflict, documentation must be corrected immediately.

### 3.3 No Assumed Behavior

Do not document behavior that has not been verified directly in the source code.

If uncertain, confirm before writing.

## 4. Brevity and Density

Documentation MUST be concise.

- Prefer structured bullets over long paragraphs
- Avoid repetition
- Avoid background storytelling unless necessary
- Remove sections that do not add clarity

If a section can be removed without reducing understanding, remove it.

Short and precise is superior to long and impressive.

## 5. Tone and Professional Standards

Documentation MUST:

- Use neutral, technical language
- Avoid promotional phrasing
- Avoid exaggerated claims
- Avoid urgency-driven language
- Avoid emotional or persuasive wording

The tone must reflect calm engineering confidence.

### 5.1 Prohibited Elements

- No emojis
- No slang
- No marketing-style adjectives
- No hype language
- No em dashes. Use commas, periods, or semicolons instead.
- No decorative separators (`---`). Use heading hierarchy and blank lines for structure.

## 6. Architectural Integrity Requirements

System-level documentation MUST include:

### 6.1 Intent

- What problem is solved
- Why this solution exists

### 6.2 Responsibilities

- What this component is responsible for

### 6.3 Non-Goals

- What it explicitly does NOT do

### 6.4 Constraints

- Performance limits
- Platform assumptions
- Memory/runtime boundaries

### 6.5 Failure Modes (When Applicable)

- Known failure scenarios
- Error handling behavior
- Recovery expectations

Architecture without documented constraints becomes unstable.

## 7. Formatting Standards

### 7.1 Section Structure

- Use numbered sections for specifications
- Maintain consistent hierarchy (`##`, `###`)
- Do not skip numbering
- Use heading hierarchy and blank lines for separation. Do not use `---` dividers.

### 7.2 Code Blocks

- Always include a language identifier
- Ensure examples are syntactically correct
- Use realistic data

### 7.3 Lists

- Use `-` for unordered lists
- Use numbered lists for sequential steps
- Maintain consistent indentation
- Avoid deeply nested structures unless necessary

### 7.4 Emphasis Rules

- Use **bold** for important terms
- Use `code formatting` for:
  - Function names
  - File paths
  - Types
  - Variables

Avoid excessive styling.

## 8. Documentation Categories

| Category | Location | Purpose |
|----------|----------|---------|
| Specification | `docs/internal/delta-agents.spec.md` | Principles, invariants, prohibitions, decision records |
| ADR | `docs/ADR-*.md` | Decision records for significant design choices |
| Reference | `docs/*.md` (except `internal/`) | Architecture, supervision, resources, diagnostics |
| Internal | `docs/internal/` | Implementation maps, enforcement mechanisms, guidelines, spec |
| Context | `context.md` | Current codebase state, patterns, gotchas |
| README | `README.md` | Install, quick start, API overview |

Different document types serve different purposes. Do not mix purposes within a single document.

See `./spec-guidelines.md` for spec-specific writing rules and the full document relationship table.

## 9. Removal and Evolution Rule

Stale documentation is worse than no documentation.

If behavior changes:

- Update the document immediately
- Or remove outdated sections

Breaking changes must clearly document impact.

## 10. Onboarding Standard

Documentation must optimize for this outcome:

> A competent engineer can understand the system and begin working without external explanation.

If documentation increases confusion, it must be simplified.

For consumers, the README and public docs should be sufficient to install, configure, and use the framework. For maintainers, the spec, internal docs, and `context.md` should explain why the system is designed this way and how to modify it safely.