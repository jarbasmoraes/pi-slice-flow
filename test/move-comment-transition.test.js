import { test } from "node:test";
import assert from "node:assert/strict";

import { transitionPhase } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState } from "../extensions/lib/workspace.ts";
import { resetTodoist, getTodoist } from "../extensions/lib/todoist.ts";

/** Records every exec invocation; returns canned success output. */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		return handler ? handler(cmd, args, opts) : { code: 0, stdout: "{}", stderr: "" };
	};
}

function setup(phase) {
	const state = createState("feat", "feat", "base123");
	state.phase = phase;
	state.todoist = { taskId: "t1", project: "P", sectionMode: "sections" };
	return state;
}

const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };

test.beforeEach(() => {
	resetTodoist();
});

// --- Section-changing transitions enqueue exactly one move + one comment -----

test("frame -> architect enqueues a move to Architect and a comment with the reason", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records)); // prime memoized singleton with the capturing exec seam
	const state = setup("frame");

	transitionPhase(state, "architect", "frame approved", cfg);
	assert.equal(state.phase, "architect");

	await getTodoist(cfg).flush();
	assert.equal(records.length, 2, "exactly one move + one comment");
	assert.equal(records[0].args[1], "TODOIST_MOVE_TASK");
	const moveParams = JSON.parse(records[0].args[3]);
	assert.equal(moveParams.task_id, "t1");
	assert.equal(moveParams.section_id, "Architect");
	assert.equal(records[1].args[1], "TODOIST_CREATE_COMMENT_V1");
	const commentParams = JSON.parse(records[1].args[3]);
	assert.equal(commentParams.task_id, "t1");
	assert.match(commentParams.content, /Moved to Architect: frame approved/);
});

test("plan -> implement enqueues a move to Build", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = setup("plan");

	transitionPhase(state, "implement", "plan approved", cfg);

	await getTodoist(cfg).flush();
	assert.equal(records.length, 2);
	const moveParams = JSON.parse(records[0].args[3]);
	assert.equal(moveParams.section_id, "Build");
});

test("verify -> loop enqueues a move to Simplify carrying the failed-dimensions reason", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = setup("verify");

	transitionPhase(state, "loop", "code-quality, security", cfg);

	await getTodoist(cfg).flush();
	const commentParams = JSON.parse(records[1].args[3]);
	assert.match(commentParams.content, /Moved to Simplify: code-quality, security/);
});

test("verify -> done enqueues a move to Ship", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = setup("verify");

	transitionPhase(state, "done", "clean verification pass", cfg);

	await getTodoist(cfg).flush();
	const moveParams = JSON.parse(records[0].args[3]);
	assert.equal(moveParams.section_id, "Ship");
});

// --- Same-section transitions enqueue nothing (criterion 3 anchor case) ------

test("architect -> prototype enqueues nothing (both map to Architect)", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = setup("architect");

	transitionPhase(state, "prototype", "architecture approved; greenfield prototyping", cfg);

	await getTodoist(cfg).flush();
	assert.equal(records.length, 0, "no move and no comment when the mapped section is unchanged");
});

// --- No state.todoist: enqueues nothing, behaves exactly as before -----------

test("a run with no state.todoist enqueues nothing", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = createState("feat", "feat", "base123");
	state.phase = "frame";

	transitionPhase(state, "architect", "frame approved", cfg);
	assert.equal(state.phase, "architect");

	await getTodoist(cfg).flush();
	assert.equal(records.length, 0);
});

// --- Fail-soft: a throwing transport never blocks the transition ------------

test("a throwing transport still advances state.phase and does not throw out of transitionPhase", () => {
	getTodoist(cfg, async () => {
		throw new Error("spawn failed");
	});
	const state = setup("frame");

	assert.doesNotThrow(() => transitionPhase(state, "architect", "frame approved", cfg));
	assert.equal(state.phase, "architect");
});
