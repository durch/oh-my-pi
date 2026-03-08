---
files:
- packages/coding-agent/src/context/**
- packages/coding-agent/src/sdk.ts
- docs/adr/0003-*
- docs/adr/0004-*
id: omp-monorepo
mechanism: 'Replace legacy compaction-based context management with a tiered memory assembler (LTM/STM/WM) that uses addressable locator maps and budget-aware JIT hydration. The assembler manages the full context window: current-turn tool results stay verbatim, previous turns are replaced with hydrated fragments scored by relevance, and the conversation is bounded to fit the model''s context window.'
status: active
---

# omp-monorepo

(Describe the desired outcome here.)

## Signals
- (what signals indicate progress?)

## Constraints
- (what guardrails apply?)

