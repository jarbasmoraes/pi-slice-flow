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

function fakeCtx({ hasUI = true, input = async () => "MyProj", select = async () => "Create a new Todoist task", confirm = async () => true } = {}) {
	return {
		hasUI,
		ui: {
			input: async (title, placeholder) => input(title, placeholder),
			notify() {},
			select: async (title, options) => select(title, options),
			confirm: async (title, description) => confirm(title, description),
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

/** Exec for the push path: answers the project picker (GET_ALL_PROJECTS), the
 * Frame-section resolution (LIST_SECTIONS), and the create (CREATE_TASK). */
function fakePushExec(records, { projects = [{ project_id: "10", name: "MyProj" }], sections = [{ id: "500", name: "Frame" }], createId = "42", createCode = 0 } = {}) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		const tool = args[1];
		// The real TODOIST_GET_ALL_PROJECTS envelope: data.projects keyed by project_id.
		if (tool === "TODOIST_GET_ALL_PROJECTS") return { code: 0, stdout: JSON.stringify({ data: { projects } }), stderr: "" };
		if (tool === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: sections } }), stderr: "" };
		if (tool === "TODOIST_CREATE_TASK") return { code: createCode, stdout: createCode === 0 ? JSON.stringify({ data: { id: createId } }) : "", stderr: createCode === 0 ? "" : "not linked" };
		return { code: 1, stdout: "", stderr: "unexpected tool in push test" };
	};
}

/** Default push ctx: picks "Create a new Todoist task" at the mode select and
 * the first offered project at the project picker. */
function pushCtx(overrides = {}) {
	return fakeCtx({
		select: async (title, options) => (options.includes("Create a new Todoist task") ? "Create a new Todoist task" : options[0]),
		...overrides,
	});
}

test("with UI and todoist enabled, PICKS an existing project and creates the task in the resolved Frame section (criterion 1, 12)", async () => {
	resetTodoist();
	const records = [];
	const selectCalls = [];
	const ctx = pushCtx({
		select: async (title, options) => {
			selectCalls.push({ title, options });
			return options.includes("Create a new Todoist task") ? "Create a new Todoist task" : "MyProj";
		},
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakePushExec(records), "Feature X");
	assert.deepEqual(result, { taskId: "42", project: "10", sectionMode: "sections" }, "stores the picked project's ID, not its display name");
	assert.ok(selectCalls.some((c) => c.options.includes("MyProj")), "the human picks from the list of existing projects");
	const create = records.find((r) => r.args[1] === "TODOIST_CREATE_TASK");
	const params = JSON.parse(create.args[3]);
	assert.equal(params.project_id, "10", "create uses the project ID");
	assert.equal(params.section_id, "500", "Frame section name resolved to its id");
	resetTodoist();
});

test("no existing projects returns null (nothing to pick) and makes no create call", async () => {
	resetTodoist();
	const records = [];
	const ctx = pushCtx();
	const result = await setupTodoistStart(ctx, enabledCfg, fakePushExec(records, { projects: [] }), "Feature X");
	assert.equal(result, null);
	assert.ok(!records.some((r) => r.args[1] === "TODOIST_CREATE_TASK"));
	resetTodoist();
});

test("a dismissed project picker returns null and makes no create call", async () => {
	resetTodoist();
	const records = [];
	const ctx = pushCtx({ select: async (title, options) => (options.includes("Create a new Todoist task") ? "Create a new Todoist task" : undefined) });
	const result = await setupTodoistStart(ctx, enabledCfg, fakePushExec(records), "Feature X");
	assert.equal(result, null);
	assert.ok(!records.some((r) => r.args[1] === "TODOIST_CREATE_TASK"));
	resetTodoist();
});

test("a composio create failure (nonzero exit) makes setupTodoistStart return null (fail-soft)", async () => {
	resetTodoist();
	const records = [];
	const ctx = pushCtx();
	const result = await setupTodoistStart(ctx, enabledCfg, fakePushExec(records, { createCode: 1 }), "Feature X");
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

test("adopting an existing task by id: no create call, taskId is the adopted task's id, project is its existing project, seed concatenates content+description+comments after human approval (criteria 14, 15, 18)", async () => {
	resetTodoist();
	const records = [];
	const inputCalls = [];
	const confirmCalls = [];
	const ctx = fakeCtx({
		select: async () => "Adopt an existing Todoist task",
		input: async (title, placeholder) => {
			inputCalls.push({ title, placeholder });
			return "7";
		},
		confirm: async (title, description) => {
			confirmCalls.push({ title, description });
			return true;
		},
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakeAdoptExec(records), "Feature X");
	assert.deepEqual(result, { taskId: "7", project: "99", sectionMode: "sections", seed: "Fix the bug\n\nMore detail\n\nfirst\n\nsecond", title: "Fix the bug" });
	assert.equal(inputCalls.length, 1, "prompted exactly once (for the task to adopt), no separate project prompt");
	assert.equal(confirmCalls.length, 1, "operator is asked to approve the pulled text before it seeds the run");
	assert.ok(confirmCalls[0].description.includes("Fix the bug\n\nMore detail\n\nfirst\n\nsecond"), "the exact pulled seed is shown for review before approval");
	assert.ok(
		!records.some((r) => r.args[1] === "TODOIST_CREATE_TASK"),
		"no create call is issued when adopting",
	);
	resetTodoist();
});

test("declining the seed confirmation still adopts the task for board tracking but drops the pulled text (trust boundary against prompt injection)", async () => {
	resetTodoist();
	const records = [];
	const ctx = fakeCtx({
		select: async () => "Adopt an existing Todoist task",
		input: async () => "7",
		confirm: async () => false,
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakeAdoptExec(records), "Feature X");
	assert.deepEqual(result, { taskId: "7", project: "99", sectionMode: "sections", title: "Fix the bug" }, "task is adopted with its title, but no seed key so feature falls back to the first-party description");
	assert.equal(result.seed, undefined, "third-party text never reaches the run when the operator declines");
	resetTodoist();
});

test("no confirmation is asked (and no seed returned) when the adopted task has no text", async () => {
	resetTodoist();
	const records = [];
	const confirmCalls = [];
	const ctx = fakeCtx({
		select: async () => "Adopt an existing Todoist task",
		input: async () => "7",
		confirm: async () => {
			confirmCalls.push(true);
			return true;
		},
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakeAdoptExec(records, { content: "  ", description: "  ", comments: [] }), "Feature X");
	assert.equal(confirmCalls.length, 0, "empty seed ⇒ nothing to review, no confirm prompt");
	assert.equal(result.seed, undefined);
	assert.deepEqual(result, { taskId: "7", project: "99", sectionMode: "sections" });
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
