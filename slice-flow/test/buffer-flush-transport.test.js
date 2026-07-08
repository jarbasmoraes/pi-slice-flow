import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createTodoist, NOOP } from "../extensions/lib/todoist.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sliceFlowText = readFileSync(join(here, "..", "extensions", "slice-flow.ts"), "utf8");
const engineText = readFileSync(join(here, "..", "extensions", "lib", "engine.ts"), "utf8");

/** Records every exec invocation; answers TODOIST_LIST_SECTIONS (section-id
 * resolution for a move) and defaults everything else to canned success. */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		if (handler) {
			const r = handler(cmd, args, opts);
			if (r) return r;
		}
		if (args[1] === "TODOIST_LIST_SECTIONS") return { code: 0, stdout: JSON.stringify({ data: { results: [{ id: "sec-Doing", name: "Doing" }] } }), stderr: "" };
		return { code: 0, stdout: "{}", stderr: "" };
	};
}

// --- Buffer + flush ordering (acceptance criterion 10) ------------------------

test("move then comment then flush ships the move (section-resolved) before the comment; a second flush runs nothing", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records) });
	client.move("t1", "Inbox", "Doing");
	client.comment("t1", "hello");
	assert.equal(records.length, 0, "nothing shipped before flush");

	await client.flush();
	const move = records.find((r) => r.args[1] === "TODOIST_MOVE_TASK_REST_API");
	const comment = records.find((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1");
	assert.ok(move && comment, "both the move and the comment ship");
	assert.ok(records.indexOf(move) < records.indexOf(comment), "move ships before comment (insertion order)");

	const before = records.length;
	await client.flush();
	assert.equal(records.length, before, "a second flush ships nothing (buffer cleared)");
});

test("move (section-resolved) and comment enqueue the expected composio params", async () => {
	const records = [];
	const client = createTodoist({ enabled: true, exec: fakeExec(records) });
	client.move("t1", "Inbox", "Doing");
	client.comment("t1", "hello");
	await client.flush();

	const move = records.find((r) => r.args[1] === "TODOIST_MOVE_TASK_REST_API");
	assert.equal(move.cmd, "composio");
	assert.equal(move.args[0], "execute");
	assert.equal(move.args[2], "-d");
	const moveParams = JSON.parse(move.args[3]);
	assert.equal(moveParams.task_id, "t1");
	assert.equal(moveParams.section_id, "sec-Doing", "the section name resolved to its id");
	assert.ok(!("project_id" in moveParams), "only section_id is sent (mutual exclusivity)");

	const comment = records.find((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1");
	const commentParams = JSON.parse(comment.args[3]);
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

test("the abort action primes the exec-backed todoist client BEFORE calling stopped()", () => {
	// stopped() memoizes getTodoist(cfg) internally with no exec; if the abort
	// branch does not prime the singleton with exec first, a fresh process
	// memoizes a NOOP and the stopped label/comment are silently discarded.
	const start = sliceFlowText.indexOf('case "abort":');
	const end = sliceFlowText.indexOf('case "next":');
	const body = sliceFlowText.slice(start, end);
	const primeIdx = body.search(/getTodoist\(cfg, \(c, a, o\) => pi\.exec\(c, a, o\)\)/);
	const stoppedIdx = body.indexOf("stopped(p, state");
	assert.ok(primeIdx !== -1, "abort branch must prime getTodoist(cfg, exec)");
	assert.ok(stoppedIdx !== -1, "abort branch must call stopped()");
	assert.ok(primeIdx < stoppedIdx, "the exec-backed prime must precede stopped() so its board updates ship");
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
