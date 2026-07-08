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

function fakeCtx({ hasUI = true, input = async () => "MyProj" } = {}) {
	return {
		hasUI,
		ui: {
			input: async (title, placeholder) => input(title, placeholder),
			notify() {},
			select: async () => undefined,
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
