Mutates task state. Use `todos` to read state back.

## Operations

**plan** — Create tasks in bulk.
Each task: `{ content, details?, labels?, depends_on? }`.
Use `depends_on: ["^"]` to depend on the previous task in the list.

**claim** — Take an open task. Sets status to active, assigns you.
Requires `id`.

**done** — Complete an active task.
Requires `id`. Optional `notes` for completion context.

**drop** — Release or abandon a task.
Requires `id`. If `abandon: true`, marks as abandoned; otherwise returns to open.

**assign** — Set the agent name on a task (for subagent delegation).
Requires `id` and `agent`.

**edit** — Modify a task's content, details, labels, notes, or depends_on.
Requires `id` and at least one field to change.

**remove** — Delete a task permanently.
Requires `id`.

## Parameters

```
op: "plan" | "claim" | "done" | "drop" | "assign" | "edit" | "remove"
tasks?: Array<{ content, details?, labels?, depends_on? }>  // plan only
id?: string          // required for all ops except plan
notes?: string       // done, edit
agent?: string       // assign
abandon?: boolean    // drop
content?: string     // edit
details?: string     // edit
labels?: string[]    // edit
depends_on?: string[] // edit
```