# Supervision

> **Status:** Being repurposed for delta-agents. Previous @nilejs/future content is in git history.

This document should cover the delta-agents supervision model: configurable strategies (retry, restart, resume from checkpoint, escalate to human, abort subtree, abort entire tree), the bounded supervision tree (max 1 active parent + 2 active subtasks), checkpointing, and recovery boundaries. The spec defines SupervisionPolicy with strategy and maxRetries.

See [delta-agents.spec.md](../delta-agents.spec.md) for the canonical specification.
