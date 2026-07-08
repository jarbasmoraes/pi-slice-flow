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

const BOARD_WITH_IDS = ["Frame", "Architect", "Plan", "Build", "Review", "Simplify", "Ship"].map((name) => ({ id: `sec-${name}`, name }));

/** Records every exec invocation; answers TODOIST_LIST_SECTIONS (section id
 * resolution for moves) and defaults everything else to canned success. */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		if (handler) {
			const r = handler(cmd, args, opts);
			if (r) return r;
		}
		if (args[1] === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: BOARD_WITH_IDS } }), stderr: "" };
		return { code: 0, stdout: "{}", stderr: "" };
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
	const move = records.find((r) => r.args[1] === "TODOIST_MOVE_TASK");
	const comment = records.find((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1");
	const close = records.find((r) => r.args[1] === "TODOIST_CLOSE_TASK_V1");
	assert.ok(move && comment && close, "move + comment + close all issued");
	assert.equal(JSON.parse(move.args[3]).section_id, "sec-Ship", "moved to the resolved Ship section id");
	// The move is enqueued before the close, so it drains first.
	assert.ok(records.indexOf(move) < records.indexOf(close), "the move precedes the close");
	assert.equal(JSON.parse(close.args[3]).task_id, "t1");
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
	assert.ok(!records.some((r) => r.args[1] === "TODOIST_MOVE_TASK"), "no move when stopping");
	const update = records.find((r) => r.args[1] === "TODOIST_UPDATE_TASK");
	assert.ok(update, "the stopped label is applied via an update");
	const labelParams = JSON.parse(update.args[3]);
	assert.equal(labelParams.task_id, "t1");
	assert.deepEqual(labelParams.labels, ["stopped"], "applies stopped when the task had no labels");
	const comment = records.find((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1");
	assert.ok(comment, "a comment with the reason is added");
	assert.match(JSON.parse(comment.args[3]).content, /^Stopped: user aborted at verify completion gate$/);
});

test("stopped appends the stopped label WITHOUT clobbering existing labels and ensures the label exists", async () => {
	const records = [];
	const { p, state } = setup("stopped-append-label");
	state.phase = "verify";
	state.todoist = { taskId: "t1", project: "P", sectionMode: "sections" };
	const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };
	getTodoist(
		cfg,
		fakeExec(records, (cmd, args) => (args[1] === "TODOIST_GET_TASK2" ? { code: 0, stdout: JSON.stringify({ data: { labels: ["urgent", "client"] } }), stderr: "" } : null)),
	);

	stopped(p, state, "user aborted", cfg);
	await getTodoist(cfg).flush();

	assert.ok(
		records.some((r) => r.args[1] === "TODOIST_CREATE_LABEL_V1" && JSON.parse(r.args[3]).name === "stopped"),
		"ensures the stopped label exists before applying it (Todoist ignores unknown label names)",
	);
	const update = records.find((r) => r.args[1] === "TODOIST_UPDATE_TASK");
	assert.deepEqual(JSON.parse(update.args[3]).labels, ["urgent", "client", "stopped"], "existing labels are preserved, not replaced");
});

test("stopped does not re-apply the label when the task already carries it", async () => {
	const records = [];
	const { p, state } = setup("stopped-already-labeled");
	state.phase = "verify";
	state.todoist = { taskId: "t1", project: "P", sectionMode: "sections" };
	const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };
	getTodoist(
		cfg,
		fakeExec(records, (cmd, args) => (args[1] === "TODOIST_GET_TASK2" ? { code: 0, stdout: JSON.stringify({ data: { labels: ["stopped"] } }), stderr: "" } : null)),
	);

	stopped(p, state, "user aborted", cfg);
	await getTodoist(cfg).flush();

	assert.ok(!records.some((r) => r.args[1] === "TODOIST_UPDATE_TASK"), "no redundant label update when stopped is already present");
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
