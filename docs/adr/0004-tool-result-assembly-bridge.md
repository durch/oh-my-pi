# ADR 0004: Tool-Result-to-Memory Bridge

- Status: Proposed
- Date: 2026-03-06 (revised 2026-03-07)
- Decision makers: Harness maintainers
- Depends on: ADR 0003 (tiered memory + assembler)
- Revision note: Corrected scope. Previous version conflated the bridge (an input source) with the assembler (the context manager). This revision re-grounds the bridge as a component within ADR 0003's assembly model.

## Context

ADR 0003 defines a tiered memory architecture (LTM/STM/WM) with a Locator Map and a per-turn assembly policy. That policy — initialize WM, hydrate via locator map, rank, inject bounded context, distill, promote — describes a **context manager** that controls what the LLM sees each turn.

The assembler's job (per ADR 0003) is to compose the full context window from multiple sources under a token budget. This follows the Memex Context Space design:

```
Total budget (configurable)
├── Conversation history (bounded, most recent N messages)
├── Hydrated locator fragments (tool results, file reads)
├── STM summary (active paths, symbols, loops)
├── Session intent / objective
└── Distilled learnings (future: LTM)
```

The assembler decides what enters the context window and what doesn't. The conversation itself is bounded — not passed through unchanged.

**This ADR addresses one input to that assembly**: how tool execution events feed the Locator Map. Tool results are the primary source of context in a coding agent — a single `bash` execution can produce 50K tokens, a `grep` that answered a one-off question wastes tokens every subsequent turn. The bridge converts tool events into locator entries that the assembler can score, rank, and selectively hydrate.

### What the Bridge Is

An **observer** that watches tool execution events and produces `MemoryLocatorEntry` records + STM state. It is one input to the assembler, alongside conversation history, session intent, and eventually LTM.

### What the Bridge Is Not

- Not the context manager. The assembler (ADR 0003) manages the context window.
- Not responsible for conversation bounding. The assembler decides how many conversation messages fit the budget.
- Not responsible for prompt injection. The assembler composes and injects the final context.
- Not a replacement for pruning. The assembler replaces pruning by managing the full context window. The bridge just provides scored material for it to draw from.

### Half-Life Observation

Tool results have vastly different useful lifetimes:

| Category | Example tools | Typical half-life | After expiry |
|---|---|---|---|
| Lookup | grep, find, ast_grep, lsp(hover) | 1-2 turns | Address only |
| Read | read, fetch | 3-5 turns | Stale if path edited |
| Mutation | edit, write, ast_edit, notebook | Current turn only | Confirmation line |
| Execution | bash, python, task | 3-15 turns | Error=high, success=low |
| Subagent | task (completed) | Session-long | Summary only |

The bridge encodes these policies as freshness metadata on locator entries. The assembler uses freshness during scoring and hydration — stale entries are dropped, fresh entries compete for budget.

## Decision

Introduce a **tool-result-to-memory bridge** that:

1. Observes tool execution events (same `AgentSessionEvent` surface as telemetry).
2. Generates `MemoryLocatorEntry` records with tool-specific metadata.
3. Maintains `ShortTermMemoryRecord` state from tool outcomes.
4. Implements a `LocatorRetriever` that reads artifact files and re-reads source files.

### Architecture

```
Tool Execution Events (tool_execution_start/end)
        │
        ▼
┌─────────────────────┐
│   ToolResultBridge   │  ← subscribes to AgentSessionEvent
│                      │
│  - classifyResult()  │  → assigns category + freshness policy
│  - emitLocator()     │  → writes MemoryLocatorEntry to contract
│  - updateSTM()       │  → updates ShortTermMemoryRecord
│  - trackPaths()      │  → file-edit invalidation tracking
└──────────┬──────────┘
           │
           ▼ (one input among several)
    MemoryContractV1
           │
           ▼
┌─────────────────────────────────────────────┐
│          Assembler (ADR 0003)               │
│                                             │
│  Inputs:                                    │
│  - Conversation history (bounded by budget) │
│  - Hydrated locator entries (from bridge)   │
│  - STM summary (from bridge)               │
│  - Session intent / objective               │
│  - LTM (future)                             │
│                                             │
│  Output: composed context window            │
│  - transformContext() manages messages       │
│  - Replaces legacy pruning + compaction     │
└─────────────────────────────────────────────┘
```

The bridge feeds the contract. The assembler consumes the contract alongside other sources to compose the bounded context window. The assembler — not the bridge — is responsible for:

