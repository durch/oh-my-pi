# ADR 0003: Tiered Memory Model with Locator Map for Coding-Agent Context

- Status: Accepted (iterative)
- Date: 2026-03-05
- Decision makers: Harness maintainers

## Context

ADR 0001 established a constrained-fork strategy and ADR 0002 locked RPC compatibility contracts.

We now need context continuity before the standalone context-assembler service exists.

A coding agent has different needs than a chat assistant:

- correctness depends on current repo and runtime state,
- context stales quickly,
- execution traces (tool calls/results, retries, diagnostics) matter more than prose summaries.

If we persist payload-heavy context (full snippets, long narrative logs), we will exceed token/latency budgets and degrade decision quality.

## Decision

We adopt a **tiered memory architecture** for coding-agent context assembly:

1. **Long-term memory (LTM)** — durable, sparse, mostly pointers.
2. **Short-term memory (STM)** — session continuity and causal trace.
3. **Working memory (WM)** — turn-local active state, rebuilt each turn.

And we introduce a first-class **Locator Map**:

- Store where to fetch context and how to fetch it,
- Avoid storing large payloads unless immediately needed,
- Hydrate context just-in-time under strict token/latency budgets.

Core principle: **addresses and retrieval recipes over payload retention**.

## Memory Tiers

### 1) Long-term memory (LTM)

Purpose: durable knowledge across sessions.

Contains:

- architecture decisions, guardrails, constraints,
- stable codebase landmarks (capability -> path/symbol),
- retrieval recipes and provenance,
- low-churn operational patterns.

LTM should remain compact and attribution-rich.

### 2) Short-term memory (STM)

Purpose: continuity within active work.

Contains:

- current objective and acceptance criteria,
- touched files/symbols and why,
- recent tool outcomes (especially failures/retries),
- unresolved loops (pending actions, jobs, TODO reminders).

STM decays quickly and is continuously distilled.

### 3) Working memory (WM)

Purpose: immediate next-action accuracy.

Contains only what is needed for the next turn:

- subgoal,
- active hypotheses,
- top-ranked files/symbols,
- immediate next actions,
- budget state (token/latency headroom).

WM is rebuilt every turn from STM + just-in-time retrieval via Locator Map.

## Locator Map Contract

Each locator entry should include:

- `key`: semantic handle (`rpc.compat.contract`, `session.jobs.snapshot`),
- `where`: path/symbol/endpoint,
- `how`: retrieval recipe (`read`, `lsp.definition`, `get_session_stats`, etc.),
- `cost`: estimated token and latency,
- `freshness`: TTL or invalidation rule,
- `trust`: authoritative / derived / heuristic,
- `provenance`: source and timestamp.

Locator entries are first-class context artifacts and must be inspectable.

## Assembly Policy (Coding-Agent First)

Per turn:

1. Initialize WM from objective + unresolved loops.
2. Hydrate missing facts using Locator Map (budget-aware JIT fetch).
3. Rank candidates with coding-first signals:
   - file/symbol overlap,
   - active diagnostics/failures,
   - causal adjacency to recent failures,
   - recency/freshness.
4. Inject bounded context with provenance.
5. Distill outcomes back into STM.
6. Promote stable learnings to LTM and/or Locator Map.

## Non-Goals

- Not a transcript replay system.
- Not full-file persistence in memory tiers.
- Not replacing protocol contracts or orchestrator semantics.
- Not requiring external context-assembler service to begin.

## Consequences

### Positive

- Reduces token waste by replacing payload retention with addressable retrieval.
- Improves coding reliability by prioritizing execution-state and code locality.
- Enables iterative rollout in fork without protocol breakage.
- Provides inspectable provenance for injected context.

### Negative

- Requires disciplined freshness/invalidation logic.
- Initial ranking heuristics may need tuning against real traces.
- Adds implementation complexity (locator management + JIT hydration).

## Iteration Policy

This ADR is intentionally iterative.

- Preserve invariant: **tier separation + locator-first assembly**.
- Refine scoring, eviction, and promotion rules through measured telemetry.
- Any change that collapses tiers or bypasses locator/provenance discipline requires a follow-up ADR.

## Immediate Implementation Path in Fork

1. Build telemetry extension to capture code-context and execution-state signals.
2. Implement local in-process assembler kernel using LTM/STM/WM + Locator Map contract.
3. Add inspectable RPC introspection snapshot for assembled state and provenance.
4. Keep compatibility constraints from ADR 0002 intact during rollout.
