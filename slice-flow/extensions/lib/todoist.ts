/**
 * The single module that talks to Todoist, via the Composio CLI (`composio
 * execute TODOIST_*`). Modeled on telemetry.ts: no SDK, an injected transport
 * (here `Exec` rather than `fetch`), and every method fail-soft — a disabled
 * flag, a missing `exec`, or a dead/failing CLI degrades to `null`/no-op and
 * never throws into the workflow.
 *
 * Slice 001: task creation. Slice 003 (this slice): a buffered, fail-soft
 * `move`/`comment` transport — synchronous enqueue methods append to an
 * in-memory buffer; `flush()` drains it over the Composio CLI in order,
 * catching every error. Nothing is enqueued yet (callers arrive in slices
 * 004-006); `attach`/`close`/`label` also arrive later.
 */

import type { SliceFlowConfig } from "./config.ts";
import type { Exec } from "./worktree.ts";

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