- Bounding conversation history to fit within its budget allocation
- Replacing previous-turn tool_result messages with hydrated locator fragments
- Removing stale messages entirely
- Composing the final `AgentMessage[]` returned from `transformContext()`

### Module: `packages/coding-agent/src/context/bridge/`

Four files:

- `bridge.ts` — `ToolResultBridge` class, event observer, state management
- `classify.ts` — tool result classification and freshness policy
- `retriever.ts` — `LocatorRetriever` implementation (artifact read + file re-read)
- `types.ts` — bridge-specific types

### 1. Tool Result Classification

Each tool result gets a `ResultProfile` that drives retention behavior:

```typescript
const TOOL_RESULT_CATEGORIES = [
  "lookup",    // grep, find, ast_grep, lsp.hover, lsp.references, web_search
  "read",      // read, fetch
  "mutation",  // edit, write, ast_edit, notebook
  "execution", // bash, python, task
  "control",   // todo_write, ask, checkpoint, rewind, cancel_job, await
  "subagent",  // task (completed subagent results)
] as const;

type ToolResultCategory = (typeof TOOL_RESULT_CATEGORIES)[number];
```

Classification is a static map from tool name to category (with runtime override for `task` based on whether it's a subagent completion or inline execution, and `bash` based on whether the command mutated files).

**Freshness policy per category:**

| Category | TTL | Invalidated by |
|---|---|---|
| lookup | 120s | Same-path edit, same-pattern re-grep |
| read | 300s | File edit to same path |
| mutation | 0s (current turn only) | Immediate (confirmation only) |
| execution | 600s (success) / session (error) | Resolution of error |
| control | 0s | Never retained |
| subagent | session | Never (summary only) |

### 2. Locator Entry Generation

On `tool_execution_end`, the bridge:

1. Classifies the result.
2. Extracts paths and symbols from tool args and result (reusing `extractPaths()` pattern from telemetry).
3. Computes a cost estimate (token count of result content / 4, latency estimate from tool type).
4. Constructs a `MemoryLocatorEntry`:

```typescript
{
  key: `tool.${toolName}.${toolCallId}`,
  tier: "short_term",
  where: primaryPath ?? `tool://${toolName}/${toolCallId}`,
  how: {
    method: "read",                    // for artifact-backed results
    params: { artifactId, toolName },  // retrieval params
  },
  cost: { estimatedTokens, estimatedLatencyMs: 5 },
  freshness: freshnessPolicy,          // from classification
  trust: isError ? "heuristic" : "authoritative",
  provenance: {
    source: `tool:${toolName}`,
    reason: summarize(args),            // one-line summary of what the tool did
    capturedAt: isoTimestamp,
    confidence: isError ? 0.3 : 0.9,
  },
}
```

**Key design choice**: the locator `where` field uses the primary affected path when one exists (e.g., the file path for `read`, the edited file for `edit`). This enables the kernel's `fileOverlap` scoring signal to rank tool results by relevance to the current working set.

### 3. STM Population

The bridge maintains a running `ShortTermMemoryRecord`:

- `touchedPaths`: accumulated from tool args/results via `extractPaths()`
- `touchedSymbols`: accumulated from `lsp` tool calls (symbol arg) and `ast_grep` patterns
- `unresolvedLoops`: added on tool errors, removed on success for same tool+path
- `locatorKeys`: references to generated locator entries

This reuses the exact same path extraction logic already in telemetry's `extractPaths()` — extract it to a shared utility.

### 4. Locator Retriever

Replace `stubRetriever` with a composite retriever:

```typescript
const artifactRetriever: LocatorRetriever = async (entry) => {
  const params = entry.how.params as { artifactId?: string; toolName?: string };
  if (!params?.artifactId) return null;

  const artifactPath = await artifacts.getPath(params.artifactId);
  if (!artifactPath) return null;

  return await Bun.file(artifactPath).text();
};
```

For non-artifact-backed entries (e.g., `read` results that weren't truncated), the recipe uses `method: "read"` with `params: { path }` and the retriever re-reads the file. This naturally handles freshness — a re-read returns current content, not stale content.

### 5. Relationship to Conversation Management

The bridge generates locator entries. It does **not** manage conversation messages.

Conversation management is the assembler's responsibility (ADR 0003). The assembler's `transformContext()` callback receives the full `AgentMessage[]` and returns a bounded, composed context window:

- **Current-turn tool results**: kept as full `tool_result` messages (conversation fidelity for the LLM's tool_use/tool_result pairing).
- **Previous-turn tool results**: replaced by the assembler with hydrated locator fragments (or dropped if stale). The bridge provides the material; the assembler does the replacement.
- **Conversation history**: bounded by the assembler to fit within its budget allocation.

This division of responsibility means:
- The bridge is stateless with respect to messages — it only observes events and produces locator entries.
- The assembler is the single authority on what enters the context window.
- The bridge can operate in shadow mode (observe-only) without any message manipulation.

### 6. Integration with Existing Systems

**ArtifactManager**: already stores truncated outputs. The bridge reuses this — no new storage layer.

**OutputMeta**: already carries `source`, `truncation`, `diagnostics`. The bridge reads these to populate locator entries.

**Telemetry**: operates in parallel. Both subscribe to `AgentSessionEvent` independently. No coordination needed.

**Legacy pruning/compaction**: replaced by the assembler (ADR 0003), not by the bridge. In assembler mode, the assembler's `transformContext()` replaces pruning by managing what messages enter the context window. The bridge is uninvolved in this replacement.

### 7. File Layout

```
packages/coding-agent/src/context/bridge/
├── bridge.ts          # ToolResultBridge class
├── classify.ts        # TOOL_CATEGORY_MAP, classifyResult(), freshness policies
├── retriever.ts       # artifactRetriever, re-read retriever
├── types.ts           # ResultProfile, ToolResultCategory, BridgeConfig
└── index.ts           # re-exports
```

Shared utility extracted from telemetry:
```
packages/coding-agent/src/context/extract-paths.ts   # extractPaths() + extractSymbols()
```

### 8. Wiring

The bridge wires in the same place as telemetry (`sdk.ts`), gated on `assembler` or `shadow` mode:

```typescript
if (isAssemblerMode(settings) || isShadowMode(settings)) {
  const bridge = new ToolResultBridge({ artifacts, contract });
  session.subscribe(bridge.observer);
  postmortem.register("bridge-flush", () => bridge.flush());
}
```

In shadow mode, the bridge populates the contract but the contract is not used for prompt assembly (observe-only).

## Consequences

### Positive

- Provides the assembler with scored, classified tool-result context to draw from.
- Locator entries enable budget-aware re-hydration of previously evicted content.
- File-edit invalidation prevents stale read results from polluting context.
- Artifact storage is reused — no new persistence layer.
- Clean separation: bridge observes and produces locator entries; assembler manages the context window.

### Negative

- Classification heuristics (especially for `bash` mutation detection) need tuning.
- Bridge adds one more subscriber to the event stream (marginal overhead).
- Re-read retriever introduces latency for non-artifact-backed entries.

## Non-Goals

- Not the context manager. The assembler (ADR 0003) manages what enters the context window.
- Not changing the tool executor interface. Tools don't need to know about the bridge.
- Not replacing the artifact storage system.
- Not implementing LTM promotion (future work after dogfooding).
- Not managing conversation history or message bounding (assembler's job).

## What Must Still Be Built (in the Assembler, per ADR 0003)

The bridge is one input. The following assembler capabilities remain unimplemented and are required for the system described in ADR 0003 to function as a context manager:

1. **Conversation bounding** — `transformContext()` must select recent messages within a budget allocation, not pass all messages through.
2. **Previous-turn replacement** — `transformContext()` must identify previous-turn `tool_result` messages and replace them with hydrated locator fragments (or drop stale ones entirely).
3. **Working memory rebuild** — WM must be rebuilt each turn from STM state, session objective, and budget.
4. **STM distillation** — accumulated STM (touchedPaths, symbols, loops) must be distilled, not grown unbounded.
5. **Budget calibration** — the budget must reflect actual context window management (conversation + assembled context), not reserve tokens for unpopulated phantom fields.

These are assembler responsibilities. They belong to the implementation of ADR 0003's assembly policy, not to this bridge. But they must exist for the bridge's output to serve its intended purpose.

## Issue Dependency

```
#1 (done) → #2 (telemetry, PR open)
         → #3 (kernel, PR open)
         → THIS (bridge) ──┐
                            ├──→ Assembler (ADR 0003 assembly policy) → #5 → #6 → #7
         → #4 (injection) ──┘
```

The bridge provides input. The assembler consumes it alongside other sources to compose the context window. Both must exist for the system to function as a context manager rather than a context decorator.
