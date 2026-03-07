# ADR 0004: Tool-Result-to-Memory Bridge for Context Assembly

- Status: Proposed
- Date: 2026-03-06
- Decision makers: Harness maintainers
- Depends on: ADR 0003, Issue #3 (assembler kernel), Issue #2 (shadow telemetry)

## Context

ADR 0003 introduced tiered memory (LTM/STM/WM) with a Locator Map and a local assembler kernel.
Issue #3 (PR #9) implemented the kernel: it scores, ranks, and hydrates `MemoryLocatorEntry[]` into a `WorkingContextPacketV1` under budget constraints.
Issue #2 (PR #10) implemented shadow telemetry: it observes `AgentSessionEvent` streams and writes structured NDJSON traces.

The kernel has a pluggable `LocatorRetriever` (currently a stub) and consumes a `MemoryContractV1`.
But nothing populates the contract from actual tool execution.
The gap: **tool results are the primary source of context, but no code converts them into locator entries, STM records, or retrievable artifacts**.

This ADR designs the bridge between tool execution events and the assembler kernel's input contract.

### Problem Framing

This is an **assembly** problem, not a storage problem.
The data is already stored (session JSONL + artifact files).
The problem is what gets assembled into context each turn, and in what form.

Tool results dominate context consumption. A single `bash` execution can produce 50K tokens.
A `grep` result that answered a one-off question wastes tokens every subsequent turn.
Current mitigation (pruning at `protectTokens: 40_000`) is a blunt instrument: it doesn't know tool semantics, doesn't distinguish current-turn relevance from historical noise, and can't recover pruned content when it becomes relevant again.

### Half-Life Observation

Tool results have vastly different useful lifetimes:

| Category | Example tools | Typical half-life | After expiry |
|---|---|---|---|
| Lookup | grep, find, ast_grep, lsp(hover) | 1-2 turns | Address only |
| Read | read, fetch | 3-5 turns | Stale if path edited |
| Mutation | edit, write, bash(build) | Current turn only | Confirmation line |
| Execution | bash, python, task | 3-15 turns | Error=high, success=low |
| Subagent | task(completed) | Session-long | Summary only |

## Decision

Introduce a **tool-result-to-memory bridge** module that:

1. Observes tool execution events (same `AgentSessionEvent` surface as telemetry).
2. Generates `MemoryLocatorEntry` records with tool-specific metadata.
3. Maintains `ShortTermMemoryRecord` state from tool outcomes.
4. Implements a real `LocatorRetriever` that reads artifact files.

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
           ▼
    MemoryContractV1     ← consumed by assembler kernel (issue #3)
           │
           ▼
 WorkingContextPacketV1  ← injected into prompt (issue #4)
```

### Module: `packages/coding-agent/src/context/bridge/`

Four files:

- `bridge.ts` — `ToolResultBridge` class, event observer, state management
- `classify.ts` — tool result classification and freshness policy
- `retriever.ts` — real `LocatorRetriever` implementation
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

The bridge maintains a running `ShortTermMemoryRecord` per objective:

- `touchedPaths`: accumulated from tool args/results via `extractPaths()`
- `touchedSymbols`: accumulated from `lsp` tool calls (symbol arg) and `ast_grep` patterns
- `unresolvedLoops`: added on tool errors, removed on success for same tool+path
- `locatorKeys`: references to generated locator entries

This reuses the exact same path extraction logic already in telemetry's `extractPaths()` — extract it to a shared utility.

### 4. Real Locator Retriever

Replace `stubRetriever` with `artifactRetriever`:

```typescript
const artifactRetriever: LocatorRetriever = async (entry) => {
  const params = entry.how.params as { artifactId?: string; toolName?: string };
  if (!params?.artifactId) return null;

  const artifactPath = await artifacts.getPath(params.artifactId);
  if (!artifactPath) return null;

  return await Bun.file(artifactPath).text();
};
```

This is intentionally simple. The artifact files already exist (the current `ArtifactManager` saves truncated outputs). The retriever reads them back.

For non-artifact-backed entries (e.g., `read` results that weren't truncated), the recipe uses `method: "read"` with `params: { path }` and the retriever re-reads the file. This naturally handles freshness — a re-read returns current content, not stale content.

### 5. Current-Turn vs. Historical Turns

**Critical invariant**: current-turn tool results stay as full conversation messages. The bridge only affects how *previous* turns' tool results appear in assembled context.

The assembly strategy:

| Turn age | Representation |
|---|---|
| Current turn | Full `tool_result` message (conversation fidelity) |
| Previous turn (within TTL) | Locator entry → hydrated by kernel under budget |
| Stale (past TTL or invalidated) | Locator entry → dropped by kernel, reported in `drops[]` |

This means the bridge does not interfere with the LLM's tool_use/tool_result pairing for the current turn. It only provides the kernel with material for assembling historical context.

### 6. Integration with Existing Systems

**ArtifactManager**: already stores truncated outputs. The bridge reuses this — no new storage layer. For results that weren't truncated (small outputs), the bridge can optionally store a full copy, or rely on re-execution via the recipe.

**OutputMeta**: already carries `source`, `truncation`, `diagnostics`. The bridge reads these to populate locator entries (e.g., `source.path` → locator `where`, `truncation.artifactId` → retriever params).

**Telemetry (PR #10)**: operates in parallel. Telemetry observes and traces; the bridge observes and populates the contract. Both subscribe to `AgentSessionEvent` independently. No coordination needed — they're both read-only observers of the same event stream.

**Pruning**: in assembler mode, pruning is replaced by the kernel's budget-aware hydration. The bridge does not interact with `pruneToolOutputs()`. In legacy/shadow mode, pruning continues unchanged.

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

In shadow mode, the bridge populates the contract but the contract is not used for prompt assembly (observe-only). This allows validation against legacy context during dogfooding (#6).

## Consequences

### Positive

- Replaces blunt pruning with semantic, per-tool-category retention.
- Locator entries enable the kernel to re-hydrate context that was previously evicted when it becomes relevant again.
- File-edit invalidation prevents stale read results from polluting context.
- Everything built feeds directly into ADR 0003's assembly model: locator entries are first-class, budget-aware, inspectable.
- Artifact storage is reused — no new persistence layer.

### Negative

- Classification heuristics (especially for `bash` mutation detection) need tuning.
- Bridge adds one more subscriber to the event stream (marginal overhead).
- Re-read retriever introduces latency for non-artifact-backed entries.

## Non-Goals

- Not changing the tool executor interface. Tools don't need to know about the bridge.
- Not replacing the artifact storage system.
- Not implementing LTM promotion (that's future work after dogfooding).
- Not wiring prompt injection (that's issue #4).

## Issue Dependency

This ADR describes new work that sits between #3 and #4:

```
#1 (done) → #2 (telemetry, PR open)
         → #3 (kernel, PR open)
         → THIS (bridge) → #4 (injection) → #5 → #6 → #7
```

The bridge unblocks #4 because the injection path needs a populated `MemoryContractV1` and a real retriever, not the empty contract + stub retriever from #3.

## Estimated Scope

- 4 new files in `src/context/bridge/` (~400-600 lines total)
- 1 extracted shared utility (~50 lines)
- Light touch to `sdk.ts` for wiring (~10 lines)
- No changes to tool executors
- Tests: classification map coverage, locator generation from tool events, STM accumulation, retriever reads, freshness invalidation (~300-500 lines)
