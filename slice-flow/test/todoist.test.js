import { test } from "node:test";
import assert from "node:assert/strict";

import { createTodoist, getTodoist, resetTodoist, NOOP } from "../extensions/lib/todoist.ts";

/** Records every exec invocation; returns canned output (default success). */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		return handler ? handler(cmd, args, opts) : { code: 0, stdout: JSON.stringify({ data: { id: "999" } }), stderr: "" };
	};
}

test("createTodoist returns NOOP when disabled", async () => {
	const records = [];
	const client = createTodoist({ enabled: false, exec: fakeExec(records) });
	assert.equal(client, NOOP);
	assert.equal(await client.createTask({ project: "p", content: "c" }), null);
	await client.flush();
	assert.equal(records.length, 0, "no composio call when disabled");
});

test("createTodoist returns NOOP when enabled but no exec is supplied", async () => {
	const client = createTodoist({ enabled: true });
	assert.equal(client, NOOP);
});

test("createTask resolves the section name to a section id and creates the task with -d JSON", async () => {
	const records = [];
	const client = createTodoist({
		enabled: true,
		exec: fakeExec(records, (cmd, args) => {
			if (args[1] === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: [{ id: "5001", name: "Frame" }] } }), stderr: "" };
			return { code: 0, stdout: JSON.stringify({ data: { id: "999" } }), stderr: "" };
		}),
	});
	assert.equal(client.enabled, true);
	const id = await client.createTask({ project: "2203306141", section: "Frame", content: "Track feature X" });
	assert.equal(id, "999");
	const create = records.find((r) => r.args[1] === "TODOIST_CREATE_TASK");
	assert.ok(create, "issued a create call");
	assert.equal(create.cmd, "composio");
	assert.equal(create.args[0], "execute");
	assert.equal(create.args[2], "-d");
	const params = JSON.parse(create.args[3]);
	assert.equal(params.content, "Track feature X");
	assert.equal(params.project_id, "2203306141", "the project id is sent, not a display name");
	assert.equal(params.section_id, "5001", "the section name is resolved to its numeric id");
	assert.equal(create.opts.timeout, 5000);
});

test("createTask omits section_id when the section name cannot be resolved (fail-soft)", async () => {
	const records = [];
	const client = createTodoist({
		enabled: true,
		exec: fakeExec(records, (cmd, args) => {
			if (args[1] === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: [] } }), stderr: "" };
			return { code: 0, stdout: JSON.stringify({ data: { id: "999" } }), stderr: "" };
		}),
	});
	const id = await client.createTask({ project: "1", section: "Frame", content: "c" });
	assert.equal(id, "999");
	const create = records.find((r) => r.args[1] === "TODOIST_CREATE_TASK");
	assert.ok(!("section_id" in JSON.parse(create.args[3])), "unresolved section is dropped, not sent as a name");
});

test("listProjects parses TODOIST_GET_ALL_PROJECTS' real envelope: data.projects keyed by project_id", async () => {
	const records = [];
	const client = createTodoist({
		enabled: true,
		// The real tool nests the list under data.projects with each entry keyed by
		// project_id (not data.results / id) — parsing data.results here would
		// silently yield [] and break the whole push path.
		exec: fakeExec(records, () => ({ code: 0, stdout: JSON.stringify({ data: { projects: [{ project_id: "6XvwwRvRfmCjM5PW", name: "Inbox" }, { project_id: "6fm7p873Gr4m66Gw", name: "Work" }] } }), stderr: "" })),
	});
	const projects = await client.listProjects();
	assert.deepEqual(projects, [{ id: "6XvwwRvRfmCjM5PW", name: "Inbox" }, { id: "6fm7p873Gr4m66Gw", name: "Work" }]);
	assert.equal(records[0].args[1], "TODOIST_GET_ALL_PROJECTS");
});

test("createSection skips a legacy-numeric project id (TODOIST_CREATE_SECTION_V1 rejects it) and runs for a v1 id", async () => {
	const legacyRecords = [];
	const legacy = createTodoist({ enabled: true, exec: fakeExec(legacyRecords, () => ({ code: 0, stdout: "{}", stderr: "" })) });
	await legacy.createSection("2203306141", "Build");
	assert.ok(!legacyRecords.some((r) => r.args[1] === "TODOIST_CREATE_SECTION_V1"), "no create call for a legacy numeric project id");

	const v1Records = [];
	const v1 = createTodoist({ enabled: true, exec: fakeExec(v1Records, () => ({ code: 0, stdout: "{}", stderr: "" })) });
	await v1.createSection("6XvwwRvRfmCjM5PW", "Build");
	const call = v1Records.find((r) => r.args[1] === "TODOIST_CREATE_SECTION_V1");
	assert.ok(call, "creates the section for a v1-format project id");
	const params = JSON.parse(call.args[3]);
	assert.equal(params.project_id, "6XvwwRvRfmCjM5PW");
	assert.equal(params.name, "Build");
});

test("listProjects fails soft to [] on a nonzero exit", async () => {
	const client = createTodoist({ enabled: true, exec: fakeExec([], () => ({ code: 1, stdout: "", stderr: "boom" })) });
	assert.deepEqual(await client.listProjects(), []);
});

test("NOOP.listProjects returns []", async () => {
	assert.deepEqual(await NOOP.listProjects(), []);
});

