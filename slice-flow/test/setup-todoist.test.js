import { test } from "node:test";
import assert from "node:assert/strict";

import { setupTodoistStart } from "../extensions/lib/engine.ts";
import { resetTodoist } from "../extensions/lib/todoist.ts";

/** Records every exec invocation; returns canned output (default success). */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		return handler ? handler(cmd, args, opts) : { code: 0, stdout: JSON.stringify({ data: { id: "42" } }), stderr: "" };
	};
}

function fakeCtx({ hasUI = true, input = async () => "MyProj", select = async () => "Create a new Todoist task" } = {}) {
	return {
		hasUI,
		ui: {
			input: async (title, placeholder) => input(title, placeholder),
			notify() {},
			select: async (title, options) => select(title, options),
			confirm: async () => false,
		},
	};
}

const enabledCfg = { todoist: { enabled: true } };
const disabledCfg = { todoist: { enabled: false } };

test("with hasUI false, returns null and makes no composio call regardless of cfg.todoist.enabled (criterion 13)", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx({ hasUI: false });
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records), "Feature X");
	assert.equal(result, null);
	assert.equal(records.length, 0);
	resetTodoist();
});

test("with cfg.todoist.enabled false, returns null and makes no composio call (criterion 19)", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx();
	const result = await setupTodoistStart(ctx, disabledCfg, fakeExec(records), "Feature X");
	assert.equal(result, null);
	assert.equal(records.length, 0);
	resetTodoist();
});

test("with UI and todoist enabled, prompts for a project and issues exactly one composio create call (criterion 1, 12)", async () => {
	resetTodoist();
	const records = [];
	const inputCalls = [];
	const ctx = fakeCtx({
		input: async (title, placeholder) => {
			inputCalls.push({ title, placeholder });
			return "MyProj";
		},
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records), "Feature X");
	assert.equal(inputCalls.length, 1, "prompted exactly once for a project");
	assert.equal(records.length, 1, "exactly one composio create call");
	assert.deepEqual(result, { taskId: "42", project: "MyProj", sectionMode: "sections" });
	const params = JSON.parse(records[0].args[3]);
	assert.equal(params.section_id, "Frame", "task is created in the Frame section");
	resetTodoist();
});

test("a blank project prompt returns null and makes no composio call", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx({ input: async () => "  " });
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records), "Feature X");
	assert.equal(result, null);
	assert.equal(records.length, 0);
	resetTodoist();
});

test("an undefined project prompt (dismissed dialog) returns null and makes no composio call", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx({ input: async () => undefined });
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records), "Feature X");
	assert.equal(result, null);
	assert.equal(records.length, 0);
	resetTodoist();
});

test("a composio create failure (nonzero exit) makes setupTodoistStart return null (fail-soft)", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx();
	const exec = fakeExec(records, () => ({ code: 1, stdout: "", stderr: "not linked" }));
	const result = await setupTodoistStart(ctx, enabledCfg, exec, "Feature X");
	assert.equal(result, null);
	resetTodoist();
});

test("a thrown exec makes setupTodoistStart return null (fail-soft)", async () => {
	resetTodoist();
	const ctx = fakeCtx();
	const exec = async () => {
		throw new Error("spawn ENOENT");
	};
	const result = await setupTodoistStart(ctx, enabledCfg, exec, "Feature X");
	assert.equal(result, null);
	resetTodoist();
});

test("a dismissed mode selection returns null and makes no composio call", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx({ select: async () => undefined });
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records), "Feature X");
	assert.equal(result, null);
	assert.equal(records.length, 0);
	resetTodoist();
});

/** Fake exec that answers TODOIST_GET_TASK2 (id lookup), TODOIST_FILTER_TASKS
 * (search), and TODOIST_GET_ALL_COMMENTS for the adopt-branch tests, and fails
 * (records but never succeeds) any TODOIST_CREATE_TASK call so a stray create
 * would be obvious. */
