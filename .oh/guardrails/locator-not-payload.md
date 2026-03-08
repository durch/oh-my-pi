---
id: locator-not-payload
outcome: omp-monorepo
severity: hard
statement: Memory tiers store locator entries (address + retrieval recipe), never full tool output payloads. Hydrate on demand under budget.
---

ADR 0003 core invariant. The bridge produces locators; the retriever hydrates them JIT.
