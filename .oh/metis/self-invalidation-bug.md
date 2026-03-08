---
id: self-invalidation-bug
outcome: omp-monorepo
title: Locator self-invalidation via STM touchedPaths
---

The kernel built invalidation tags from all STM touchedPaths, but every tool call adds its paths to both the locator's invalidatedBy and the STM. Result: every locator invalidated itself immediately. Fix: pass empty invalidation set to hydrator — the bridge already handles real-time invalidation via #trackMutation. The kernel's invalidation check was redundant and harmful.
