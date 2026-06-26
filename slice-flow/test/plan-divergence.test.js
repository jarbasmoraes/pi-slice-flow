import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { nextStep } from "../extensions/lib/engine.ts";
import { planWinnerOf, promotePlanCandidate, createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

const NO_UI = { hasUI: false, mode: "json", ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {} } };

const VALID_SLICE = `## Objective
do it
## Depends on
none
## Scope
- implement the thing
## Out of scope
- the other thing
## Acceptance criteria
- works
## Hints
- none
`;

function writeCandidate(p, n, slices) {
	const dir = join(p.root, `plan-${n}`);
	mkdirSync(join(dir, "slices"), { recursive: true });
	writeFileSync(join(dir, "plan.md"), `# Plan candidate ${n}\n- slices: ${slices.join(", ")}\n`, "utf8");
	for (const s of slices) writeFileSync(join(dir, "slices", s), VALID_SLICE, "utf8");
}

test("planWinnerOf parses the WINNER: plan-<n> marker", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-pw-"));
	const f = join(cwd, "j.md");
	writeFileSync(f, "WINNER: plan-2\nbecause it sequences risk first", "utf8");
	assert.equal(planWinnerOf(f), "plan-2");
});

test("promotePlanCandidate copies the winner's plan + slices into the canonical paths", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-promote-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	writeCandidate(p, 1, ["001-a.md"]);
	writeCandidate(p, 2, ["001-b.md", "002-c.md"]);
	assert.equal(promotePlanCandidate(p, "plan-2"), true);
	assert.match(readFileSync(p.plan, "utf8"), /candidate 2/);
	assert.ok(existsSync(join(p.slices, "001-b.md")));
	assert.ok(existsSync(join(p.slices, "002-c.md")));
});

test("promotePlanCandidate returns false when the candidate is incomplete", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-promote2-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	mkdirSync(join(p.root, "plan-1"), { recursive: true });
	writeFileSync(join(p.root, "plan-1", "plan.md"), "# no slices dir", "utf8");
	assert.equal(promotePlanCandidate(p, "plan-1"), false);
});

test("#12 onPlan promotes the selected candidate then gates on the promoted slices", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-onplan-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	const state = createState("feat", "feat", "base");
	state.phase = "plan";
	state.ui = "none";
	state.pending = { kind: "plan", seq: 1, label: "Phase 3 — PLAN (3 candidates)", args: {} };
	writeCandidate(p, 1, ["001-a.md"]);
	writeCandidate(p, 2, ["001-b.md", "002-c.md"]);
	writeCandidate(p, 3, ["001-d.md"]);
	writeFileSync(p.planJudgement, "WINNER: plan-2\nVERDICT: PASS\nsoundest decomposition\n", "utf8");

	const out = await nextStep(NO_UI, p, { ...DEFAULT_CONFIG, planCount: 3 }, state);
	// Winner promoted to canonical paths...
	assert.ok(existsSync(p.plan), "canonical plan promoted");
	assert.ok(existsSync(join(p.slices, "002-c.md")), "winner's slices promoted");
	assert.ok(!existsSync(join(p.slices, "001-a.md")), "loser's slices not promoted");
	// ...and (no UI, valid) the plan gate pauses for the human.
	assert.match(out, /PAUSED|approve/i);
});
