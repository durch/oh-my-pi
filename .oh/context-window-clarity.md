# Session: context-window-clarity

## Aim
**Updated:** 2026-03-08T20:17:15Z

## Aim Statement

**Aim:** Operators can inspect the agent’s live context window and steer the session confidently instead of guessing what the model currently sees.

**Current State:** When the agent behaves unexpectedly, users infer context contents from scattered logs and partial introspection, and often cannot quickly answer “why was this included and that omitted?”
**Desired State:** At any moment, users can see what is in the context window, what was excluded, why each item is present, and how much budget remains, then adjust prompts or investigate with confidence.

### Mechanism
**Change:** Build a faithful observability surface for assembler state that exposes current window composition, provenance, token budget, exclusions, and inclusion/cutoff reasons from the assembler’s actual source of truth.
**Hypothesis:** If users can see the exact assembled context and the rationale behind inclusion/exclusion, they will trust the harness more, detect context failures faster, and correct course before a bad turn compounds.
**Assumptions:**
- The main pain is invisibility of context decisions, not primarily poor retrieval quality.
- Existing low-level signals are sufficient raw material, but they are not yet user-legible.
- Users will actively use live context visibility during sessions, not only after failures.

### Feedback
**Signal:** In dogfood sessions, a user can answer “what is in the context window right now, why is it there, and what got left out?” from the product surface alone in under 30 seconds; vague context-debugging reports decrease.
**Timeframe:** Immediate in manual dogfood sessions; trend should be visible within 1–2 weeks of regular use.

### Guardrails
- Observability must reflect the actual assembled prompt, not an approximate or stale reconstruction.
- Preserve protocol compatibility and additive integration; no event/lifecycle contract breakage for observability.
- Preserve locator-first memory invariants; do not retain full tool payloads in memory tiers just to make them visible.
- Default UX must answer inclusion/exclusion/budget questions first; raw telemetry can be drill-down, not the primary surface.

## Problem Space
**Updated:** 2026-03-08T20:35:40Z

## Problem Space Map

**Date:** 2026-03-08  
**Scope:** Live context-window observability for assembler mode in `packages/coding-agent/`

### Objective
We are optimizing for: operators being able to determine the model’s effective context quickly enough to debug and steer a session in real time, without reconstructing it from logs or guesses.

### Constraints

| Constraint | Type | Reason | Question? |
|------------|------|--------|-----------|
| Observability must reflect actual runtime prompt composition, not an approximate reconstruction | hard | A misleading inspector is worse than none; it creates false confidence | No |
| RPC/SSE compatibility must remain intact | hard | Downstream orchestrators in `ai-omnibus` consume these contracts | Only with an explicit migration plan |
| Locator-first memory invariant must hold; no storing full payloads in memory tiers for convenience | hard | ADR invariant; bridge stores locators, hydrator retrieves on demand | No, but transient runtime views are still allowed |
| Integration should stay additive and narrowly scoped inside existing coding-agent surfaces | soft | Fork patch scope is intentionally small; upstream sync remains active | Yes, if current surfaces cannot support faithful visibility |
| The primary operator surface should be the current TUI/status/RPC stack | assumed | That is where existing observability already lives | Could be false; a dedicated inspector may be the right abstraction |
| “Assembler observability” is sufficient to satisfy “understand exactly what is in the context window” | assumed | Current work centers on the assembler | Could be false; the full context window also includes transformed messages, system prompt, and tool definitions |
| One representation can satisfy both humans and external orchestrators | assumed | Tempting to reuse one schema everywhere | Could be false; human and machine consumers may need different views |

### Terrain
- **Systems:**
  - Memory contract already models provenance, drop reasons, fragments, and per-turn packet output.
  - The assembler pipeline already computes budget from full prompt costs, transforms messages, assembles fragments, then prepends assembled context.
  - RPC introspection exposes only aggregate state.
  - Existing UI-facing context usage exposes only token totals/percent, not composition.
