/**
 * The single tracked-task record. simple-flow tracks at most one active
 * Todoist task at a time; `save` always overwrites, so there is never more
 * than one record on disk.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TrackedTask {
	taskId: string;
	project: string;
	content: string;
}

const file = (cwd: string) => join(cwd, ".simple-flow", "state.json");

/** Returns the tracked task, or null when none is tracked or the file is
 * missing/corrupt. */
export function load(cwd: string): TrackedTask | null {
	try {
		return JSON.parse(readFileSync(file(cwd), "utf8")) as TrackedTask;
	} catch {
		return null;
	}
}

/** Persists the tracked task, overwriting any prior record. */
export function save(cwd: string, t: TrackedTask): void {
	mkdirSync(dirname(file(cwd)), { recursive: true });
	writeFileSync(file(cwd), JSON.stringify(t, null, 2));
}

/** Drops the tracked task, if any. */
export function clear(cwd: string): void {
	rmSync(file(cwd), { force: true });
}
