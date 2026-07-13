import { test } from "node:test";
import assert from "node:assert/strict";

import { setupTodoistStart } from "../extensions/lib/engine.ts";
import { createTodoist, resetTodoist } from "../extensions/lib/todoist.ts";

/** ok-JSON exec response helper. */
const ok = (body) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });

function fakeCtx({ hasUI = true, input = async () => "", select = async () => undefined, confirm = async () => true, notify = () => {} } = {}) {
	return {
		hasUI,
		ui: {
			input: async (title, placeholder) => input(title, placeholder),
			notify,
			select: async (title, options) => select(title, options),
			confirm: async (title, description) => confirm(title, description),
		},
	};
}

const enabledCfg = { todoist: { enabled: true } };

/** Exec for the "create" mode: only the push-path tools may be hit. */
function fakeCreateExec(records) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		const tool = args[1];
		if (tool === "TODOIST_GET_ALL_PROJECTS") return ok({ data: { projects: [{ project_id: "6P1", name: "Web" }] } });
		if (tool === "TODOIST_LIST_SECTIONS") return ok({ data: { results: [{ id: "500", name: "Frame" }] } });
		if (tool === "TODOIST_CREATE_TASK") return ok({ data: { id: "42" } });
		return { code: 1, stdout: "", stderr: `unexpected tool ${tool}` };
	};
}

test("mode 'create' skips the create/adopt question and goes straight to the project picker (/feature-todo-create)", async () => {
	resetTodoist();
	const records = [];
	const selectTitles = [];
	const ctx = fakeCtx({
		select: async (title, options) => {
			selectTitles.push(title);
			return options[0];
		},
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakeCreateExec(records), "Feature X", "create");
	assert.deepEqual(result, { taskId: "42", project: "6P1", sectionMode: "sections" });
	// The mode question was never asked; the only select was the project picker.
	assert.deepEqual(selectTitles, ["Todoist project for this run?"]);
	const created = records.find((r) => r.args[1] === "TODOIST_CREATE_TASK");
	assert.ok(created, "expected a TODOIST_CREATE_TASK call");
	assert.equal(JSON.parse(created.args[3]).content, "Feature X");
	resetTodoist();
});

/** Exec for the "pick" mode: project list, task list, then the adopt tail
 * (task context + comments + sections). */
function fakePickExec(records, { tasks = [{ id: "6T1", content: "Ship login" }], sections = [] } = {}) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		const tool = args[1];
		if (tool === "TODOIST_GET_ALL_PROJECTS") return ok({ data: { projects: [{ project_id: "6P1", name: "Web" }] } });
		if (tool === "TODOIST_FILTER_TASKS") return ok({ data: { results: tasks } });
		if (tool === "TODOIST_GET_TASK2") return ok({ data: { id: "6T1", project_id: "6P1", content: "Ship login", description: "with OAuth" } });
		if (tool === "TODOIST_GET_ALL_COMMENTS") return ok({ data: { comments: [{ content: "see spec" }] } });
		if (tool === "TODOIST_LIST_SECTIONS") return ok({ data: { results: sections } });
		return { code: 1, stdout: "", stderr: `unexpected tool ${tool}` };
	};
}

test("mode 'pick' lists projects then that project's tasks and adopts the selection (/feature-todo-start)", async () => {
	resetTodoist();
	const records = [];
	const selects = [];
	const ctx = fakeCtx({
		select: async (title, options) => {
			selects.push({ title, options });
			if (title === "Todoist project?") return "Web";
			if (title === "Todoist task to start?") return "Ship login";
			return undefined;
		},
		confirm: async () => true, // approve the pulled text as the seed
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakePickExec(records), "", "pick");
	assert.deepEqual(result, {
		taskId: "6T1",
		project: "6P1",
		sectionMode: "comment-only", // no board sections present ⇒ never restructure
		seed: "Ship login\n\nwith OAuth\n\nsee spec",
		title: "Ship login",
	});
	// Two pickers, in order: project then task — and never the create/adopt question.
	assert.deepEqual(selects.map((s) => s.title), ["Todoist project?", "Todoist task to start?"]);
	assert.deepEqual(selects[1].options, ["Ship login"]);
	// The task list was scoped by project NAME in Todoist filter syntax.
	const filter = records.find((r) => r.args[1] === "TODOIST_FILTER_TASKS");
	assert.equal(JSON.parse(filter.args[3]).query, "#Web");
	// No task creation on the pick path, ever.
	assert.equal(records.some((r) => r.args[1] === "TODOIST_CREATE_TASK"), false);
	resetTodoist();
});

test("mode 'pick' returns title but no seed when the human declines the pulled text", async () => {
	resetTodoist();
	const ctx = fakeCtx({
		select: async (title) => (title === "Todoist project?" ? "Web" : "Ship login"),
		confirm: async () => false,
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakePickExec([]), "", "pick");
	assert.equal(result.seed, undefined);
	assert.equal(result.title, "Ship login");
	resetTodoist();
});

test("mode 'pick' with no active tasks in the chosen project warns and returns null (fail-soft)", async () => {
	resetTodoist();
	const notices = [];
	const ctx = fakeCtx({
		select: async (title) => (title === "Todoist project?" ? "Web" : undefined),
		notify: (msg, level) => notices.push({ msg, level }),
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakePickExec([], { tasks: [] }), "", "pick");
	assert.equal(result, null);
	assert.ok(notices.some((n) => n.level === "warning" && n.msg.includes("No active tasks")));
	resetTodoist();
});

test("mode 'pick' with a dismissed task picker returns null", async () => {
	resetTodoist();
	const ctx = fakeCtx({
		select: async (title) => (title === "Todoist project?" ? "Web" : undefined),
	});
	const result = await setupTodoistStart(ctx, enabledCfg, fakePickExec([]), "", "pick");
	assert.equal(result, null);
	resetTodoist();
});

test("listTasks parses data.results and data.tasks envelopes and fails soft on error", async () => {
	const mk = (handler) => createTodoist({ enabled: true, exec: handler });
	const results = await mk(async () => ok({ data: { results: [{ id: 1, content: "A" }, { content: "no id" }] } })).listTasks("Web");
	assert.deepEqual(results, [{ id: "1", content: "A" }]);
	const tasks = await mk(async () => ok({ data: { tasks: [{ id: "6T2", content: "B" }] } })).listTasks("Web");
	assert.deepEqual(tasks, [{ id: "6T2", content: "B" }]);
	const failed = await mk(async () => ({ code: 1, stdout: "", stderr: "boom" })).listTasks("Web");
	assert.deepEqual(failed, []);
	const threw = await mk(async () => {
		throw new Error("dead CLI");
	}).listTasks("Web");
	assert.deepEqual(threw, []);
});
