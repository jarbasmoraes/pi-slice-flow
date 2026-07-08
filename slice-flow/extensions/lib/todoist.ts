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
 * before deciding `sectionMode`.
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
 * queued by a synchronous enqueue method and shipped in order by `flush()`. */
export interface Op {
	tool: string;
	params: Record<string, unknown>;
}

export interface Todoist {
	readonly enabled: boolean;
	createTask(a: { project: string; section?: string; content: string }): Promise<string | null>;
	/** Awaited, immediate lookup (not buffered): finds a task by name or id.
	 * Tries an id lookup first, falls back to a text search; returns null when
	 * nothing matches or on any failure. */
	findTask(query: string): Promise<{ taskId: string; project: string } | null>;
	/** Awaited, immediate lookup (not buffered): the task's content, description,
	 * and existing comments, used to seed an adopted run's feature description.
	 * Fails soft to empty strings/array on any failure. */
	taskContext(taskId: string): Promise<{ content: string; description: string; comments: string[] }>;
	/** Awaited, immediate lookup (not buffered): the section names present in a
	 * project. Fails soft to an empty array on any failure — never restructures
	 * a project this couldn't read. */
	listSections(project: string): Promise<string[]>;
	/** Awaited, immediate op (not buffered): creates one section in a project.
	 * Fails soft (never throws) on any failure. */
	createSection(project: string, name: string): Promise<void>;
	/** Synchronous, fail-soft enqueue: appends to the in-memory op buffer. Never
	 * throws (a full/misbehaving buffer is swallowed, mirroring every other
	 * method on this client). Nothing is enqueued by this slice's callers yet. */
	move(taskId: string, project: string, section: string): void;
	/** Synchronous, fail-soft enqueue: see `move`. */
	comment(taskId: string, text: string): void;
	/** Synchronous, fail-soft enqueue: attaches a file as a Todoist "file comment"
	 * via TODOIST_CREATE_COMMENT_V1's `attachment` param (see the implementation
	 * note on `attach` below for the known file_url-vs-local-path caveat). See
	 * `move`. */
	attach(taskId: string, filePath: string): void;
	/** Synchronous, fail-soft enqueue: marks the task complete via
	 * TODOIST_CLOSE_TASK_V1. See `move`. */
	close(taskId: string): void;
	/** Synchronous, fail-soft enqueue: appends the `stopped` label via a
	 * TODOIST_UPDATE_TASK labels-replace op (see the implementation note on
	 * `label` below for the known replace-vs-append caveat). See `move`. */
	label(taskId: string, label: string): void;
	/** Drains the op buffer over the Composio CLI, in insertion order, catching
	 * every per-op error. Always resolves, even when every op throws. */
	flush(): Promise<void>;
}

export const NOOP: Todoist = {
	enabled: false,
	async createTask() {
		return null;
	},
	async findTask() {
		return null;
	},
	async taskContext() {
		return { content: "", description: "", comments: [] };
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
async function composioExec(exec: Exec, tool: string, params: Record<string, unknown>): Promise<{ code: number; stdout: string; stderr: string }> {
	return exec("composio", ["execute", tool, "-d", JSON.stringify(params)], { timeout: 5000 });
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
	const enqueue = (tool: string, params: Record<string, unknown>) => {
		try {
			buffer.push({ tool, params });
		} catch {}
	};
	return {
		enabled: true,
		async createTask(a) {
			try {
				const params: Record<string, unknown> = { content: a.content, project_id: a.project };
				if (a.section) params.section_id = a.section;
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
			try {
				const res = await composioExec(exec, "TODOIST_CREATE_SECTION_V1", { project_id: project, name });
				if (res.code !== 0 && opts.debug) console.error("[slice-flow todoist] createSection failed:", res.stderr || res.stdout);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow todoist] createSection threw:", e);
			}
		},
		// Confirmed against the installed Composio CLI (search + tools info):
		// TODOIST_MOVE_TASK takes task_id plus exactly one of project_id/
		// section_id/parent_id. This slice's contract fixes the move(taskId,
		// project, section) signature; passing both project_id and section_id
		// together will be rejected by a live Composio call (fails soft, caught
		// in flush below) — resolving that mutual-exclusivity is out of scope
		// here since nothing calls move() until slices 004-006 (see memo).
		move(taskId, project, section) {
			enqueue("TODOIST_MOVE_TASK", { task_id: taskId, project_id: project, section_id: section });
		},
		// Confirmed: TODOIST_CREATE_COMMENT_V1 takes content + task_id.
		comment(taskId, text) {
			enqueue("TODOIST_CREATE_COMMENT_V1", { task_id: taskId, content: text });
		},
		// Confirmed via `composio search "attach file" --toolkits todoist`: a
		// Todoist "file comment" is TODOIST_CREATE_COMMENT_V1 with an `attachment`
		// object, per the tool's own schema (attachment.file_url/file_name). The
		// real flow the CLI's own recommended plan describes is two calls
		// (TODOIST_UPLOAD_FILE to get a hosted file_url, then this comment with
		// that url) — this slice's contract fixes attach(taskId, filePath) as one
		// synchronous, single-op enqueue, so `filePath` (a local run-artifact path,
		// not an uploaded URL) is passed straight through as `attachment.file_url`.
		// A live call will very likely reject this (or accept it but render an
		// unreachable link) since Todoist cannot fetch a local path; this fails
		// soft like every other guessed param shape in this client (swallowed in
		// flush below). See the memo for the fix (upload-then-comment chaining)
		// this slice deliberately does not build.
		attach(taskId, filePath) {
			enqueue("TODOIST_CREATE_COMMENT_V1", {
				task_id: taskId,
				content: `Attached: ${basename(filePath)}`,
				attachment: { file_url: filePath, file_name: basename(filePath) },
			});
		},
		// Confirmed: TODOIST_CLOSE_TASK_V1 takes only task_id.
		close(taskId) {
			enqueue("TODOIST_CLOSE_TASK_V1", { task_id: taskId });
		},
		// Confirmed: TODOIST_UPDATE_TASK's `labels` field is a full-replace, not an
		// append ("Replaces the entire existing labels list") — there is no
		// dedicated add-a-label-to-a-task op. This client never fetches the
		// task's current labels first (no read-modify-write here), so this call
		// sets the task's labels to exactly `[label]`, which will drop any other
		// labels already on the task rather than appending to them. Fails soft
		// like every other op (a live rejection is swallowed in flush below);
		// see the memo for the same caveat pattern as move()'s mutual-exclusivity
		// note.
		label(taskId, label) {
			enqueue("TODOIST_UPDATE_TASK", { task_id: taskId, labels: [label] });
		},
		async flush() {
			const ops = buffer.splice(0, buffer.length);
			for (const op of ops) {
				try {
					await composioExec(exec, op.tool, op.params);
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
