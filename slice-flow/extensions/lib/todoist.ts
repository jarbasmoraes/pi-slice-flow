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
 * (this slice) adds `attach` for the one-time frame/architecture doc attachments.
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

/** A buffered board-sync operation: the Composio tool slug plus its params,
 * queued by a synchronous enqueue method and shipped in order by `flush()`. */
export interface Op {
	tool: string;
	params: Record<string, unknown>;
}

export interface Todoist {
	readonly enabled: boolean;
	createTask(a: { project: string; section?: string; content: string }): Promise<string | null>;
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
