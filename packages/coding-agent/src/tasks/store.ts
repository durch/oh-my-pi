import * as path from "node:path";
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { logger } from "@oh-my-pi/pi-utils";
import { generateTaskId } from "./id";
import type { Task, TaskCreateInput, TaskQuery, TaskStatus, TaskSummary, TasksResult, TaskView } from "./types";

/** LanceDB accepts plain objects with string keys. */
type LanceData = Record<string, unknown>[];

const TABLE_NAME = "tasks";

export class TaskStore {
	#db: Connection;
	#table: Table;
	#project: string;

	constructor(db: Connection, table: Table, project: string) {
		this.#db = db;
		this.#table = table;
		this.#project = project;
	}

	static async open(agentDir: string, project: string): Promise<TaskStore> {
		const dbPath = path.join(agentDir, "tasks.lance");
		const db = await connect(dbPath);
		const names = await db.tableNames();
		let table: Table;

		if (names.includes(TABLE_NAME)) {
			table = await db.openTable(TABLE_NAME);
		} else {
			const seedRow: Task = {
				id: "__seed__",
				content: "",
				details: "",
				status: "open",
				agent: "",
				session: "",
				labels: "[]",
				depends_on: "[]",
				notes: "",
				project: "__seed__",
				created_at: 0,
				updated_at: 0,
			};
			table = await db.createTable(TABLE_NAME, [seedRow] as unknown as LanceData);
			await table.delete("id = '__seed__'");
		}

		logger.debug("TaskStore initialized", { path: dbPath });
		return new TaskStore(db, table, project);
	}

	async create(inputs: TaskCreateInput[], session: string): Promise<string[]> {
		const now = Date.now();
		const ids: string[] = [];
		const rows: Task[] = [];

		for (const input of inputs) {
			const id = generateTaskId();
			ids.push(id);

			// Resolve "^" shorthand — depends on previous task in this batch
			const resolvedDeps = (input.depends_on ?? [])
				.map(dep => {
					if (dep === "^") {
						const prevId = ids[ids.length - 2];
						return prevId ?? "";
					}
					return dep;
				})
				.filter(Boolean);

			rows.push({
				id,
				content: input.content,
				details: input.details ?? "",
				status: "open",
				agent: "",
				session,
				labels: JSON.stringify(input.labels ?? []),
				depends_on: JSON.stringify(resolvedDeps),
				notes: "",
				project: this.#project,
				created_at: now,
				updated_at: now,
			});
		}

		await this.#table.add(rows as unknown as LanceData);
		logger.debug("TaskStore created tasks", { count: rows.length, ids });
		return ids;
	}

	async get(id: string): Promise<Task | undefined> {
		const results = await this.#table
			.query()
			.where(`id = '${this.#escape(id)}'`)
			.limit(1)
			.toArray();
		return results[0] as Task | undefined;
	}

	async update(
		id: string,
		fields: Partial<
			Pick<Task, "content" | "details" | "status" | "agent" | "session" | "labels" | "depends_on" | "notes">
		>,
	): Promise<boolean> {
		const existing = await this.get(id);
		if (!existing) return false;

		const updated: Task = {
			...existing,
			...fields,
			updated_at: Date.now(),
		};

		// LanceDB doesn't have native update — delete + re-insert
		await this.#table.delete(`id = '${this.#escape(id)}'`);
		await this.#table.add([updated] as unknown as LanceData);
		return true;
	}

	async remove(id: string): Promise<boolean> {
		const existing = await this.get(id);
		if (!existing) return false;
		await this.#table.delete(`id = '${this.#escape(id)}'`);
		return true;
	}

	async query(params: TaskQuery = {}): Promise<TasksResult> {
		const filters: string[] = [`project = '${this.#escape(this.#project)}'`];

		if (params.id) {
			filters.push(`id = '${this.#escape(params.id)}'`);
		}
		if (params.agent) {
			filters.push(`agent = '${this.#escape(params.agent)}'`);
		}
		if (params.session) {
			filters.push(`session = '${this.#escape(params.session)}'`);
		}
		if (params.status && params.status !== "ready" && params.status !== "blocked") {
			filters.push(`status = '${this.#escape(params.status)}'`);
		}

		const allRows = (await this.#table.query().where(filters.join(" AND ")).toArray()) as Task[];

		// Build a lookup for dependency resolution
		const statusById = new Map<string, TaskStatus>();
		for (const row of allRows) {
			statusById.set(row.id, row.status);
		}

		// If we need ready/blocked resolution, we need all project tasks for dep lookup
		let allProjectTasks = allRows;
		if (params.status === "ready" || params.status === "blocked" || !params.status) {
			if (filters.length > 1) {
				// We filtered by more than just project — need full project set for dep resolution
				const fullSet = (await this.#table
					.query()
					.where(`project = '${this.#escape(this.#project)}'`)
					.toArray()) as Task[];
				for (const row of fullSet) {
					statusById.set(row.id, row.status);
				}
				allProjectTasks = fullSet;
			}
		}

		// Convert to views with dependency resolution
		const views: TaskView[] = [];
		for (const row of allRows) {
			const deps = this.#parseJsonArray(row.depends_on);
			const blockedBy = deps.filter(depId => {
				const depStatus = statusById.get(depId);
				return depStatus !== undefined && depStatus !== "done";
			});

			const view = this.#toView(row, deps, blockedBy);

			// Filter by derived status
			if (params.status === "ready") {
				if (row.status !== "open" || blockedBy.length > 0) continue;
			} else if (params.status === "blocked") {
				if (row.status !== "open" || blockedBy.length === 0) continue;
			}

			// Filter by label (post-query — stored as JSON string)
			if (params.label) {
				const labels = this.#parseJsonArray(row.labels);
				if (!labels.includes(params.label)) continue;
			}

			views.push(view);
		}

		// Compute summary from all project tasks (not just filtered)
		const summary = this.#computeSummary(allProjectTasks, statusById);

		return { tasks: views, summary };
	}

	close(): void {
		this.#table.close();
		this.#db.close();
		logger.debug("TaskStore closed");
	}

	#toView(row: Task, deps: string[], blockedBy: string[]): TaskView {
		return {
			id: row.id,
			content: row.content,
			details: row.details || undefined,
			status: row.status,
			agent: row.agent || undefined,
			session: row.session || undefined,
			labels: this.#parseJsonArray(row.labels),
			depends_on: deps,
			blocked_by: blockedBy,
			notes: row.notes || undefined,
			created_at: new Date(row.created_at).toISOString(),
			updated_at: new Date(row.updated_at).toISOString(),
		};
	}

	#computeSummary(tasks: Task[], statusById: Map<string, TaskStatus>): TaskSummary {
		let open = 0;
		let active = 0;
		let done = 0;
		let ready = 0;
		let blocked = 0;

		for (const t of tasks) {
			switch (t.status) {
				case "open": {
					open++;
					const deps = this.#parseJsonArray(t.depends_on);
					const isBlocked = deps.some(depId => {
						const s = statusById.get(depId);
						return s !== undefined && s !== "done";
					});
					if (isBlocked) blocked++;
					else ready++;
					break;
				}
				case "active":
					active++;
					break;
				case "done":
					done++;
					break;
				// abandoned not counted in summary
			}
		}

		return { total: tasks.length, open, active, done, ready, blocked };
	}

	#parseJsonArray(value: string): string[] {
		if (!value || value === "[]") return [];
		try {
			return JSON.parse(value);
		} catch {
			return [];
		}
	}

	#escape(value: string): string {
		return value.replace(/'/g, "''");
	}
}
