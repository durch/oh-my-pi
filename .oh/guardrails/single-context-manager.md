---
id: single-context-manager
outcome: omp-monorepo
severity: hard
statement: Only one context-management system may be active at runtime. Assembler and legacy compaction must never run simultaneously. If configuration would activate both, runtime must fail closed.
---

ADR 0003 cutover invariant. Enforced by validateContextManagerConfig() which throws ContextManagerConfigError on conflicting settings.
