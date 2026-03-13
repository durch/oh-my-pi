# FTS5 Keyword Search for Tool Results

**Status:** Approved
**Date:** 2026-03-13
**Depends on:** Issue #68 (stub pointers)

## Problem

The LLM has no way to search past tool results by exact content. Semantic search (LanceDB/recall) finds "things like X" but misses exact matches — error codes, file paths, task IDs, hex values. Tool results live in `agent.state.messages` within a session but are inaccessible by keyword. Across sessions, only semantic recall exists.

## Design

### Architecture

```
Bridge observes tool result
        |
        |--- LocatorEntry (existing)
        '--- FTS5 insert (new, async)
                |
                '--> ~/.oh-omp/tool-results.db
                        |
                +-------+--------+
                |                |
        recall tool          passive hydration
        (mode: "keyword")   (keyword boost, phase 2)
```

### Storage

Single SQLite DB at `~/.oh-omp/tool-results.db` via `bun:sqlite`. Persists across sessions.

**Schema:**

```sql
-- Porter stemming for natural language queries
CREATE VIRTUAL TABLE tool_results USING fts5(
    content,
    tool_name,
    paths,
    session_id UNINDEXED,
    turn_number UNINDEXED,
    created_at UNINDEXED,
    tokenize='porter unicode61'
);

-- Trigram for exact substring matches (error codes, hex, UUIDs)
CREATE VIRTUAL TABLE tool_results_trigram USING fts5(
    content,
    rowid_ref UNINDEXED,
    tokenize='trigram'
);
```

Two tables indexed together: porter for stemmed queries, trigram for exact substrings. Query both, merge results, dedup by rowid.

**Fields:**

- `content` -- full tool result text (FTS5-indexed in both tables)
- `tool_name` -- "read", "grep", "bash", etc. (searchable, `tool_name:grep` works)
- `paths` -- space-separated file paths from the result (searchable)
- `session_id` -- for cross-session filtering (unindexed, filter only)
- `turn_number` -- for ordering/display (unindexed)
- `created_at` -- for TTL cleanup (unindexed)

### Ingest

At bridge observation time, after the locator entry is created:

```typescript
// In bridge.ts, after classify + locator entry
if (toolResult.content) {
    this.#resultStore.index({
        content: extractText(toolResult.content),
        toolName: toolResult.toolName,
        sessionId: this.#sessionId,
        turnNumber: this.#turnCounter,
        paths: locatorEntry?.where?.paths ?? [],
    });
}
```

- Async, non-blocking
- If insert fails, log and continue -- search degradation is acceptable, tool execution delay is not
- Both porter and trigram tables are written in the same transaction

### Retrieval: recall tool enhancement

Add `mode` parameter to the existing `recall` tool:

```
recall({ query: "ENOENT src/parser.ts", mode: "keyword" })
```

- `mode: "semantic"` (default, current behavior) -- vector search via LanceDB
- `mode: "keyword"` -- FTS5 BM25 search over tool results only

**Keyword mode returns:**

```typescript
interface KeywordResult {
    snippet: string;      // FTS5 snippet() extraction, ~200 chars around match
    toolName: string;
    turnNumber: number;
    sessionId: string;
    paths: string[];
    rank: number;         // BM25 score
}
```

**Query strategy:**

1. Query porter table with BM25 ranking
2. Query trigram table for exact substring matches
3. Merge results, dedup by rowid, take top 10
4. Extract snippets using FTS5 `snippet()` function
5. If `session` filter provided, scope to that session
6. Default: current session results ranked above cross-session

### Retrieval: Passive hydration keyword boost (phase 2)

After the semantic search in `passive-hydration.ts`:

1. Extract distinctive terms from the hot window (file paths, error codes, identifiers)
2. Query FTS5 with those terms
3. If any keyword results aren't already in the semantic results, append them (up to 2-3 extra entries within budget)

Additive only -- catches the "exact error code" case that semantic search misses.

### Cleanup

TTL-based. On startup, delete entries older than 30 days:

```sql
DELETE FROM tool_results WHERE created_at < ?;
DELETE FROM tool_results_trigram WHERE rowid_ref NOT IN (SELECT rowid FROM tool_results);
```

Configurable via settings. DB is append-only during sessions, cleanup runs once at init.

### System prompt

Add a section explaining keyword search:

> Tool results from earlier in this session (and past sessions) are searchable by keyword.
> Use `recall({ query: "exact text", mode: "keyword" })` to find specific tool output
> by content. This is useful for error messages, file paths, exact values, and anything
> where you need the precise text rather than semantically similar results.

## Implementation Phases

### Phase 1: Core

1. `ToolResultStore` class -- `bun:sqlite` FTS5 with porter + trigram, insert, search, snippet extraction
2. Bridge hook -- insert at observation time
3. `recall` tool -- add `mode: "keyword"` parameter, query FTS5
4. System prompt -- document keyword mode
5. TTL cleanup on startup

### Phase 2: Enhancement

1. Passive hydration keyword boost
2. Search result highlighting in TUI renderer
3. Cross-session result deduplication

## What This Does NOT Change

- Hot window behavior -- unchanged
- Semantic recall -- unchanged, still the default mode
- Stub text -- unchanged (issue #68 handles that separately)
- LanceDB ingest -- unchanged, still runs for embeddings
- `agent.state.messages` -- unchanged, still the canonical source
