import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { transitionPhase, nextStep } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

const here = dirname(fileURLToPath(import.meta.url));
const engineText = readFileSync(join(here, "..", "extensions", "lib", "engine.ts"), "utf8");

const NO_UI = { hasUI: false, ui: {} };

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

function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), `slice-flow-${slug}-`));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	const state = createState("feat", "feat", "base123");
	return { p, state };
}

// --- Source-text lint: every state.phase = "<literal>" assignment must live
// inside transitionPhase itself (the single chokepoint), mirroring the style
// of test/config-defaults.test.js. ---------------------------------------------

function transitionPhaseBody() {
	const start = engineText.indexOf("export function transitionPhase(");
	assert.ok(start !== -1, "could not find transitionPhase in engine.ts");
	const end = engineText.indexOf("\n}", start);
	assert.ok(end !== -1, "could not find closing brace of transitionPhase");
	return engineText.slice(start, end + 2);
}

test("engine.ts contains no bare state.phase literal assignment outside transitionPhase", () => {
	const body = transitionPhaseBody();
	const withoutBody = engineText.slice(0, engineText.indexOf(body)) + engineText.slice(engineText.indexOf(body) + body.length);
	const literalAssignment = /state\.phase\s*=\s*"[a-z]+"/;
	assert.doesNotMatch(withoutBody, literalAssignment, "found a state.phase = \"...\" assignment outside transitionPhase");
	// Sanity: transitionPhase itself does the (non-literal) assignment.
	assert.match(body, /state\.phase\s*=\s*next/);
});

// --- transitionPhase itself: sets state.phase and appends a "phase"-kind log
// entry; performs no await and no saveState (asserted indirectly: the state
// object passed in is never written to disk by this call). --------------------

test("transitionPhase advances state.phase and appends a phase-kind log entry", () => {
	const { state } = setup("transition-direct");
	const before = state.log.length;
	transitionPhase(state, "architect", "frame approved", DEFAULT_CONFIG);
	assert.equal(state.phase, "architect");
	const entry = state.log[before];
	assert.ok(entry, "a log entry was appended");
	assert.equal(entry.kind, "phase");
	assert.match(entry.event, /^phase frame -> architect: frame approved$/);
});

// --- A representative transition driven through a real handler: an approved
// plan advances phase -> implement via the transitionPhase chokepoint. --------

test("an approved plan advances phase to implement through transitionPhase (representative handler transition)", async () => {
	const { p, state } = setup("plan-approve");
	writeFileSync(p.plan, "# Plan\n- slice index: 001\n");
	writeFileSync(p.planJudgement, "VERDICT: PASS\n");
	writeFileSync(join(p.slices, "001-a.md"), VALID_SLICE);
	state.phase = "plan";
	state.pending = { kind: "plan", seq: 0, label: "Phase 3 — PLAN", args: {} };

	const cfg = { ...DEFAULT_CONFIG, autoApprove: true };
	const before = state.log.length;
	const out = await nextStep(NO_UI, p, cfg, state);

	assert.equal(state.phase, "implement");
	assert.match(out, /Plan approved/);
	const phaseEntries = state.log.slice(before).filter((e) => e.kind === "phase");
	assert.ok(
		phaseEntries.some((e) => e.event === "phase plan -> implement: plan approved"),
		"expected a phase-kind log entry for the plan -> implement transition",
	);
});