// Defaults `sections` to the full board convention so this fixture's own
// adopt-flow tests (predating slice 008's section reconciliation) keep
// resolving to `sectionMode: "sections"` with zero createSection calls;
// slice 008's own tests override `sections` to exercise partial/no-convention
// projects.
function fakeAdoptExec(records, { taskId = "7", project = "99", content = "Fix the bug", description = "More detail", comments = ["first", "second"], sections = ["Frame", "Architect", "Plan", "Build", "Review", "Simplify", "Ship"] } = {}) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		const tool = args[1];
		if (tool === "TODOIST_GET_TASK2") {
			const params = JSON.parse(args[3]);
			if (params.task_id !== taskId) return { code: 1, stdout: "", stderr: "not found" };
			return { code: 0, stdout: JSON.stringify({ data: { id: taskId, project_id: project, content, description } }), stderr: "" };
		}
		if (tool === "TODOIST_FILTER_TASKS") return { code: 0, stdout: JSON.stringify({ data: { results: [{ id: taskId, project_id: project }] } }), stderr: "" };
		if (tool === "TODOIST_GET_ALL_COMMENTS") return { code: 0, stdout: JSON.stringify({ data: { comments: comments.map((c) => ({ content: c })) } }), stderr: "" };
		if (tool === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: sections.map((name) => ({ name })) } }), stderr: "" };
		if (tool === "TODOIST_CREATE_SECTION_V1") return { code: 0, stdout: "{}", stderr: "" };
		return { code: 1, stdout: "", stderr: "unexpected tool in adopt test" };
	};
}

test("adopting an existing task by id: no create call, taskId is the adopted task's id, project is its existing project, seed concatenates content+description+comments (criteria 14, 15, 18)", async () => {
	resetTodoist();
	const records = [];
	const inputCalls = [];
	const ctx = fakeCtx({
		select: async () => "Adopt an existing Todoist task",
		input: async (title, placeholder) => {
			inputCalls.push({ title, placeholder });
			return "7";
		},
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakeAdoptExec(records), "Feature X");
	assert.deepEqual(result, { taskId: "7", project: "99", sectionMode: "sections", seed: "Fix the bug\n\nMore detail\n\nfirst\n\nsecond" });
	assert.equal(inputCalls.length, 1, "prompted exactly once (for the task to adopt), no separate project prompt");
	assert.ok(
		!records.some((r) => r.args[1] === "TODOIST_CREATE_TASK"),
		"no create call is issued when adopting",
	);
	resetTodoist();
});

test("adopt seed drops blank content/description/comments", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx({
		select: async () => "Adopt an existing Todoist task",
		input: async () => "7",
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakeAdoptExec(records, { content: "Only content", description: "  ", comments: [] }), "Feature X");
	assert.equal(result.seed, "Only content");
	resetTodoist();
});

test("a blank adopt query returns null and makes no composio call", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx({ select: async () => "Adopt an existing Todoist task", input: async () => "  " });
	const result = await setupTodoistStart(ctx, enabledCfg, fakeExec(records), "Feature X");
	assert.equal(result, null);
	assert.equal(records.length, 0);
	resetTodoist();
});

test("an unresolvable adopt query fails soft to null (findTask finds nothing)", async () => {
	resetTodoist();
	const records = [];
	const notifications = [];
	const ctx = fakeCtx({ select: async () => "Adopt an existing Todoist task", input: async () => "Nonexistent Task" });
	ctx.ui.notify = (msg, level) => notifications.push({ msg, level });
	const exec = fakeExec(records, () => ({ code: 1, stdout: "", stderr: "not found" }));
	const result = await setupTodoistStart(ctx, enabledCfg, exec, "Feature X");
	assert.equal(result, null);
	assert.ok(notifications.length >= 1, "notifies the human that the task could not be found");
	resetTodoist();
});

test("a thrown exec during adopt fails soft to null", async () => {
	resetTodoist();
	const ctx = fakeCtx({ select: async () => "Adopt an existing Todoist task", input: async () => "7" });
	const exec = async () => {
		throw new Error("spawn ENOENT");
	};
	const result = await setupTodoistStart(ctx, enabledCfg, exec, "Feature X");
	assert.equal(result, null);
	resetTodoist();
});