- **Stakeholders:** Interactive users/dogfooders, maintainers debugging assembler behavior, downstream orchestrators consuming RPC, extension authors building on current status surfaces.
- **Blast radius:**
  - If wrong, users will trust a stale or partial view and debug the wrong thing.
  - If protocol shape changes carelessly, orchestrators break.
  - If observability cheats by retaining payloads, it violates the core architecture.
  - If the surface is too verbose, users still will not answer the key question quickly.
- **Precedents:**
  - `get_introspection` already provides additive external visibility, but only in summary form.
  - `assembler:transform` logs already capture drops and usage, but only as logs.
  - `formatAssembledContext()` already defines the exact injected assembler fragment block.
  - `ContextUsage` already exposes aggregate context pressure in the extension/TUI layer.

### Assumptions Made Explicit
1. The main bottleneck is invisibility, not retrieval quality — if false: better observability will not materially improve trust or steering.
2. The assembled packet is the same thing as “the context window” — if false: an assembler inspector alone will still miss transformed message history, system prompt cost, and tool-definition cost.
3. Existing raw signals are sufficient to explain inclusion/exclusion decisions — if false: the kernel needs to emit richer decision metadata such as ranking breakdowns or cutoff rationale.
4. A single surface can be both exact and usable — if false: this needs layered UX, not one dense dump.

### X-Y Check
- **Stated need (Y):** Make oh-omp observability 10x better so the user always understands exactly what is in the context window.
- **Underlying need (X):** Make prompt composition legible, trustworthy, and actionable at the moment the user needs to debug or steer the agent.
- **Confidence:** Medium-high — the stated need points at the right problem, but “observability” is still mechanism language and may hide a broader prompt-composition scope than assembler-only introspection.

### Ready for Solution Space?
No - first we need a crisp problem statement that decides the true scope: assembler-only visibility, full prompt-composition visibility, or decision-rationale visibility. Those are related, but not the same problem.

### Grounding
- `packages/coding-agent/src/context/memory-contract.ts:53-67,177-197` — drop reasons, provenance, fragment shape, packet shape already exist.
- `packages/coding-agent/src/sdk.ts:1428-1494` — actual pipeline: transform messages, derive budget, assemble, bound messages, prepend assembled context.
- `packages/coding-agent/src/context/assembler/format.ts:15-27` — exact assembler context injected into the prompt.
- `packages/coding-agent/src/modes/rpc/rpc-introspection.ts:17-80` and `packages/coding-agent/src/modes/rpc/rpc-types.ts:206-220` — current introspection is aggregate, not composition-level.
- `packages/coding-agent/src/extensibility/extensions/types.ts:185-190` — current UI-facing context surface is only tokens/context-window percent.

## Problem Statement
**Updated:** 2026-03-08T20:35:40Z

## Problem Statement

**Current framing:** “Make oh-omp observability 10x better so the user always understands exactly what is in the context window.”

**Reframed as:** Operators need a faithful, live view of the effective prompt composition for each turn because they cannot debug or steer the agent if they do not know what the model actually saw, but today that composition is split across transformed messages, assembled fragments, budget telemetry, and logs, so no single surface explains what was included, excluded, or truncated and why.

**The shift:** From “improve observability” as a tooling exercise to “make prompt composition legible and trustworthy” as an operator-control problem. Also from “assembler introspection” to “effective prompt composition,” which is broader and closer to the user’s actual question.

### Constraints
- **Hard:**  
  - Any view must be derived from the actual runtime composition path, not an approximate reconstruction.  
  - RPC/event compatibility cannot break.  
  - Locator-first memory invariants must hold; no payload retention shortcuts.
- **Soft:**  
  - The solution should remain additive and fit the current TUI/RPC/extension model.  
  - Current introspection structures may be extended, but they are not sacred.  
  - Human and machine consumers do not have to share the exact same surface if that harms clarity.

