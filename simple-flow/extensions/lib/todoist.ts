/**
 * A thin, fail-loud, fully-awaited, unbuffered client over the Composio CLI
 * (`composio execute TODOIST_*`). Unlike slice-flow's fail-soft todoist.ts,
 * every method here THROWS on any CLI/nonzero failure — simple-flow is a
 * conversational, explicit-command tool, so a failed Todoist call must be a
 * loud error the user sees immediately, never a silent no-op. Declares its
 * OWN `Exec` type; does not import anything from slice-flow.
 *
 * Surface: `listProjects` and `createTask` (create + track), `findTask` (the
 * find-by-content recovery fallback used by the /simple-task handler when the
 * create response's id could not be parsed), `comment`, `close`, `update`
 * (named fields only — never labels), and `listTasks` (project browse for
 * /simple-resume).
 */

export type Exec = (cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Todoist {
	listProjects(): Promise<Array<{ id: string; name: string }>>;
	createTask(a: { project: string; content: string }): Promise<string | null>;
	findTask(content: string): Promise<{ taskId: string; project: string } | null>;
	comment(taskId: string, text: string): Promise<void>;
	close(taskId: string): Promise<void>;
	update(taskId: string, fields: { content?: string; description?: string; due?: string; priority?: number }): Promise<void>;
	listTasks(projectName: string): Promise<Array<{ id: string; content: string }>>;
}

/** Run one `composio execute` call. Throws (naming the Composio CLI) when
 * `exec` itself throws, or when the CLI exits nonzero — the fail-loud
 * counterpart of slice-flow's composioExec, which fails soft instead. */
async function composioExec(exec: Exec, tool: string, params: Record<string, unknown>): Promise<string> {
	let res;
	try {
		res = await exec("composio", ["execute", tool, "-d", JSON.stringify(params)], { timeout: 5000 });
	} catch (e) {
		throw new Error(`simple-flow: could not run the Composio CLI (${tool}). Is 'composio' installed and on PATH? ${e instanceof Error ? e.message : String(e)}`);
	}
	if (res.code !== 0) throw new Error(`simple-flow: Composio call ${tool} failed (exit ${res.code}). ${res.stderr.trim() || res.stdout.trim() || "check that the Composio CLI is authed."}`);
	return res.stdout;
}

/** Best-effort extraction of `{ id, name }` pairs from a list response
 * (TODOIST_GET_ALL_PROJECTS). Copied verbatim from slice-flow's todoist.ts:
 * both the envelope (results/projects) and the id field (id/project_id) are
 * probed; entries missing an id or name are dropped rather than guessed at. */
function parseNamedList(stdout: string): Array<{ id: string; name: string }> {
	type Entry = { id?: unknown; project_id?: unknown; name?: unknown };
	try {
		const parsed = JSON.parse(stdout) as { data?: { results?: Entry[]; projects?: Entry[] } | Entry[] };
		const raw = parsed?.data;
		const list: Entry[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.projects ?? []);
		return list
			.map((x) => ({ id: x?.id ?? x?.project_id, name: x?.name }))
			.filter((x): x is { id: unknown; name: string } => typeof x.name === "string" && x.name.length > 0 && x.id !== undefined && x.id !== null)
			.map((x) => ({ id: String(x.id), name: x.name }));
	} catch {
		return [];
	}
}

/** Best-effort extraction of the created task id from a `composio execute`
 * JSON response. Copied verbatim from slice-flow's todoist.ts. Returns null
 * (not a throw) when the create succeeded (exit 0) but the id could not be
 * parsed — the create itself was not a failure. */
function parseTaskId(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as { data?: { id?: unknown; task?: { id?: unknown } }; id?: unknown };
		const id = parsed?.data?.id ?? parsed?.data?.task?.id ?? parsed?.id;
		return id === undefined || id === null ? null : String(id);
	} catch {
		return null;
	}
}

/** Best-effort extraction of a `{ taskId, project }` pair from a
 * TODOIST_FILTER_TASKS response. Copied verbatim from slice-flow's
 * todoist.ts: the list may sit under data.results or data.tasks; requires
 * both an id and a project_id, returning null otherwise rather than guessing
 * further (the success envelope is unconfirmed against a live account). */
function parseFoundTask(stdout: string): { taskId: string; project: string } | null {
	try {
		const parsed = JSON.parse(stdout) as {
			data?: { id?: unknown; project_id?: unknown; task?: { id?: unknown; project_id?: unknown }; results?: Array<{ id?: unknown; project_id?: unknown }>; tasks?: Array<{ id?: unknown; project_id?: unknown }> };
		};
		const task = parsed?.data?.task ?? parsed?.data?.results?.[0] ?? parsed?.data?.tasks?.[0] ?? parsed?.data;
		const id = task?.id;
		const project = task?.project_id;
		if (id === undefined || id === null || project === undefined || project === null) return null;
		return { taskId: String(id), project: String(project) };
	} catch {
		return null;
	}
}

/** Best-effort extraction of `{ id, content }` task pairs from a
 * TODOIST_FILTER_TASKS response. Copied verbatim (shape) from slice-flow's
 * todoist.ts: the list may sit under data.results or data.tasks; entries
 * missing an id or content are dropped rather than guessed at. */
function parseTaskList(stdout: string): Array<{ id: string; content: string }> {
	type Entry = { id?: unknown; content?: unknown };
	try {
		const parsed = JSON.parse(stdout) as { data?: { results?: Entry[]; tasks?: Entry[] } | Entry[] };
		const raw = parsed?.data;
		const list: Entry[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.tasks ?? []);
		return list
			.filter((t): t is { id: string | number; content: string } => typeof t?.content === "string" && t.content.length > 0 && t?.id !== undefined && t?.id !== null)
			.map((t) => ({ id: String(t.id), content: t.content }));
	} catch {
		return [];
	}
}

/** Build a fail-loud Todoist client. Every method awaits its Composio call
 * inline (no buffer, no `flush`) and throws on any CLI/nonzero failure. */
export function createClient(opts: { exec: Exec }): Todoist {
	const { exec } = opts;
	return {
		async listProjects() {
			const stdout = await composioExec(exec, "TODOIST_GET_ALL_PROJECTS", {});
			return parseNamedList(stdout);
		},
		async createTask(a) {
			const stdout = await composioExec(exec, "TODOIST_CREATE_TASK", { content: a.content, project_id: a.project });
			return parseTaskId(stdout);
		},
		async findTask(content) {
			const stdout = await composioExec(exec, "TODOIST_FILTER_TASKS", { query: `search: ${content}` });
			return parseFoundTask(stdout);
		},
		async comment(taskId, text) {
			await composioExec(exec, "TODOIST_CREATE_COMMENT_V1", { task_id: taskId, content: text });
		},
		async close(taskId) {
			await composioExec(exec, "TODOIST_CLOSE_TASK_V1", { task_id: taskId });
		},
		async update(taskId, fields) {
			const params: Record<string, unknown> = { task_id: taskId };
			if (fields.content !== undefined) params.content = fields.content;
			if (fields.description !== undefined) params.description = fields.description;
			if (fields.due !== undefined) params.due_string = fields.due;
			if (fields.priority !== undefined) params.priority = fields.priority;
			// Never set params.labels — TODOIST_UPDATE_TASK replaces the whole label list.
			await composioExec(exec, "TODOIST_UPDATE_TASK", params);
		},
		async listTasks(projectName) {
			const stdout = await composioExec(exec, "TODOIST_FILTER_TASKS", { query: `#${projectName}` });
			return parseTaskList(stdout);
		},
	};
}
