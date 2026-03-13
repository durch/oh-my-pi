/** Task status values. */
export type TaskStatus = "open" | "active" | "done" | "abandoned";

/** Persisted task record. */
export interface Task {
	id: string;
	content: string;
	details: string;
	status: TaskStatus;
	agent: string;
	session: string;
	labels: string;
	depends_on: string;
	notes: string;
	project: string;
	created_at: number;
	updated_at: number;
}

/** Input for creating a new task via the `plan` operation. */
export interface TaskCreateInput {
	content: string;
	details?: string;
	labels?: string[];
	depends_on?: string[];
}

/** Query parameters for listing/filtering tasks. */
export interface TaskQuery {
	id?: string;
	status?: TaskStatus | "ready" | "blocked";
	agent?: string;
	label?: string;
	session?: string;
}

/** Computed task view returned to the LLM. */
export interface TaskView {
	id: string;
	content: string;
	details?: string;
	status: TaskStatus;
	agent?: string;
	session?: string;
	labels: string[];
	depends_on: string[];
	blocked_by: string[];
	notes?: string;
	created_at: string;
	updated_at: string;
}

/** Summary counts for a task query result. */
export interface TaskSummary {
	total: number;
	open: number;
	active: number;
	done: number;
	ready: number;
	blocked: number;
}

/** Full result from a tasks query. */
export interface TasksResult {
	tasks: TaskView[];
	summary: TaskSummary;
}

/**
 * LanceDB stores arrays and optional fields poorly — it infers schema from
 * the first row and cannot handle nulls or mixed types. We store all fields
 * as non-null strings/numbers:
 *
 * - `labels`: JSON-encoded string[] (e.g. '["bug","p0"]')
 * - `depends_on`: JSON-encoded string[] (e.g. '["t_7kx3"]')
 * - `agent`, `session`, `details`, `notes`: empty string when absent
 *
 * The TaskStore handles encoding/decoding at the boundary.
 */