### What this framing enables
- Evaluating solutions that expose the full effective prompt, not just assembler summaries.
- Treating inclusion, exclusion, truncation, and budget rationale as first-class product data.
- Considering separate but aligned views:
  - machine-readable snapshot for RPC/orchestrators
  - human-readable inspector for live debugging
- Rejecting “more logs” as sufficient if the user still cannot answer “what did the model see?”

### What this framing excludes
- Summary-only telemetry such as counts, percentages, or provenance aggregates without composition-level visibility.
- Log-only debugging flows that require reconstructing prompt state after the fact.
- “Assembler observability” that ignores other prompt contributors like transformed message history, system prompt cost, or tool-definition cost, unless the product explicitly narrows scope to assembler fragments only.
- Any shortcut that creates a stale, lossy, or misleading picture of the live context window.

Grounding:
- `packages/coding-agent/src/sdk.ts:1428-1494` shows the actual composition path: transform messages, derive budget, assemble fragments, then prepend assembled context.
- `packages/coding-agent/src/context/assembler/format.ts:15-27` shows the exact injected assembler block.
- `packages/coding-agent/src/modes/rpc/rpc-introspection.ts:17-80` and `packages/coding-agent/src/modes/rpc/rpc-types.ts:206-220` show current introspection is aggregate, not composition-level.
- `packages/coding-agent/src/context/memory-contract.ts:53-67,177-197` shows the system already has provenance, drop reasons, fragments, and packet structure to build from.

## Solution Space
**Updated:** 2026-03-08T20:35:40Z

## Solution Space Analysis

**Problem:** Operators cannot see the effective prompt composition for a turn, so they cannot tell what the model actually saw, what was excluded, or why.  
**Key Constraint:** Visibility must come from the exact runtime composition path, not a post-hoc reconstruction, and it must preserve protocol compatibility plus locator-first memory invariants.

### Candidates Considered

| Option | Level | Approach | Trade-off |
|--------|-------|----------|-----------|
| A | Band-Aid | Extend current introspection/logs/footer with more counts and summaries | Fast, but still not composition-level |
| B | Local Optimum | Build an assembler-only inspector around `WorkingContextPacketV1` | Faithful for fragments, incomplete for full prompt |
| C | Redesign | Create a canonical effective-prompt snapshot at composition time, then render dual surfaces (RPC + human inspector) | Medium-high implementation cost; requires new snapshot model |
| D | Redesign | Build a generalized trace/span observability layer first, then derive prompt views from traces | Highest leverage long-term, but likely overbuilds the first step |

### Evaluation

**Option A: Summary Telemetry++**
- Solves stated problem: No
- Implementation cost: Low
- Maintenance burden: Low
- Second-order effects: Improves dashboards and logs, but still forces users to reconstruct what happened from aggregates. High risk of false confidence because “more numbers” looks like observability without answering “what did the model see?”

**Option B: Assembler-Only Inspector**
- Solves stated problem: Partially
- Implementation cost: Medium
- Maintenance burden: Medium
- Second-order effects: Makes assembler behavior legible, but the user asked for **full effective-prompt visibility**. This misses transformed message history, system prompt, and tool-definition contribution. Real risk: the team ships this, calls observability “done,” and still cannot explain bad turns caused outside assembler fragments.

**Option C: Canonical Effective-Prompt Snapshot**
- Solves stated problem: Yes
- Implementation cost: Medium-High
- Maintenance burden: Medium
- Second-order effects: Forces the architecture to acknowledge prompt composition as a first-class runtime artifact. Enables both operator UX and external orchestration from one source of truth. Also creates a clean seam for future export/tracing.

**Option D: Trace-First Observability Substrate**
- Solves stated problem: Yes
- Implementation cost: High
- Maintenance burden: High
- Second-order effects: Best long-term foundation if you want cross-system AI observability, replay, regression capture, and OTel export. But it delays the concrete operator win and risks turning a product-control problem into an infrastructure project.

### Recommendation

**Selected:** Option C - Canonical Effective-Prompt Snapshot  
**Level:** Redesign

**Rationale:** This is the highest peak that still fits the current repo constraints.

