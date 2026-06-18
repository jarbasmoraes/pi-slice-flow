import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextStep } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { VERIFY_DIMENSIONS, createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

const NO_UI = { hasUI: false, ui: {} };

const SLICE = (deps) => `# Slice

## Objective
x

## Depends on
${deps}

## Scope
- create src/x.ts

## Out of scope
- none

## Acceptance criteria
- it works

## Hints
- none
`;

function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), `slice-flow-${slug}-`));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	const state = createState("feat", "feat", "base123");
	return { p, state };
}

test("a lint-failing plan deletes the rejected slice files before replanning (MAJOR 1)", async () => {
	const { p, state } = setup("plan-clean");
	writeFileSync(p.plan, "# Plan\n- slice index: 001, 002\n");
	writeFileSync(p.planJudgement, "VERDICT: PASS\n"); // judge clean; the lint is what fails
	writeFileSync(join(p.slices, "001-a.md"), SLICE("none"));
	writeFileSync(join(p.slices, "002-b.md"), SLICE("003")); // forward dep -> lint fails
	state.phase = "plan";
	state.pending = { kind: "plan", seq: 0, label: "Phase 3 — PLAN", args: {} };

	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.match(out, /Replanning/);
	assert.equal(state.planRetries, 1);
	assert.equal(existsSync(join(p.slices, "001-a.md")), false, "stale slice 001 removed");
	assert.equal(existsSync(join(p.slices, "002-b.md")), false, "stale slice 002 removed");
});

test("entering the loop clears every re-verified verdict file so a stale PASS cannot survive (MAJOR 2)", async () => {
	const { p, state } = setup("loop-clean");
	// 4 dimensions PASS, 1 FAILs -> the run must enter the loop.
	for (const dim of VERIFY_DIMENSIONS) {
		const verdict = dim === "security" ? "FAIL" : "PASS";
		writeFileSync(join(p.verify, `${dim}.md`), `VERDICT: ${verdict}\nfindings...\n`);
	}
	state.phase = "verify";
	state.pending = { kind: "verify", seq: 0, label: "Phase 5 — VERIFY", args: {} };

	const out = await nextStep(NO_UI, p, { ...DEFAULT_CONFIG, reverifyAllInLoop: true }, state);
	assert.match(out, /Loop iteration 1/);
	assert.equal(state.phase, "loop");
	for (const dim of VERIFY_DIMENSIONS) {
		assert.equal(existsSync(join(p.verify, `${dim}.md`)), false, `stale ${dim} verdict cleared before re-verify`);
	}
});

test("reverifyAllInLoop=false clears only the failed dimension's verdict", async () => {
	const { p, state } = setup("loop-failed-only");
	for (const dim of VERIFY_DIMENSIONS) {
		const verdict = dim === "security" ? "FAIL" : "PASS";
		writeFileSync(join(p.verify, `${dim}.md`), `VERDICT: ${verdict}\n`);
	}
	state.phase = "verify";
	state.pending = { kind: "verify", seq: 0, label: "Phase 5 — VERIFY", args: {} };

	await nextStep(NO_UI, p, { ...DEFAULT_CONFIG, reverifyAllInLoop: false }, state);
	assert.equal(existsSync(join(p.verify, "security.md")), false, "failed dim cleared");
	assert.equal(existsSync(join(p.verify, "tests.md")), true, "passing dim verdict retained");
});