test("createTask returns null (fail-soft) on a nonzero composio exit", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records, () => ({ code: 1, stdout: "", stderr: "boom" })) });
	const id = await client.createTask({ project: "p", content: "c" });
	assert.equal(id, null);
});

test("createTask returns null (fail-soft) when exec throws", async () => {
	const client = createTodoist({
		enabled: true,
		exec: async () => {
			throw new Error("spawn failed");
		},
	});
	const id = await client.createTask({ project: "p", content: "c" });
	assert.equal(id, null);
});

test("createTask returns null when the response cannot be parsed for an id", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records, () => ({ code: 0, stdout: "not json", stderr: "" })) });
	assert.equal(await client.createTask({ project: "p", content: "c" }), null);
});

test("NOOP.findTask returns null and NOOP.taskContext returns empty fields", async () => {
	assert.equal(await NOOP.findTask("anything"), null);
	assert.deepEqual(await NOOP.taskContext("anything"), { content: "", description: "", comments: [] });
});

test("findTask resolves by id via TODOIST_GET_TASK2 and returns { taskId, project }", async () => {
	const records = [];
	const client = createTodoist({
		enabled: true,
		exec: fakeExec(records, (cmd, args) => {
			if (args[1] === "TODOIST_GET_TASK2") return { code: 0, stdout: JSON.stringify({ data: { id: "7", project_id: "99" } }), stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		}),
	});
	const found = await client.findTask("7");
	assert.deepEqual(found, { taskId: "7", project: "99" });
	assert.equal(records.length, 1, "resolved on the first (id) lookup; no fallback search call");
	assert.equal(records[0].args[1], "TODOIST_GET_TASK2");
});

test("findTask falls back to TODOIST_FILTER_TASKS search when the id lookup fails", async () => {
	const records = [];
	const client = createTodoist({
		enabled: true,
		exec: fakeExec(records, (cmd, args) => {
			if (args[1] === "TODOIST_GET_TASK2") return { code: 1, stdout: "", stderr: "not found" };
			if (args[1] === "TODOIST_FILTER_TASKS") {
				const params = JSON.parse(args[3]);
				assert.match(params.query, /search: My Task/);
				return { code: 0, stdout: JSON.stringify({ data: { results: [{ id: "11", project_id: "22" }] } }), stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "" };
		}),
	});
	const found = await client.findTask("My Task");
	assert.deepEqual(found, { taskId: "11", project: "22" });
	assert.equal(records.length, 2, "id lookup then a search fallback");
});

test("findTask returns null (fail-soft) when both lookups fail", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records, () => ({ code: 1, stdout: "", stderr: "boom" })) });
	assert.equal(await client.findTask("nope"), null);
});

test("findTask returns null (fail-soft) when exec throws", async () => {
	const client = createTodoist({
		enabled: true,
		exec: async () => {
			throw new Error("spawn failed");
		},
	});
	assert.equal(await client.findTask("nope"), null);
});

test("taskContext fetches content, description, and comments for a task id", async () => {
	const records = [];
	const client = createTodoist({
		enabled: true,
		exec: fakeExec(records, (cmd, args) => {
			if (args[1] === "TODOIST_GET_TASK2") {
				return { code: 0, stdout: JSON.stringify({ data: { content: "Fix bug", description: "Details here" } }), stderr: "" };
			}
			if (args[1] === "TODOIST_GET_ALL_COMMENTS") {
				return { code: 0, stdout: JSON.stringify({ data: { comments: [{ content: "first comment" }, { content: "second comment" }] } }), stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "" };
		}),
	});
	const info = await client.taskContext("7");
	assert.deepEqual(info, { content: "Fix bug", description: "Details here", comments: ["first comment", "second comment"] });
	assert.equal(records.length, 2);
	assert.equal(records[1].args[1], "TODOIST_GET_ALL_COMMENTS");
	const commentParams = JSON.parse(records[1].args[3]);
	assert.equal(commentParams.task_id, "7");
});

test("taskContext fails soft to empty fields when the task fetch fails", async () => {
	const client = createTodoist({ enabled: true, exec: fakeExec([], () => ({ code: 1, stdout: "", stderr: "boom" })) });
	const info = await client.taskContext("7");
	assert.deepEqual(info, { content: "", description: "", comments: [] });
});

test("taskContext fails soft to empty fields when exec throws", async () => {
	const client = createTodoist({
		enabled: true,
		exec: async () => {
			throw new Error("spawn failed");
		},
	});
	const info = await client.taskContext("7");
	assert.deepEqual(info, { content: "", description: "", comments: [] });
});

test("getTodoist returns NOOP when cfg.todoist.enabled is false", () => {
	resetTodoist();
	const client = getTodoist({ todoist: { enabled: false } }, fakeExec([]));
	assert.equal(client, NOOP);
	resetTodoist();
});

test("getTodoist memoizes the client across calls; resetTodoist forces a re-read", () => {
	resetTodoist();
	const first = getTodoist({ todoist: { enabled: true } }, fakeExec([]));
	const second = getTodoist({ todoist: { enabled: false } }, fakeExec([]));
	assert.equal(second, first, "memoized: the second call's config is ignored");
	resetTodoist();
	const third = getTodoist({ todoist: { enabled: false } }, fakeExec([]));
	assert.notEqual(third, first, "resetTodoist forces a re-read");
	assert.equal(third, NOOP);
	resetTodoist();
});
