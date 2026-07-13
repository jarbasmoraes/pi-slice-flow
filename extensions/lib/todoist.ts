/**
 * The single module that talks to Todoist, via the Composio CLI (`composio
 * execute TODOIST_*`). Modeled on telemetry.ts: no SDK, an injected transport
 * (here `Exec` rather than `fetch`), and every method fail-soft — a disabled
 * flag, a missing `exec`, or a dead/failing CLI degrades to `null`/no-op and
 * never throws into the workflow.
 *
 * Slice 001: task creation. Slice 003: a buffered, fail-soft `move`/`comment`
 * transport — synchronous enqueue methods append to an in-memory buffer;
 * `flush()` drains it over the Composio CLI in order, catching every error.
 * Slices 004-005 added the `move`/`comment`/`close`/`label` callers. Slice 006
 * added `attach` for the one-time frame/architecture doc attachments. Slice 007
 * added `findTask`/`taskContext` — awaited, immediate (unbuffered) lookups for
 * the pull path (adopting an existing Todoist task), mirroring `createTask`'s
 * shape rather than the buffered `move`/`comment`/etc. Slice 008 (this slice)
 * adds `listSections`/`createSection` — the same awaited-immediate shape,
 * used by the adopt path to reconcile an existing project's board sections
 * before deciding `sectionMode`. `listTasks` (the /feature-todo-start pick
 * path) lists a project's active tasks so the human can pick one to adopt.
 */

import { basename } from "node:path";
import type { SliceFlowConfig } from "./config.ts";
import type { Exec } from "./worktree.ts";
import type { Phase } from "./workspace.ts";

/** Maps a workflow phase to the Todoist board section it lives in while that
 * phase is active. `stopped` is intentionally absent (no section => never
 * moved). Used by `transitionPhase` to decide whether a transition crosses a
 * section boundary (enqueue move+comment) or stays within one (enqueue
 * nothing). */
export const PHASE_SECTION: Partial<Record<Phase, string>> = {
	frame: "Frame",
	architect: "Architect",
	prototype: "Architect",
	plan: "Plan",
	implement: "Build",
	verify: "Review",
	loop: "Simplify",
	done: "Ship",
};

/** The canonical 7-section board convention, in left-to-right board order —
 * the distinct values of PHASE_SECTION. Used by setupTodoistStart's adopt
 * branch to decide which sections (if any) are missing from an adopted
 * task's project. */
export const BOARD_SECTIONS = ["Frame", "Architect", "Plan", "Build", "Review", "Simplify", "Ship"] as const;

/** A buffered board-sync operation: the Composio tool slug plus its params,
 * queued by a synchronous enqueue method and shipped in order by `flush()`.
 * `kind` marks the ops that need multi-step / resolved handling at flush time
 * (a plain op is shipped verbatim as a single `composio execute`):
 *   - "move"   resolve the section NAME to its id, then move with section_id only
 *   - "attach" upload the local file, then create a file comment with the url
 *   - "label"  read the task's current labels, then append (never replace) */
export interface Op {
	tool: string;
	params: Record<string, unknown>;
	kind?: "move" | "attach" | "label";
}