It solves the actual problem:
- not “better metrics,”
- not “better assembler logs,”
- but **a faithful view of what the model saw on this turn**.

Why this one:
- The exact composition already happens in one place: `packages/coding-agent/src/sdk.ts:1428-1494`. That is the right source of truth.
- It avoids the local maximum of assembler-only visibility. The problem statement is about **effective prompt composition**, not just fragment hydration.
- It stays additive: one internal snapshot model can feed both a structured RPC response and a human-readable inspector.
- It preserves the locator-first design because the snapshot is a runtime artifact, not memory-tier payload retention.

Why not the others:
- **Option A:** too shallow; still summary-only.
- **Option B:** wrong scope; good partial tool, bad answer to the stated problem.
- **Option D:** probably the eventual architecture, but premature as the first move.

**Accepted trade-offs:**
- You likely need to change the abstraction of `transformMessages()`. Right now it returns only messages, not decision metadata for stubbed or dropped turns (`packages/coding-agent/src/context/assembler/message-transform.ts:216-239`). Full visibility needs structured transform output, not inference after the fact.
- The human view cannot dump everything raw by default. Full fidelity and usability conflict. The UI needs layered disclosure.
- “Exact” for tools may mean token cost + tool list by default, with optional schema expansion, rather than always rendering giant JSON schemas inline.

### Implementation Notes

1. **Introduce a canonical runtime artifact**
   - Add something like `EffectivePromptSnapshot` or `PromptCompositionSnapshot`.
   - Build it **inside** the actual composition path in `sdk.ts`, after:
     - message transform
     - budget derivation
     - assembler packet creation
     - message bounding
   - Capture it **before** the model call, so it reflects the true final request shape.

2. **Make message transformation explainable**
   - Current `transformMessages()` is output-only.
   - For this recommendation to work, it should return structured decisions such as:
     - turns kept verbatim
     - tool results stubbed
     - turns dropped by budget
     - token counts before/after
   - Otherwise the inspector will be reconstructing behavior from diffs, which violates the “no approximation” guardrail.

3. **Snapshot contents should include**
   - **System prompt**
     - full text or stable fingerprint + expandable full text
     - token estimate
   - **Tools**
     - tool list
     - total definition token estimate
     - optional per-tool/schema drill-down
   - **Messages**
     - final post-transform message list
     - annotations for kept/stubbed/dropped turns
   - **Assembler**
     - raw `WorkingContextPacketV1`
     - formatted injected developer message
     - fragments, provenance, dropped fragment reasons
   - **Budget breakdown**
     - context window
     - system prompt tokens
     - tool definition tokens
     - transformed message tokens
     - assembled context tokens
     - remaining headroom / safety margin

4. **Expose two surfaces from the same snapshot**
   - **RPC surface:** machine-readable, stable enough for orchestrators
   - **Human surface:** TUI inspector focused on four questions:
     - what is in
     - what is out
     - why
     - how close to the limit
   - Do not make `getContextUsage()` the primary source; it is estimate-oriented and post-response (`packages/coding-agent/src/session/agent-session.ts:4994-5037`), not a faithful per-turn composition trace.

5. **Defer generalized tracing**
   - After this lands, you can decide whether to export snapshots as trace/span events.
   - That gives you a clean path toward broader observability without making tracing the prerequisite for operator usefulness.

### External precedent
This recommendation matches mainstream LLM observability practice: exact prompt inputs and token usage should be captured from the execution path as first-class trace data, not reconstructed from logs later.

Sources:
- OpenTelemetry GenAI spans: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- OpenTelemetry GenAI metrics: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/

## Plan
**Updated:** 2026-03-08T20:52:37Z
**Issues:** #25, #26, #27, #28

- #25 Refactor message transform to emit explainable turn decisions
- #26 Capture canonical effective-prompt snapshots during composition
- #27 Expose prompt composition snapshots via RPC and query-oriented inspection APIs
- #28 Build a compact prompt composition inspector with drill-down