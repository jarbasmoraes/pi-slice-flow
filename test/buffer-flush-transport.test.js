import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createTodoist, NOOP } from "../extensions/lib/todoist.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sliceFlowText = readFileSync(join(here, "..", "extensions", "slice-flow.ts"), "utf8");
const engineText = readFileSync(join(here, "..", "extensions", "lib", "engine.ts"), "utf8");

/** Records every exec invocation; returns canned success output. */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		return handler ? handler(cmd, args, opts) : { code: 0, stdout: "{}", stderr: "" };
	};
}

// --- Buffer + flush ordering (acceptance criterion 10) ------------------------

test("move then comment then flush runs exactly two composio calls in insertion order; a second flush runs nothing", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records) });
	client.move("t1", "Inbox", "Doing");
	client.comment("t1", "hello");
	assert.equal(records.length, 0, "nothing shipped before flush");

	await client.flush();
	assert.equal(records.length, 2, "exactly two composio calls");
	assert.equal(records[0].args[1], "TODOIST_MOVE_TASK", "move ships first (insertion order)");
	assert.equal(records[1].args[1], "TODOIST_CREATE_COMMENT_V1", "comment ships second (insertion order)");

	await client.flush();
	assert.equal(records.length, 2, "a second flush ships nothing (buffer cleared)");
});

test("move and comment enqueue the expected composio params", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records) });
	client.move("t1", "Inbox", "Doing");
	client.comment("t1", "hello");
	await client.flush();

	assert.equal(records[0].cmd, "composio");
	assert.equal(records[0].args[0], "execute");
	assert.equal(records[0].args[2], "-d");
	const moveParams = JSON.parse(records[0].args[3]);
	assert.equal(moveParams.task_id, "t1");

	const commentParams = JSON.parse(records[1].args[3]);
	assert.equal(commentParams.task_id, "t1");
	assert.equal(commentParams.content, "hello");
});

// --- Fail-soft (acceptance criterion 11 structural) ---------------------------

test("a transport whose exec throws never rejects flush() and never throws into the caller", async () => {
	const client = createTodoist({
		enabled: true,
		exec: async () => {
			throw new Error("spawn failed");
		},
	});
	client.move("t1", "Inbox", "Doing");
	client.comment("t1", "hello");
	await client.flush(); // must resolve, not reject
});

test("a transport that returns a nonzero exit code never rejects flush()", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records, () => ({ code: 1, stdout: "", stderr: "boom" })) });
	client.move("t1", "Inbox", "Doing");
	await client.flush();
	assert.equal(records.length, 1);
});

// --- NOOP -----------------------------------------------------------------

test("NOOP buffers nothing and flush() resolves with no exec call", async () => {
	const records = [];
	const client = createTodoist({ enabled: false, exec: fakeExec(records) });
	assert.equal(client, NOOP);
	client.move("t1", "Inbox", "Doing");
	client.comment("t1", "hello");
	await client.flush();
	assert.equal(records.length, 0, "no composio call when disabled");
});

// --- Source-text: the four flush points in slice-flow.ts ----------------------

test("the start action flushes the todoist client", () => {
	const start = sliceFlowText.indexOf('if (params.action === "start")');
	const next = sliceFlowText.indexOf('if (params.action === "metrics")');
	const body = sliceFlowText.slice(start, next);
	assert.match(body, /await getTodoist\(cfg, \(c, a, o\) => pi\.exec\(c, a, o\)\)\.flush\(\);/);
});

test("the next action flushes the todoist client", () => {
	const start = sliceFlowText.indexOf('case "next":');
	const next = sliceFlowText.indexOf('case "research":');
	const body = sliceFlowText.slice(start, next);
	assert.match(body, /await getTodoist\(cfg, \(c, a, o\) => pi\.exec\(c, a, o\)\)\.flush\(\);/);
});

test("the tool_result hook flushes the todoist client after the telemetry flush", () => {
	const start = sliceFlowText.indexOf('pi.on("tool_result"');
	const end = sliceFlowText.indexOf('// --- Slash commands');
	const body = sliceFlowText.slice(start, end);
	assert.match(body, /await tel\.flush\(\);\s*\n\s*await getTodoist\(cfg, \(c, a, o\) => pi\.exec\(c, a, o\)\)\.flush\(\);/);
});

test("the abort action now flushes the todoist client before returning", () => {
	const start = sliceFlowText.indexOf('case "abort":');
	const end = sliceFlowText.indexOf('case "next":');
	const body = sliceFlowText.slice(start, end);
	assert.match(body, /await getTodoist\(cfg, \(c, a, o\) => pi\.exec\(c, a, o\)\)\.flush\(\);/, "abort branch must flush the todoist client");
});

test("slice-flow.ts imports getTodoist", () => {
	assert.match(sliceFlowText, /import \{ getTodoist \} from "\.\/lib\/todoist\.ts";/);
});

// --- nextStep primes the memoized client --------------------------------------

test("nextStep primes getTodoist(cfg, exec) as its first statement", () => {
	const start = engineText.indexOf("export async function nextStep(");
	assert.ok(start !== -1, "could not find nextStep in engine.ts");
	const braceIdx = engineText.indexOf("{", start);
	const body = engineText.slice(braceIdx + 1, braceIdx + 200);
	assert.match(body.trimStart(), /^getTodoist\(cfg, exec\);/, "nextStep must prime getTodoist(cfg, exec) as its first statement");
});
