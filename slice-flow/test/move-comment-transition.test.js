import { test } from "node:test";
import assert from "node:assert/strict";

import { transitionPhase } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState } from "../extensions/lib/workspace.ts";
import { resetTodoist, getTodoist } from "../extensions/lib/todoist.ts";

/** The board sections, returned by TODOIST_LIST_SECTIONS with numeric ids so a
 * move can resolve a section NAME (e.g. "Architect") to its id ("sec-Architect")
 * exactly as the real Composio/Todoist API requires. */
const BOARD_WITH_IDS = ["Frame", "Architect", "Plan", "Build", "Review", "Simplify", "Ship"].map((name) => ({ id: `sec-${name}`, name }));

/** Records every exec invocation; answers TODOIST_LIST_SECTIONS with id/name
 * pairs and everything else with canned success output. */
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

function setup(phase) {
	const state = createState("feat", "feat", "base123");
	state.phase = phase;
	state.todoist = { taskId: "t1", project: "2203306141", sectionMode: "sections" };
	return state;
}

const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };

test.beforeEach(() => {
	resetTodoist();
});

// --- Section-changing transitions resolve the target section to an id and move
//     with section_id ONLY (project_id is mutually exclusive) ------------------

test("frame -> architect moves with the resolved section_id only and comments the reason", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records)); // prime memoized singleton with the capturing exec seam
	const state = setup("frame");

	transitionPhase(state, "architect", "frame approved", cfg);
	assert.equal(state.phase, "architect");

	await getTodoist(cfg).flush();
	const move = records.find((r) => r.args[1] === "TODOIST_MOVE_TASK");
	assert.ok(move, "issued a move");
	const moveParams = JSON.parse(move.args[3]);
	assert.equal(moveParams.task_id, "t1");
	assert.equal(moveParams.section_id, "sec-Architect", "the section name was resolved to its id");
	assert.ok(!("project_id" in moveParams), "project_id is omitted — mutually exclusive with section_id");
	const comment = records.find((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1");
	assert.ok(comment, "issued a comment");
	const commentParams = JSON.parse(comment.args[3]);
	assert.equal(commentParams.task_id, "t1");
	assert.match(commentParams.content, /Moved to Architect: frame approved/);
});

test("plan -> implement moves to the resolved Build section id", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = setup("plan");

	transitionPhase(state, "implement", "plan approved", cfg);

	await getTodoist(cfg).flush();
	const move = records.find((r) => r.args[1] === "TODOIST_MOVE_TASK");
	assert.equal(JSON.parse(move.args[3]).section_id, "sec-Build");
});

test("verify -> loop moves to Simplify carrying the failed-dimensions reason", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = setup("verify");

	transitionPhase(state, "loop", "code-quality, security", cfg);

	await getTodoist(cfg).flush();
	const comment = records.find((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1");
	assert.match(JSON.parse(comment.args[3]).content, /Moved to Simplify: code-quality, security/);
});

test("verify -> done moves to the resolved Ship section id", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const state = setup("verify");

	transitionPhase(state, "done", "clean verification pass", cfg);

	await getTodoist(cfg).flush();
	const move = records.find((r) => r.args[1] === "TODOIST_MOVE_TASK");
	assert.equal(JSON.parse(move.args[3]).section_id, "sec-Ship");
});

test("a move whose section cannot be resolved is skipped rather than sent with a name", async () => {
	const records = [];
	getTodoist(
		cfg,
		fakeExec(records, (cmd, args) => (args[1] === "TODOIST_LIST_SECTIONS" ? { code: 0, stdout: JSON.stringify({ data: { results: [] } }), stderr: "" } : null)),
	);
	const state = setup("frame");

	transitionPhase(state, "architect", "frame approved", cfg);

	await getTodoist(cfg).flush();
	assert.ok(!records.some((r) => r.args[1] === "TODOIST_MOVE_TASK"), "no move issued when the section id is unknown (never sends a name as an id)");
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
