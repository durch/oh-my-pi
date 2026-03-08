---
id: omp-monorepo-progress
outcome: omp-monorepo
threshold: assembler:transform logs show fragments > 0 and consumedTokens > 0 on every turn after the first; bun check:ts passes clean
type: slo
---

The assembler mode is the default context manager. Each turn after tool calls, the transform produces hydrated fragments from the locator map. Zero fragments or all-invalidated entries is a regression. Type checks and lint must pass.