export interface Todoist {
	readonly enabled: boolean;
	/** Awaited, immediate lookup: the account's projects as `{ id, name }` pairs,
	 * so the push path can offer a picker of EXISTING projects and create against
	 * a real project id (Todoist project names are not unique and cannot be used
	 * as ids). Fails soft to [] on any failure. */
	listProjects(): Promise<Array<{ id: string; name: string }>>;
	/** Create a task. `project` MUST be a project id; `section` (optional) is a
	 * section NAME that is resolved to its id before the task is created (an
	 * unresolved section is dropped). Returns the new task id, or null on any
	 * failure. */
	createTask(a: { project: string; section?: string; content: string }): Promise<string | null>;
	/** Awaited, immediate lookup (not buffered): finds a task by name or id.
	 * Tries an id lookup first, falls back to a text search; returns null when
	 * nothing matches or on any failure. */
	findTask(query: string): Promise<{ taskId: string; project: string } | null>;
	/** Awaited, immediate lookup (not buffered): the task's content, description,
	 * and existing comments, used to seed an adopted run's feature description.
	 * Fails soft to empty strings/array on any failure. */
	taskContext(taskId: string): Promise<{ content: string; description: string; comments: string[] }>;
	/** Awaited, immediate lookup (not buffered): the ACTIVE tasks in a project,
	 * as `{ id, content }` pairs, so the pick path (/feature-todo-start) can offer
	 * a task picker. `projectName` is the project's display NAME — Todoist's list
	 * endpoints scope by filter syntax (`#Name`), not by project id. Fails soft
	 * to [] on any failure. */
	listTasks(projectName: string): Promise<Array<{ id: string; content: string }>>;
	/** Awaited, immediate lookup (not buffered): the section names present in a
	 * project. Fails soft to an empty array on any failure — never restructures
	 * a project this couldn't read. */
	listSections(project: string): Promise<string[]>;
	/** Awaited, immediate op (not buffered): creates one section in a project.
	 * Fails soft (never throws) on any failure. */
	createSection(project: string, name: string): Promise<void>;
	/** Synchronous, fail-soft enqueue of a section-changing move. `project` is a
	 * project id, `section` a section NAME; the name is resolved to a section id
	 * and the move is sent with section_id only at flush time. Never throws. */
	move(taskId: string, project: string, section: string): void;
	/** Synchronous, fail-soft enqueue: see `move`. */
	comment(taskId: string, text: string): void;
	/** Synchronous, fail-soft enqueue of a file comment: at flush the local file
	 * is uploaded (TODOIST_UPLOAD_FILE) to obtain a hosted file_url, then a
	 * TODOIST_CREATE_COMMENT_V1 file comment references that url. See `move`. */
	attach(taskId: string, filePath: string): void;
	/** Synchronous, fail-soft enqueue: marks the task complete via
	 * TODOIST_CLOSE_TASK_V1. See `move`. */
	close(taskId: string): void;
	/** Synchronous, fail-soft enqueue of a non-destructive label add: at flush the
	 * task's current labels are read and the union with `label` is applied (the
	 * label is ensured to exist first), never replacing existing labels. See
	 * `move`. */
	label(taskId: string, label: string): void;
	/** Drains the op buffer over the Composio CLI, in insertion order, catching
	 * every per-op error. Always resolves, even when every op throws. */
	flush(): Promise<void>;
}

export const NOOP: Todoist = {
	enabled: false,
	async listProjects() {
		return [];
	},
	async createTask() {
		return null;
	},
	async findTask() {
		return null;
	},
	async taskContext() {
		return { content: "", description: "", comments: [] };
	},
	async listTasks() {
		return [];
	},
	async listSections() {
		return [];
	},
	async createSection() {},
	move() {},
	comment() {},
	attach() {},
	close() {},
	label() {},
	async flush() {},
};

/** Run one `composio execute` call and capture its exit code plus streams.
 * Confirmed against the installed Composio CLI (v20260615_00): arguments are
 * passed as `-d <json>`, not `--params` (see memo for the correction and the
 * open question on the create-success response shape). Hard 5s timeout so a
 * hung CLI can never stall the workflow. */
async function composioExec(exec: Exec, tool: string, params: Record<string, unknown>, filePath?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const args = ["execute", tool, "-d", JSON.stringify(params)];
	// The CLI injects a local file into the single file_uploadable input via
	// --file (used by TODOIST_UPLOAD_FILE); -d carries the other params.
	if (filePath) args.push("--file", filePath);
	return exec("composio", args, { timeout: 5000 });
}

/** Best-effort extraction of `{ id, name }` pairs from a list response
 * (TODOIST_GET_ALL_PROJECTS, TODOIST_LIST_SECTIONS). Composio nests the list
 * under different keys per tool: TODOIST_GET_ALL_PROJECTS returns it under
 * response.data.projects with each entry keyed by `project_id` (per the tool's
 * own description and its search known-pitfalls), while TODOIST_LIST_SECTIONS
 * returns it under response.data.results. Both the envelope
 * (results/projects/sections) and the id field (id/project_id/section_id) are
 * probed so one parser serves both tools; entries missing an id or name are
 * dropped rather than guessed at. */
function parseNamedList(stdout: string): Array<{ id: string; name: string }> {
	type Entry = { id?: unknown; project_id?: unknown; section_id?: unknown; name?: unknown };
	try {
		const parsed = JSON.parse(stdout) as { data?: { results?: Entry[]; projects?: Entry[]; sections?: Entry[] } | Entry[] };
		const raw = parsed?.data;
		const list: Entry[] = Array.isArray(raw) ? raw : (raw?.results ?? raw?.projects ?? raw?.sections ?? []);
		return list
			.map((x) => ({ id: x?.id ?? x?.project_id ?? x?.section_id, name: x?.name }))
			.filter((x): x is { id: unknown; name: string } => typeof x.name === "string" && x.name.length > 0 && x.id !== undefined && x.id !== null)
			.map((x) => ({ id: String(x.id), name: x.name }));
	} catch {
		return [];
	}
}

