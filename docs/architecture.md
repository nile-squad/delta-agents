# Architecture

> **Status:** Being repurposed for delta-agents. Previous @nilejs/future content is in git history.

This document should cover the delta-agents architecture: the governance engine, state-space model, task hierarchy (master task, subtasks, supervision tree), workflow hierarchy (action, task, workflow, multi-phase workflow), queueing model (FIFO), and the two-tier API separation (authoring vs runtime). The engine owns enforcement, the model owns reasoning.

See [delta-agents.spec.md](../delta-agents.spec.md) for the canonical specification.
