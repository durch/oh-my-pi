# LLM-Native Task Tool

**Status:** Draft
**Date:** 2026-03-12
**Replaces:** `todo_write` tool, `ba` CLI (for LLM consumers)

## Problem

Task tracking in the harness is split across three disconnected mechanisms:

1. **`todo_write`** — session-scoped, write-only, no query, no subagent awareness, mechanical bookkeeping (2 calls per task just for status)
2. **`ba` CLI** — persistent, multi-agent capable, but designed for human CLI interaction (pretty tables, clap subcommands, shell invocation overhead)
3. **Task tool context passing** — subagent dispatch has no formal link to task state; parent manually syncs todo after subagents return

Result: I maintain task state in my own context window (expensive), can't query what's done, can't coordinate with subagents through task state, and spend ~60% of my task-tracking tool calls on pure bookkeeping.

## Design Principles

1. **LLM-native** — no human will run this directly. Optimize for tool-call ergonomics, not CLI UX.
2. **Read/write split** — queries are free, mutations are explicit. I query 3-5x more than I mutate.
3. **Flat with edges** — tasks + dependencies (DAG), not nested phases. Structure emerges from deps, not upfront hierarchy.
4. **Subagent-aware** — tasks link to agent dispatches. Subagents claim and complete work. Parent queries state.
5. **Always persistent** — every task hits disk. Ephemeral is just "create, work, close" in one session.
6. **Minimal ceremony** — `plan` creates N tasks in one call. `done` completes in one call. No `in_progress` + `completed` dance.

## Tool Interface

### `tasks` (read)

Query workspace task state. Zero side effects.

```typescript
interface TasksParams {
  id?: string;              // get specific task by ID
  status?: "open" | "active" | "done" | "blocked" | "ready";
  agent?: string;           // filter by assigned agent
  label?: string;           // filter by label
  session?: string;         // filter by session
}
```

**Calling patterns:**
```
tasks()                          → all active tasks (open + active)
tasks({ status: "ready" })       → unblocked and unclaimed
tasks({ agent: "FixImports" })   → what did this subagent get assigned?
tasks({ id: "task-7" })          → details + history of one task
tasks({ status: "blocked" })     → what's waiting on dependencies?
```

**Return shape:**
```typescript
interface TasksResult {
  tasks: Array<{
    id: string;
    content: string;
    details?: string;
    status: "open" | "active" | "done" | "abandoned";
    agent?: string;
    session?: string;
    labels: string[];
    depends_on: string[];
    blocked_by: string[];     // computed: unfinished deps
    notes?: string;
    created_at: string;
    updated_at: string;
  }>;
  summary: {
    total: number;
    open: number;
    active: number;
    done: number;
    ready: number;            // open + not blocked
    blocked: number;
  };
}
```

### `task` (write)

Mutate task state. Returns affected tasks.

```typescript
interface TaskParams {
  op: "plan" | "claim" | "done" | "drop" | "assign" | "edit" | "remove";
  // op-specific fields below
}
```

#### Operations

**`plan`** — create tasks from a work breakdown.
```
task({
  op: "plan",
  tasks: [
    { content: "Fix parser", details: "src/parser.ts line 42", labels: ["bug"] },
    { content: "Update callers", depends_on: ["^"] },
    { content: "Run tests", depends_on: ["^"] }
  ]
})
```

- `depends_on: ["^"]` — shorthand for "depends on previous task in this list"
- `depends_on: ["task-3", "task-5"]` — explicit task IDs
- Returns created task IDs
- Calling `plan` again adds to existing tasks (not replace)

**`claim`** — take ownership, status → active.
```
task({ op: "claim", id: "task-1" })
task({ op: "claim", id: "task-1", agent: "SubagentName", session: "session-xyz" })
```

**`done`** — complete a task, status → done.
```
task({ op: "done", id: "task-1" })
task({ op: "done", id: "task-1", notes: "Fixed, 3 callers updated" })
```

**`drop`** — abandon a task, status → open (release) or abandoned.
```
task({ op: "drop", id: "task-1" })
task({ op: "drop", id: "task-1", abandon: true })
```

**`assign`** — assign to an agent without claiming (for subagent dispatch).
```
task({ op: "assign", id: "task-2", agent: "UpdateCallers" })
```

**`edit`** — modify task metadata.
```
task({ op: "edit", id: "task-1", content: "Fix parser and validator", labels: ["bug", "p0"] })
task({ op: "edit", id: "task-1", depends_on: ["task-3"] })
task({ op: "edit", id: "task-1", notes: "Root cause found in tokenizer" })
```

**`remove`** — delete a task entirely.
```
task({ op: "remove", id: "task-1" })
```

## State Machine