/** Best-effort extraction of the Todoist upload attachment metadata from a
 * TODOIST_UPLOAD_FILE response. Returns null (⇒ the caller skips the comment)
 * unless a hosted `file_url` is present — never falls back to a local path. */
function parseUpload(stdout: string): { file_url: string; file_name?: string; file_type?: string; resource_type?: string } | null {
	try {
		const parsed = JSON.parse(stdout) as { data?: Record<string, unknown> } & Record<string, unknown>;
		const d = (parsed?.data ?? parsed) as Record<string, unknown>;
		if (typeof d?.file_url !== "string" || !d.file_url) return null;
		const att: { file_url: string; file_name?: string; file_type?: string; resource_type?: string } = { file_url: d.file_url };
		for (const k of ["file_name", "file_type", "resource_type"] as const) if (typeof d[k] === "string") att[k] = d[k] as string;
		return att;
	} catch {
		return null;
	}
}

/** Best-effort extraction of the created task id from a `composio execute`
 * JSON response. The exact success envelope was not confirmed against a live
 * create (doing so would side-effect a real Todoist account); this checks the
 * common response shapes and returns null rather than guessing further. */
function parseTaskId(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as { data?: { id?: unknown; task?: { id?: unknown } }; id?: unknown };
		const id = parsed?.data?.id ?? parsed?.data?.task?.id ?? parsed?.id;
		return id === undefined || id === null ? null : String(id);
	} catch {
		return null;
	}
}

/** Best-effort extraction of a `{ taskId, project }` pair from either a
 * TODOIST_GET_TASK2 (single-task) or TODOIST_FILTER_TASKS (list) response.
 * Neither success envelope was confirmed against a live account (same
 * unconfirmed-shape caveat as parseTaskId); returns null rather than
 * guessing further when either field is missing. */
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
 * TODOIST_FILTER_TASKS response (unconfirmed envelope, same caveat as
 * parseFoundTask: the list may sit under data.results or data.tasks). Entries
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

/** Best-effort extraction of comment text from a TODOIST_GET_ALL_COMMENTS
 * response (unconfirmed envelope, same caveat as parseFoundTask). Any
 * non-string/blank content is dropped rather than guessed at. */
function parseComments(stdout: string): string[] {
	try {
		const parsed = JSON.parse(stdout) as { data?: { comments?: Array<{ content?: unknown }>; results?: Array<{ content?: unknown }> } | Array<{ content?: unknown }> };
		const raw = parsed?.data;
		const list = Array.isArray(raw) ? raw : (raw?.comments ?? raw?.results ?? []);
		return list.filter((c): c is { content: string } => typeof c?.content === "string" && c.content.length > 0).map((c) => c.content);
	} catch {
		return [];
	}
}

/** Best-effort extraction of section names from a TODOIST_LIST_SECTIONS
 * response. The tool's own known-pitfalls note says results live under
 * response.data.results (not a top-level array); the exact envelope was not
 * confirmed against a live account (same unconfirmed-shape caveat as every
 * other parser here). Non-string/blank names are dropped rather than guessed
 * at. */
function parseSectionNames(stdout: string): string[] {
	try {
		const parsed = JSON.parse(stdout) as { data?: { results?: Array<{ name?: unknown }> } | Array<{ name?: unknown }> };
		const raw = parsed?.data;
		const list = Array.isArray(raw) ? raw : (raw?.results ?? []);
		return list.filter((s): s is { name: string } => typeof s?.name === "string" && s.name.length > 0).map((s) => s.name);
	} catch {
		return [];
	}
}

/** Build a Todoist client that creates tasks via the Composio CLI. Returns the
 * shared NOOP when disabled or no `exec` was supplied (mirrors createTelemetry).
 * `createTask` never throws: a nonzero exit, a thrown `exec`, or an
 * unparseable response all resolve to `null`. */
