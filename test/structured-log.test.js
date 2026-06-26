import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createState, loadState, logEvent, logGate, logRetry, observeSubagentResult, saveState, workPaths, ensureWorkTree } from "../extensions/lib/workspace.ts";
import { computeTaskMetrics } from "../extensions/lib/metrics.ts";

test("logEvent persists optional kind/payload while keeping the human event string", () => {
	const s = createState("feat", "feat", null);
	logEvent(s, "plain string only");
	logEvent(s, "typed one", "note", { a: 1 });
	assert.deepEqual(s.log[0], { ts: s.log[0].ts, event: "plain string only" });
	assert.equal(s.log[1].event, "typed one");
	assert.equal(s.log[1].kind, "note");
	assert.deepEqual(s.log[1].payload, { a: 1 });
});

test("logGate emits the canonical string AND a structured gate payload", () => {
	const s = createState("feat", "feat", null);
	logGate(s, "architect", "revise");
	assert.equal(s.log[0].event, "gate architect: revise");
	assert.equal(s.log[0].kind, "gate");
	assert.deepEqual(s.log[0].payload, { gate: "architect", decision: "revise" });
});

test("logRetry tags a structured retry kind", () => {
	const s = createState("feat", "feat", null);
	logRetry(s, "recompile", "frame validation failed -> recompile 1");
	assert.equal(s.log[0].kind, "retry");
	assert.deepEqual(s.log[0].payload, { retryKind: "recompile" });
});

test("metrics counts identically whether decisions arrive structured or as legacy strings", () => {
	const structured = createState("feat", "feat", null);
	logGate(structured, "architect", "approve");
	logGate(structured, "architect", "revise");
	logRetry(structured, "loop", "loop iteration 1: FAIL on tests");

	// Legacy: same events as plain strings with no kind/payload (pre-upgrade state.json).
	const legacy = { slug: "feat", phase: "done", tokensSpent: 0, log: [
		{ ts: "t0", event: "gate architect: approve" },
		{ ts: "t1", event: "gate architect: revise" },
		{ ts: "t2", event: "loop iteration 1: FAIL on tests" },
	] };

	const ms = computeTaskMetrics(structured);
	const ml = computeTaskMetrics(legacy);
	const archS = ms.gates.find((g) => g.gate === "architect");
	const archL = ml.gates.find((g) => g.gate === "architect");
	assert.deepEqual({ a: archS.approve, r: archS.revise }, { a: 1, r: 1 });
	assert.deepEqual({ a: archL.approve, r: archL.revise }, { a: 1, r: 1 });
	assert.equal(ms.retries.loop, 1);
	assert.equal(ml.retries.loop, 1);
	assert.equal(archS.overrideRate, archL.overrideRate);
});

test("a structured gate entry is never double-counted via its legacy string", () => {
	const s = createState("feat", "feat", null);
	logGate(s, "verify", "approve"); // event string ALSO matches GATE_LINE, but kind path continues
	const m = computeTaskMetrics(s);
	const verify = m.gates.find((g) => g.gate === "verify");
	assert.equal(verify.approve, 1); // not 2
});

test("structured log entries round-trip through saveState/loadState", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-log-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	const s = createState("feat", "feat", null);
	logGate(s, "plan", "abort");
	saveState(p, s);
	const back = loadState(p);
	assert.equal(back.log[0].kind, "gate");
	assert.deepEqual(back.log[0].payload, { gate: "plan", decision: "abort" });
});

test("observeSubagentResult captures a self-reported VERDICT into the log", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-obs-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	const s = createState("feat", "feat", null);
	observeSubagentResult(p, s, { task: "verify" }, [{ type: "text", text: "...\nVERDICT: FAIL\nbecause X" }]);
	const verdict = s.log.find((e) => e.kind === "verdict");
	assert.ok(verdict, "a verdict entry is logged");
	assert.deepEqual(verdict.payload, { verdict: "FAIL" });
	assert.ok(s.tokensSpent > 0, "chars/4 fallback still accrues");
});
