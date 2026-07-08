import { test } from "node:test";
import assert from "node:assert/strict";

import { setupTodoistStart, transitionPhase } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState } from "../extensions/lib/workspace.ts";
import { resetTodoist, getTodoist } from "../extensions/lib/todoist.ts";

const ALL_SECTIONS = ["Frame", "Architect", "Plan", "Build", "Review", "Simplify", "Ship"];

function fakeCtx({ input = async () => "7" } = {}) {
	return {
		hasUI: true,
		ui: {
			input: async (title, placeholder) => input(title, placeholder),
			notify() {},
			select: async () => "Adopt an existing Todoist task",
			confirm: async () => false,
		},
	};
}

/** Answers the adopt-branch lookups (find/context) plus TODOIST_LIST_SECTIONS
 * and TODOIST_CREATE_SECTION_V1, with `sections` controlling what the fake
 * project already has. */
function fakeExec(records, { taskId = "7", project = "99", sections = ALL_SECTIONS } = {}) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		const tool = args[1];
		if (tool === "TODOIST_GET_TASK2") {
			return { code: 0, stdout: JSON.stringify({ data: { id: taskId, project_id: project, content: "Fix the bug", description: "" } }), stderr: "" };
		}
		if (tool === "TODOIST_GET_ALL_COMMENTS") return { code: 0, stdout: JSON.stringify({ data: { comments: [] } }), stderr: "" };
		if (tool === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: sections.map((name) => ({ name })) } }), stderr: "" };
		if (tool === "TODOIST_CREATE_SECTION_V1") return { code: 0, stdout: "{}", stderr: "" };
		return { code: 1, stdout: "", stderr: "unexpected tool" };
	};
}

const enabledCfg = { todoist: { enabled: true } };

test.beforeEach(() => {
	resetTodoist();
});

// --- setupTodoistStart adopt-branch reconciliation (criteria 16, 17) --------

test("full convention present: no createSection calls, sectionMode is sections", async () => {
	const records = [];
	const ctx = fakeCtx();
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records, { sections: ALL_SECTIONS }), "Feature X");
	assert.equal(result.sectionMode, "sections");
	assert.ok(!records.some((r) => r.args[1] === "TODOIST_CREATE_SECTION_V1"), "no createSection calls when nothing is missing");
});

test("partial convention present: createSection only for the missing sections, sectionMode is sections", async () => {
	const records = [];
	const ctx = fakeCtx();
	const present = ["Frame", "Plan", "Ship"];
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records, { sections: present }), "Feature X");
	assert.equal(result.sectionMode, "sections");
	const created = records.filter((r) => r.args[1] === "TODOIST_CREATE_SECTION_V1").map((r) => JSON.parse(r.args[3]).name);
	assert.deepEqual(created, ["Architect", "Build", "Review", "Simplify"], "creates only the missing sections, in board order");
});

test("no convention present: zero createSection calls, sectionMode is comment-only", async () => {
	const records = [];
	const ctx = fakeCtx();
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records, { sections: [] }), "Feature X");
	assert.equal(result.sectionMode, "comment-only");
	assert.ok(!records.some((r) => r.args[1] === "TODOIST_CREATE_SECTION_V1"), "no createSection calls when there is no convention to reconcile");
});

test("unrelated project sections (e.g. an Inbox list-view project) count as no convention: comment-only", async () => {
	const records = [];
	const ctx = fakeCtx();
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records, { sections: ["Groceries", "Errands"] }), "Feature X");
	assert.equal(result.sectionMode, "comment-only");
});

test("listSections failing soft to [] (nonzero exit) yields comment-only", async () => {
	const records = [];
	const ctx = fakeCtx();
	const exec = async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		const tool = args[1];
		if (tool === "TODOIST_GET_TASK2") return { code: 0, stdout: JSON.stringify({ data: { id: "7", project_id: "99", content: "x", description: "" } }), stderr: "" };
		if (tool === "TODOIST_GET_ALL_COMMENTS") return { code: 0, stdout: JSON.stringify({ data: { comments: [] } }), stderr: "" };
		if (tool === "TODOIST_LIST_SECTIONS") return { code: 1, stdout: "", stderr: "not linked" };
		return { code: 1, stdout: "", stderr: "unexpected" };
	};
	const result = await setupTodoistStart(ctx, enabledCfg, exec, "Feature X");
	assert.equal(result.sectionMode, "comment-only");
	assert.ok(!records.some((r) => r.args[1] === "TODOIST_CREATE_SECTION_V1"));
});

// --- transitionPhase comment-only branch (criterion 17 behavior) -----------

const cfg = { ...DEFAULT_CONFIG, todoist: { enabled: true } };

test("comment-only run: a section-changing transition enqueues a comment and no move", async () => {
	const records = [];
	getTodoist(cfg, async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		return { code: 0, stdout: "{}", stderr: "" };
	});
	const state = createState("feat", "feat", "base123");
	state.phase = "plan";
	state.todoist = { taskId: "t1", project: "P", sectionMode: "comment-only" };

	transitionPhase(state, "implement", "plan approved", cfg);
	assert.equal(state.phase, "implement");

	await getTodoist(cfg).flush();
	assert.equal(records.length, 1, "exactly one comment, no move");
	assert.equal(records[0].args[1], "TODOIST_CREATE_COMMENT_V1");
	const params = JSON.parse(records[0].args[3]);
	assert.equal(params.task_id, "t1");
	assert.match(params.content, /implement: plan approved/);
});

test("sections-mode run still behaves exactly as slice 004: move (resolved section id) + comment on a section change (regression guard)", async () => {
	const records = [];
	getTodoist(cfg, async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		if (args[1] === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: [{ id: "sec-Build", name: "Build" }] } }), stderr: "" };
		return { code: 0, stdout: "{}", stderr: "" };
	});
	const state = createState("feat", "feat", "base123");
	state.phase = "plan";
	state.todoist = { taskId: "t1", project: "P", sectionMode: "sections" };

	transitionPhase(state, "implement", "plan approved", cfg);

	await getTodoist(cfg).flush();
	const move = records.find((r) => r.args[1] === "TODOIST_MOVE_TASK");
	const comment = records.find((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1");
	assert.ok(move && comment, "one move + one comment");
	assert.equal(JSON.parse(move.args[3]).section_id, "sec-Build", "the Build section name resolved to its id");
});
