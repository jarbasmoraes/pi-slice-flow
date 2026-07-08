import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { startWorkflow } from "../extensions/lib/engine.ts";
import { loadState, workPaths } from "../extensions/lib/workspace.ts";

/** Run startWorkflow on a throwaway cwd, optionally with a resolved todoist
 * result threaded through (mirrors codegraph-startworkflow.test.js). */
function runStart(todoist) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-todoist-start-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	startWorkflow(p, DEFAULT_CONFIG, "Feat", "feat", "base123", cwd, "silent", undefined, ["claude"], todoist);
	return loadState(p);
}

test("startWorkflow persists state.todoist when a resolved todoist result is passed (criterion 1, 12)", () => {
	const state = runStart({ taskId: "42", project: "MyProj", sectionMode: "sections" });
	assert.deepEqual(state.todoist, { taskId: "42", project: "MyProj", sectionMode: "sections", attachedFrame: false, attachedArch: false });
});

test("startWorkflow leaves state.todoist undefined when no todoist result is passed", () => {
	const state = runStart(undefined);
	assert.equal(state.todoist, undefined);
});
