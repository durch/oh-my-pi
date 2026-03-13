Query workspace task state. Zero side effects — safe to call frequently.

## Parameters (all optional)
- `id` — Get a specific task by ID
- `status` — Filter: open, active, done, blocked, ready, abandoned
- `agent` — Filter by agent name
- `label` — Filter by label
- `session` — Filter by session ID

No parameters returns all open and active tasks (the default working set).

## Returns
- `tasks` — Array of matching tasks with id, content, status, labels, dependencies, blocked_by
- `summary` — Counts: total, open, active, done, ready, blocked

## When to use
- At the start of work to orient on current state
- To check which tasks are ready (all dependencies met)
- To monitor subagent progress
- Before claiming or finishing tasks
- To verify completion status after work