```
         plan
          │
          v
       ┌──────┐    claim     ┌────────┐
       │ open │──────────────>│ active │
       └──────┘               └────────┘
          ^                    │      │
          │    drop            │      │
          └────────────────────┘      │
                                      │  done
                              ┌───────v──────┐
                              │     done     │
                              └──────────────┘

                              ┌──────────────┐
          drop(abandon:true)  │  abandoned   │
          ───────────────────>└──────────────┘
```

- `open` — created, not yet claimed
- `active` — claimed by an agent, work in progress
- `done` — completed
- `abandoned` — dropped permanently

Claiming a `done` task reopens it to `active` (ba's existing behavior — useful for rework).

## Derived States (query-only)

- `ready` = `open` AND all `depends_on` tasks are `done`
- `blocked` = `open` AND at least one `depends_on` task is NOT `done`

## Subagent Integration

When the parent dispatches via the Task tool:

1. Parent creates tasks and assigns: `task({ op: "assign", id: "task-2", agent: "UpdateCallers" })`
2. Subagent receives its task ID in context
3. Subagent calls `task({ op: "claim", id: "task-2" })` on arrival
4. Subagent works, then calls `task({ op: "done", id: "task-2", notes: "..." })`
5. Parent queries: `tasks({ agent: "UpdateCallers" })` to see results

The Task tool executor wires this automatically — when dispatching, it passes the assigned task ID to the subagent's context, and the subagent's tool set includes `task` and `tasks`.

## Storage

**LanceDB** — structured fields + optional vector column for semantic search.

Schema:
```
id:          string (primary, auto-generated: "task-{n}")
content:     string (short description)
details:     string (implementation notes, file paths)
status:      string (open | active | done | abandoned)
agent:       string? (assigned agent name)
session:     string? (claiming session ID)
labels:      string[] (user-defined tags)
depends_on:  string[] (task IDs this depends on)
notes:       string? (completion notes, observations)
project:     string (project path — for cross-project queries)
created_at:  timestamp
updated_at:  timestamp
vector:      float32[N]? (embedding of content+details, for semantic search)
```

The vector column enables `recall`-style queries over task history: "what was I doing with the parser last week" — but is not required for core operations. Structured queries (`status = 'ready'`, `agent = 'X'`) handle the hot path.

## TUI Rendering

The sidebar renders identically to today's todo list. Data source changes from in-memory `TodoPhase[]` to a `tasks({ status: "active" })` query against LanceDB.

Changes:
- `interactive-mode.ts` `#renderTodoList()` reads from `tasks()` instead of `session.getTodoPhases()`
- `#formatTodoLine()` maps `TasksResult` items to the same visual format
- `Ctrl+T` expand/collapse behavior unchanged
- `todo-reminder.ts` queries `tasks({ status: "ready" })` count instead of phase-walking

## What Gets Removed

| Component | Reason |
|---|---|
| `tools/todo-write.ts` | Replaced by `task` + `tasks` tools |
| `agent-session.ts` `#todoPhases` state | Replaced by LanceDB queries |
| `agent-session.ts` `#eagerTodoEnforcementEnabled` | No longer needed — no "exactly one in_progress" rule |
| `parentOwnedToolNames` exclusion for `todo_write` | Replaced by subagent-aware `task`/`tasks` tools — subagents get them too |
| `event-controller.ts` todo event handling | Replaced by direct LanceDB observation |
| `todo-reminder.ts` phase-walking logic | Simplified to `tasks({ status: "ready" }).summary.ready` |

## What the `ba` Binary Becomes

The Rust `ba` binary remains as a **CLI diagnostic tool** — a way for the human to inspect `.ba/` state from the terminal. But the LLM never shells out to it. The harness tools (`task`/`tasks`) are the primary interface, reading/writing the same underlying storage.

If storage migrates fully to LanceDB, `ba` gets a `--lancedb` flag or becomes a thin query CLI over the same store.

## Migration

1. Build `task` and `tasks` tools backed by LanceDB
2. Wire into tool registry alongside `todo_write`
3. Update system prompt to prefer `task`/`tasks`
4. Wire subagent integration in `task/executor.ts`
5. Update TUI sidebar rendering
6. Remove `todo_write` and all in-memory phase state
7. Update `ba` skill to use native tools instead of shell invocations

## Resolved

1. **ID format** — random short IDs (e.g. `t_7kx3`). Avoids cross-session collisions, prevents accidental wrong-task references. Sequential IDs create false ordering and collide across sessions.

2. **Batch mutations** — not in v1. Single-op interface is cleaner to implement and reason about. Add a `batch` op later if round-trip cost becomes measurable.

## Open Questions

1. **Cross-project queries** — should `tasks()` see tasks from other projects? Useful for "what am I working on across all repos" but adds complexity. Leaning toward project-scoped by default with an opt-in `project: "all"` filter.

2. **TUI integration depth** — should the sidebar show dependency edges? Blocked indicators? Or keep it minimal (status icon + content)?
