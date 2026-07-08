import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextStep, stopped } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";
import { resetTodoist, getTodoist } from "../extensions/lib/todoist.ts";

const NO_UI = { hasUI: false, ui: {} };
const cfgAuto = (gateName) => ({
	...DEFAULT_CONFIG,
	todoist: { enabled: true },
	checks: { ...DEFAULT_CONFIG.checks, enabled: false },
	autonomy: { ...DEFAULT_CONFIG.autonomy, [gateName]: "auto" },
});

/** Records every exec invocation; returns canned success output. */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		return handler ? handler(cmd, args, opts) : { code: 0, stdout: "{}", stderr: "" };
	};
}

function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), `slice-flow-${slug}-`));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	return { p, state: createState("feat", "feat", "base123") };
}

test.beforeEach(() => {
	resetTodoist();
});

// --- done: close after move -------------------------------------------------

test("a clean verification pass enqueues a move to Ship then a close, in order", async () => {
	const records = [];
	const { p, state } = setup("done-close");
	for (const dim of ["code-quality", "simplicity", "security", "evals", "tests"]) {
		writeFileSync(join(p.verify, `${dim}.md`), "VERDICT: PASS\n");
	}
	state.phase = "verify";
	state.pending = { kind: "verify", seq: 0, label: "Phase 5 — VERIFY", args: {} };
	state.todoist = { taskId: "t1", project: "P", sectionMode: "sections" };
	const cfg = cfgAuto("verify");

	const out = await nextStep(NO_UI, p, cfg, state, fakeExec(records));
	assert.equal(state.phase, "done");
	assert.match(out, /COMPLETE/);

	await getTodoist(cfg).flush();
	assert.equal(records.length, 3, "move + comment + close");
	assert.equal(records[0].args[1], "TODOIST_MOVE_TASK");
	assert.equal(records[1].args[1], "TODOIST_CREATE_COMMENT_V1");
	assert.equal(records[2].args[1], "TODOIST_CLOSE_TASK_V1");
	const closeParams = JSON.parse(records[2].args[3]);
	assert.equal(closeParams.task_id, "t1");
});

test("reaching done with no state.todoist enqueues nothing", async () => {
	const records = [];
	const { p, state } = setup("done-no-todoist");
	for (const dim of ["code-quality", "simplicity", "security", "evals", "tests"]) {
		writeFileSync(join(p.verify, `${dim}.md`), "VERDICT: PASS\n");
	}
	state.phase = "verify";
	state.pending = { kind: "verify", seq: 0, label: "Phase 5 — VERIFY", args: {} };
	const cfg = cfgAuto("verify");

	const out = await nextStep(NO_UI, p, cfg, state, fakeExec(records));
	assert.equal(state.phase, "done");
	assert.match(out, /COMPLETE/);

	await getTodoist(cfg).flush();
	assert.equal(records.length, 0, "no todoist calls when state.todoist is absent");
});

// --- stopped: label + comment, no move --------------------------------------

test("stopped enqueues a stopped label and a comment with the reason, but no move", async () => {
	const records = [];
	const { p, state } = setup("stopped-label");
	state.phase = "verify";
	state.todoist = { taskId: "t1", project: "P", sectionMode: "sections" };
	const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };
	getTodoist(cfg, fakeExec(records));

	const out = stopped(p, state, "user aborted at verify completion gate", cfg);
	assert.match(out, /STOPPED/);
	assert.equal(state.phase, "stopped");

	await getTodoist(cfg).flush();
	assert.equal(records.length, 2, "label + comment, no move");
	assert.equal(records[0].args[1], "TODOIST_UPDATE_TASK");
	const labelParams = JSON.parse(records[0].args[3]);
	assert.equal(labelParams.task_id, "t1");
	assert.deepEqual(labelParams.labels, ["stopped"]);
	assert.equal(records[1].args[1], "TODOIST_CREATE_COMMENT_V1");
	const commentParams = JSON.parse(records[1].args[3]);
	assert.equal(commentParams.task_id, "t1");
	assert.match(commentParams.content, /^Stopped: user aborted at verify completion gate$/);
});

test("stopped with no state.todoist enqueues nothing", async () => {
	const records = [];
	const { p, state } = setup("stopped-no-todoist");
	state.phase = "verify";
	const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };
	getTodoist(cfg, fakeExec(records));

	stopped(p, state, "user aborted at verify completion gate", cfg);

	await getTodoist(cfg).flush();
	assert.equal(records.length, 0, "no todoist calls when state.todoist is absent");
});

// --- fail-soft: a throwing transport never blocks reaching done/stopped ----

test("a throwing transport does not block reaching stopped or alter the returned text", () => {
	const { p, state } = setup("stopped-throws");
	state.phase = "verify";
	state.todoist = { taskId: "t1", project: "P", sectionMode: "sections" };
	const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };
	getTodoist(cfg, async () => {
		throw new Error("spawn failed");
	});

	let out;
	assert.doesNotThrow(() => {
		out = stopped(p, state, "user aborted at verify completion gate", cfg);
	});
	assert.equal(state.phase, "stopped");
	assert.match(out, /STOPPED: user aborted at verify completion gate/);
});
