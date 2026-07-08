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

test("createTask issues exactly one composio execute call with -d JSON and returns the parsed id", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records) });
	assert.equal(client.enabled, true);
	const id = await client.createTask({ project: "Inbox", section: "Frame", content: "Track feature X" });
	assert.equal(id, "999");
	assert.equal(records.length, 1, "exactly one composio call");
	assert.equal(records[0].cmd, "composio");
	assert.equal(records[0].args[0], "execute");
	assert.equal(records[0].args[1], "TODOIST_CREATE_TASK");
	assert.equal(records[0].args[2], "-d");
	const params = JSON.parse(records[0].args[3]);
	assert.equal(params.content, "Track feature X");
	assert.equal(params.project_id, "Inbox");
	assert.equal(params.section_id, "Frame");
	assert.equal(records[0].opts.timeout, 5000);
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