export function createTodoist(opts: { enabled: boolean; exec?: Exec; debug?: boolean }): Todoist {
	if (!opts.enabled || !opts.exec) return NOOP;
	const exec = opts.exec;
	const buffer: Op[] = [];
	const enqueue = (tool: string, params: Record<string, unknown>, kind?: Op["kind"]) => {
		try {
			buffer.push({ tool, params, kind });
		} catch {}
	};

	// Section id resolution, memoized per project id for a run: Todoist requires
	// a numeric section id (never a display name) for create/move. Fails soft to
	// null so a section this couldn't resolve is skipped rather than sent as a name.
	const sectionCache = new Map<string, Map<string, string>>();
	async function resolveSectionId(projectId: string, name: string): Promise<string | null> {
		let byName = sectionCache.get(projectId);
		if (!byName) {
			byName = new Map();
			try {
				const res = await composioExec(exec, "TODOIST_LIST_SECTIONS", { project_id: projectId });
				if (res.code === 0) for (const s of parseNamedList(res.stdout)) byName.set(s.name.toLowerCase(), s.id);
			} catch {}
			sectionCache.set(projectId, byName);
		}
		return byName.get(name.toLowerCase()) ?? null;
	}

	// A move enqueues the section NAME (transitionPhase is synchronous and cannot
	// resolve); flush resolves it to an id here and sends section_id ONLY.
	// TODOIST_MOVE_TASK_REST_API is Composio's recommended, non-deprecated move
	// tool (TODOIST_MOVE_TASK is documented to return HTTP 410 Gone on
	// deprecation); it requires at least one of project_id/section_id/parent_id.
	async function runMove(p: Record<string, unknown>): Promise<void> {
		const sectionId = await resolveSectionId(String(p.project), String(p.section));
		if (!sectionId) {
			if (opts.debug) console.error(`[slice-flow todoist] move skipped: no section id for "${String(p.section)}"`);
			return;
		}
		const res = await composioExec(exec, "TODOIST_MOVE_TASK_REST_API", { task_id: p.task_id, section_id: sectionId });
		if (res.code !== 0 && opts.debug) console.error("[slice-flow todoist] move failed:", res.stderr || res.stdout);
	}

	// Todoist cannot fetch a local path, so an attach is upload-then-comment:
	// upload the file to obtain a hosted file_url + metadata, then create the file
	// comment referencing that url. A failed/incomplete upload skips the comment.
	async function runAttach(p: Record<string, unknown>): Promise<void> {
		const filePath = String(p.filePath);
		const up = await composioExec(exec, "TODOIST_UPLOAD_FILE", {}, filePath);
		if (up.code !== 0) {
			if (opts.debug) console.error("[slice-flow todoist] upload failed:", up.stderr || up.stdout);
			return;
		}
		const att = parseUpload(up.stdout);
		if (!att) {
			if (opts.debug) console.error("[slice-flow todoist] upload returned no file_url; skipping attachment");
			return;
		}
		await composioExec(exec, "TODOIST_CREATE_COMMENT_V1", { task_id: p.task_id, content: `Attached: ${att.file_name ?? basename(filePath)}`, attachment: att });
	}

	// Todoist's labels field REPLACES the whole list and silently ignores unknown
	// names, so a stopped label is applied as read-modify-write: read the task's
	// current labels, no-op if already present, otherwise ensure the label exists
	// (a duplicate-name create fails soft) and update with the union.
	async function runLabel(p: Record<string, unknown>): Promise<void> {
		const taskId = String(p.task_id);
		const label = String(p.label);
		const current = await currentLabels(taskId);
		if (current.includes(label)) return;
		await composioExec(exec, "TODOIST_CREATE_LABEL_V1", { name: label });
		const res = await composioExec(exec, "TODOIST_UPDATE_TASK", { task_id: taskId, labels: [...current, label] });
		if (res.code !== 0 && opts.debug) console.error("[slice-flow todoist] label update failed:", res.stderr || res.stdout);
	}

	async function currentLabels(taskId: string): Promise<string[]> {
		try {
			const res = await composioExec(exec, "TODOIST_GET_TASK2", { task_id: taskId });
			if (res.code !== 0) return [];
			const parsed = JSON.parse(res.stdout) as { data?: { labels?: unknown; task?: { labels?: unknown } } };
			const labels = parsed?.data?.task?.labels ?? parsed?.data?.labels;
			return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
		} catch {
			return [];
		}
	}

	return {
		enabled: true,
		async listProjects() {
			try {
				const res = await composioExec(exec, "TODOIST_GET_ALL_PROJECTS", {});
				if (res.code !== 0) {
					if (opts.debug) console.error("[slice-flow todoist] listProjects failed:", res.stderr || res.stdout);
					return [];
				}
				return parseNamedList(res.stdout);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] listProjects threw:", e);
				return [];
			}
		},
		async createTask(a) {
			try {
				const params: Record<string, unknown> = { content: a.content, project_id: a.project };
				if (a.section) {
					const sectionId = await resolveSectionId(a.project, a.section);
					if (sectionId) params.section_id = sectionId;
				}
				const res = await composioExec(exec, "TODOIST_CREATE_TASK", params);
				if (res.code !== 0) {
					if (opts.debug) console.error("[slice-flow todoist] create failed:", res.stderr || res.stdout);
					return null;
				}
				return parseTaskId(res.stdout);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] create threw:", e);
				return null;
			}
		},
		// Confirmed via `composio tools info`: TODOIST_GET_TASK2 takes task_id and
		// returns a single task (used here as an id lookup); TODOIST_FILTER_TASKS
		// takes a `query` in Todoist filter syntax, with `search: <text>` as the
		// free-text form, used as the name-search fallback when the id lookup
		// fails. Neither success envelope was confirmed live (see parseFoundTask);
		// a wrong guess degrades to a fail-soft null, matching every other method.
		async findTask(query) {
			try {
				const byId = await composioExec(exec, "TODOIST_GET_TASK2", { task_id: query });
				if (byId.code === 0) {
					const found = parseFoundTask(byId.stdout);
					if (found) return found;
				}
				const bySearch = await composioExec(exec, "TODOIST_FILTER_TASKS", { query: `search: ${query}` });
				if (bySearch.code !== 0) {
					if (opts.debug) console.error("[slice-flow todoist] findTask search failed:", bySearch.stderr || bySearch.stdout);
					return null;
				}
				return parseFoundTask(bySearch.stdout);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] findTask threw:", e);
				return null;
			}
		},
		// Confirmed: TODOIST_GET_TASK2 returns content/description on the task;
		// TODOIST_GET_ALL_COMMENTS (mutually exclusive task_id/project_id, task_id
		// used here) returns the task's comments. Any failure at either step fails
		// soft to empty fields/array rather than a partial throw.
		async taskContext(taskId) {
			try {
				const taskRes = await composioExec(exec, "TODOIST_GET_TASK2", { task_id: taskId });
				if (taskRes.code !== 0) {
					if (opts.debug) console.error("[slice-flow todoist] taskContext fetch failed:", taskRes.stderr || taskRes.stdout);
					return { content: "", description: "", comments: [] };
				}
				let content = "";
				let description = "";
				try {
					const parsed = JSON.parse(taskRes.stdout) as { data?: { content?: unknown; description?: unknown; task?: { content?: unknown; description?: unknown } } };
					const task = parsed?.data?.task ?? parsed?.data;
					if (typeof task?.content === "string") content = task.content;
					if (typeof task?.description === "string") description = task.description;
				} catch {}
				const commentsRes = await composioExec(exec, "TODOIST_GET_ALL_COMMENTS", { task_id: taskId });
				const comments = commentsRes.code === 0 ? parseComments(commentsRes.stdout) : [];
				return { content, description, comments };
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] taskContext threw:", e);
				return { content: "", description: "", comments: [] };
			}
		},
		// Confirmed via `composio tools info`: neither Todoist list tool takes a
		// project_id — project scoping uses Todoist filter syntax (`#ProjectName`),
		// so this takes the project's display NAME. TODOIST_FILTER_TASKS returns
		// active tasks only (first page, default 50 — plenty for a picker). Fails
		// soft to [] on any failure, matching every other lookup here.
		async listTasks(projectName) {
			try {
				const res = await composioExec(exec, "TODOIST_FILTER_TASKS", { query: `#${projectName}` });
				if (res.code !== 0) {
					if (opts.debug) console.error("[slice-flow todoist] listTasks failed:", res.stderr || res.stdout);
					return [];
				}
				return parseTaskList(res.stdout);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] listTasks threw:", e);
				return [];
			}
		},
		// Confirmed via `composio tools info`: TODOIST_LIST_SECTIONS takes an
		// optional project_id filter and returns the section names for that
		// project. Used by setupTodoistStart's adopt branch to decide whether an
		// adopted task's project already shows the board convention. Fails soft to
		// [] on a nonzero exit or a thrown exec — a project we couldn't read is
		// never restructured.
		async listSections(project) {
			try {
				const res = await composioExec(exec, "TODOIST_LIST_SECTIONS", { project_id: project });
				if (res.code !== 0) {
					if (opts.debug) console.error("[slice-flow todoist] listSections failed:", res.stderr || res.stdout);
					return [];
				}
				return parseSectionNames(res.stdout);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] listSections threw:", e);
				return [];
			}
		},
		// Confirmed: TODOIST_CREATE_SECTION_V1 (the current, non-deprecated create-
		// section op — TODOIST_CREATE_SECTION is marked deprecated in favor of this
		// one) takes project_id + name. Awaited immediate op (not buffered) so the
		// adopt-branch reconciliation loop can create only the sections actually
		// missing before setupTodoistStart returns. Never throws; a failed create
		// leaves that section missing but does not block the run.
		async createSection(project, name) {
			// TODOIST_CREATE_SECTION_V1 only accepts new-format alphanumeric v1 project
			// IDs; its schema states legacy numeric project IDs are not supported by
			// the v1 API. Skip fail-soft rather than send a request the tool documents
			// it will reject. The adopt path sources this id from the v1-API
			// TODOIST_GET_TASK2/TODOIST_FILTER_TASKS (which return v1 ids), so this
			// guard only trips on a legacy-numeric id that could not be used anyway —
			// the project then keeps whatever sections it has (comment-only downstream).
			if (/^\d+$/.test(project)) {
				if (opts.debug) console.error(`[slice-flow todoist] createSection skipped: legacy-format project id "${project}" not supported by TODOIST_CREATE_SECTION_V1`);
				return;
			}
			try {
				const res = await composioExec(exec, "TODOIST_CREATE_SECTION_V1", { project_id: project, name });
				if (res.code !== 0 && opts.debug) console.error("[slice-flow todoist] createSection failed:", res.stderr || res.stdout);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] createSection threw:", e);
			}
		},
		// A section-changing move. `project` is a project id and `section` a section
		// NAME; flush resolves the name to a section id and moves with section_id
		// only via TODOIST_MOVE_TASK_REST_API (the non-deprecated move tool).
		move(taskId, project, section) {
			enqueue("TODOIST_MOVE_TASK_REST_API", { task_id: taskId, project, section }, "move");
		},
		// Confirmed: TODOIST_CREATE_COMMENT_V1 takes content + task_id.
		comment(taskId, text) {
			enqueue("TODOIST_CREATE_COMMENT_V1", { task_id: taskId, content: text });
		},
		// A file comment: flush uploads the local file (TODOIST_UPLOAD_FILE) to get
		// a hosted file_url, then creates the comment with that attachment. See
		// runAttach above.
		attach(taskId, filePath) {
			enqueue("TODOIST_UPLOAD_FILE", { task_id: taskId, filePath }, "attach");
		},
		// Confirmed: TODOIST_CLOSE_TASK_V1 takes only task_id.
		close(taskId) {
			enqueue("TODOIST_CLOSE_TASK_V1", { task_id: taskId });
		},
		// A non-destructive label add: flush reads the task's current labels and
		// applies their union with `label` (ensuring the label exists first). See
		// runLabel above.
		label(taskId, label) {
			enqueue("TODOIST_UPDATE_TASK", { task_id: taskId, label }, "label");
		},
		async flush() {
			const ops = buffer.splice(0, buffer.length);
			for (const op of ops) {
				try {
					if (op.kind === "move") await runMove(op.params);
					else if (op.kind === "attach") await runAttach(op.params);
					else if (op.kind === "label") await runLabel(op.params);
					else await composioExec(exec, op.tool, op.params);
				} catch (e) {
					if (opts.debug) console.error("[slice-flow todoist] op failed:", e);
				}
			}
		},
	};
}

let singleton: Todoist | null = null;

/** The process-wide Todoist client. Memoized so the same client (and its
 * captured `exec`) is reused across a run; the first call's `exec` wins.
 * No-op unless `cfg.todoist.enabled` is true. */
export function getTodoist(cfg: SliceFlowConfig, exec?: Exec): Todoist {
	if (singleton) return singleton;
	const enabled = cfg.todoist?.enabled === true;
	singleton = createTodoist({ enabled, exec, debug: cfg.todoist?.debug });
	return singleton;
}

/** Test/seam hook: drop the memoized client so the next getTodoist re-reads
 * config/exec (mirrors resetTelemetry). */
export function resetTodoist(): void {
	singleton = null;
}
