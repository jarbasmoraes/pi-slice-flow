import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gate } from "../extensions/lib/gates.ts";
import { nextStep } from "../extensions/lib/engine.ts";
import { planDirective } from "../extensions/lib/directives.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import {
	archAttackMarkerOf,
	createState,
	ensureWorkTree,
	lintArchitecture,
	lintPrototype,
	prototypeWinnerOf,
	workPaths,
} from "../extensions/lib/workspace.ts";

const NO_UI = { hasUI: false, ui: {} };
const cfgAuto = (gateName) => ({ ...DEFAULT_CONFIG, autonomy: { ...DEFAULT_CONFIG.autonomy, [gateName]: "auto" } });

function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), `slice-flow-${slug}-`));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	return { p, state: createState("feat", "feat", "base123") };
}

const VALID_ARCH = `WINNER: hypothesis-1

## Winner
The winning design.
\`\`\`mermaid
graph TD; A-->B;
\`\`\`

## Goals & Non-Goals
- Goal: ship it.
- Non-goal: not that.

## Architecture Overview
Prose overview of the structure and the main flow.
\`\`\`mermaid
sequenceDiagram; A->>B: call;
\`\`\`

## Components
- ComponentX — does X (src/x.ts).

## Data Models & Schema Changes
No database impact.

## Error Handling
Errors bubble to the caller.

## Alternatives Considered
- hypothesis-2: more moving parts.

## Risks & Mitigations
- watch the seam; mitigate with a contract test.

## Requirement Traceability
| AC | Component |
| - | - |
| 1 | ComponentX |

## Scores
| hypothesis | fit |
| - | - |
| 1 | 5 |
`;

// --- Autonomy gate ----------------------------------------------------------

test("a gate set to 'auto' approves without a UI and without asking", async () => {
	const g = await gate(NO_UI, cfgAuto("verify"), "done?", "x", "verify");
	assert.equal(g.decision, "approve");
});

test("a gate set to 'auto' skips the human even when a UI is present", async () => {
	const ui = { notify() {}, select() { throw new Error("must not ask when trusted"); } };
	const g = await gate({ hasUI: true, ui }, cfgAuto("plan"), "approve?", "x", "plan");
	assert.equal(g.decision, "approve");
});

test("a 'human' gate with no UI and no autoApprove pauses", async () => {
	const g = await gate(NO_UI, DEFAULT_CONFIG, "approve?", "x", "plan");
	assert.equal(g.decision, "pause");
});

test("an 'auto' gate refuses to approve a NOT-clean artifact (no silent FAIL ship)", async () => {
	// The keystone trust contract: auto trusts an earned PASS, never a known fail.
	const auto = await gate(NO_UI, cfgAuto("plan"), "approve?", "x", "plan", false);
	assert.equal(auto.decision, "pause");
	const app = await gate(NO_UI, { ...DEFAULT_CONFIG, autoApprove: true }, "approve?", "x", "plan", false);
	assert.equal(app.decision, "pause", "autoApprove also must not ship a known-failing artifact");
});

test("frame is never auto-trusted by the autonomy map", async () => {
	// Even if someone sets frame:auto, the gate refuses to skip the human.
	const g = await gate(NO_UI, cfgAuto("frame"), "approve frame?", "x", "frame");
	assert.equal(g.decision, "pause");
});

// --- Pure helpers -----------------------------------------------------------

test("prototypeWinnerOf parses the WINNER marker", () => {
	const { p } = setup("proto-winner");
	const j = join(p.prototypes, "JUDGEMENT.md");
	mkdirSync(p.prototypes, { recursive: true });
	writeFileSync(j, "WINNER: proto-3\n\nbecause...\n");
	assert.equal(prototypeWinnerOf(j), "proto-3");
});

test("lintPrototype fails without a WINNER marker and passes when the dir+README exist", () => {
	const { p } = setup("proto-lint");
	const j = join(p.prototypes, "JUDGEMENT.md");
	mkdirSync(p.prototypes, { recursive: true });
	writeFileSync(j, "no marker here\n");
	assert.equal(lintPrototype(p).ok, false);

	writeFileSync(j, "WINNER: proto-1\n");
	assert.equal(lintPrototype(p).ok, false, "winner dir missing");

	mkdirSync(join(p.prototypes, "proto-1"), { recursive: true });
	writeFileSync(join(p.prototypes, "proto-1", "README.md"), "# proto 1\n");
	assert.equal(lintPrototype(p).ok, true);
});

function archFile(slug) {
	const dir = mkdtempSync(join(tmpdir(), `slice-flow-${slug}-`));
	return join(dir, "02-architecture.md");
}

test("lintArchitecture passes a full new-format spec-driven document", () => {
	const f = archFile("arch-lint-ok");
	writeFileSync(f, VALID_ARCH);
	assert.equal(lintArchitecture(f).ok, true);
});

test("lintArchitecture fails when a required heading is missing", () => {
	const f = archFile("arch-lint-missing");
	writeFileSync(f, VALID_ARCH.replace("## Error Handling", "## Whoops"));
	const r = lintArchitecture(f);
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((x) => x.includes("## Error Handling")));
});

test("lintArchitecture fails with fewer than two mermaid fences", () => {
	const f = archFile("arch-lint-mermaid");
	const oneFence = VALID_ARCH.replace("```mermaid\nsequenceDiagram; A->>B: call;\n```", "sequence prose");
	writeFileSync(f, oneFence);
	const r = lintArchitecture(f);
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((x) => /mermaid/.test(x) && /found 1/.test(x)));
});

test("lintArchitecture fails when ## Scores has no table", () => {
	const f = archFile("arch-lint-scores");
	writeFileSync(f, VALID_ARCH.replace("| hypothesis | fit |\n| - | - |\n| 1 | 5 |", "no table here"));
	const r = lintArchitecture(f);
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((x) => /Scores/.test(x)));
});

test("lintArchitecture fails when ## Requirement Traceability has no table", () => {
	const f = archFile("arch-lint-trace");
	writeFileSync(f, VALID_ARCH.replace("| AC | Component |\n| - | - |\n| 1 | ComponentX |", "no table here"));
	const r = lintArchitecture(f);
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((x) => /Requirement Traceability/.test(x)));
});

test("lintArchitecture table check is heading-scoped (Scores table does not satisfy Traceability)", () => {
	// A doc with a Scores table but an empty Requirement Traceability section must fail traceability.
	const f = archFile("arch-lint-scope");
	writeFileSync(f, VALID_ARCH.replace("| AC | Component |\n| - | - |\n| 1 | ComponentX |", "just prose, no row"));
	const r = lintArchitecture(f);
	assert.equal(r.ok, false);
	assert.ok(r.findings.some((x) => /Requirement Traceability/.test(x)));
});

test("lintArchitecture fails for a missing file", () => {
	const f = archFile("arch-lint-missing-file");
	assert.equal(lintArchitecture(f).ok, false);
});

test("archAttackMarkerOf parses HOLDS/RECONSIDER and null when absent", () => {
	const { p } = setup("arch-marker");
	writeFileSync(p.archDispositions, "ARCH-ATTACK: RECONSIDER\n\n## Attack dispositions\n");
	assert.equal(archAttackMarkerOf(p.archDispositions), "RECONSIDER");
	writeFileSync(p.archDispositions, "ARCH-ATTACK: HOLDS\n");
	assert.equal(archAttackMarkerOf(p.archDispositions), "HOLDS");
	assert.equal(archAttackMarkerOf(join(p.root, "nope.md")), null);
});

test("planDirective is a two-step chain: planner then plan judge", () => {
	const { p, state } = setup("plan-dir");
	state.ui = "none";
	const d = planDirective(p, state, DEFAULT_CONFIG);
	assert.equal(d.args.chain.length, 2);
	assert.match(d.args.chain[1].label, /Judge plan/);
	assert.equal(d.args.chain[1].output, p.planJudgement);
	assert.equal(d.args.chain[1].skill, "plan-rubric");
});

// --- Engine: architecture attack stage --------------------------------------

function architectReady(slug) {
	const { p, state } = setup(slug);
	const hypo = join(p.arch, "hypothesis-1.md");
	writeFileSync(hypo, "# hypothesis 1\n");
	writeFileSync(p.architecture, VALID_ARCH);
	state.phase = "architect";
	state.pending = { kind: "architect", seq: 0, label: "Phase 2 — ARCHITECT", args: {}, expects: [hypo, p.architecture] };
	return { p, state };
}

test("onArchitect runs the attack panel before gating the winning design", async () => {
	const { p, state } = architectReady("arch-attack-trigger");
	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.equal(state.pending.kind, "arch-attack", "attack panel issued before the gate");
	assert.match(out, /Attacking the winning design/);
});

function attackedReady(slug, marker) {
	const { p, state } = setup(slug);
	writeFileSync(p.architecture, VALID_ARCH);
	const report = join(p.archAttacks, "001-wrong-seam.md");
	writeFileSync(report, "## Objection\nthe seam leaks\n");
	writeFileSync(p.archDispositions, `ARCH-ATTACK: ${marker}\n\n## Attack dispositions\n- resolved\n`);
	state.phase = "architect";
	state.pending = { kind: "arch-attack", seq: 0, label: "attack", args: {}, expects: [report, p.archDispositions] };
	return { p, state };
}

test("onArchAttacked with HOLDS proceeds to the architect gate (human pauses)", async () => {
	const { p, state } = attackedReady("arch-holds", "HOLDS");
	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.equal(state.archAttacked, true);
	assert.match(out, /PAUSED/);
});

test("onArchAttacked with RECONSIDER triggers a bounded full re-run (regenerate hypotheses)", async () => {
	const { p, state } = attackedReady("arch-reconsider", "RECONSIDER");
	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.equal(state.pending.kind, "architect", "full re-run, not a re-judge of the same hypotheses");
	assert.equal(state.archRetries, 1);
	assert.equal(state.archAttacked, false, "will re-attack the regenerated winner");
	assert.equal(existsSync(p.architecture), false, "stale architecture cleared before re-run");
	assert.match(out, /RECONSIDER/);
});

test("autonomy architect='auto' advances past the gate headless", async () => {
	const { p, state } = attackedReady("arch-auto", "HOLDS");
	state.ui = "none"; // skip the UI-shape question
	const out = await nextStep(NO_UI, p, cfgAuto("architect"), state);
	assert.equal(state.archApproved, true);
	assert.equal(state.phase, "plan");
	assert.match(out, /Architecture approved/);
});

// --- Engine: plan judge + prototype gate ------------------------------------

const SLICE = (deps) => `# Slice\n\n## Objective\nx\n\n## Depends on\n${deps}\n\n## Scope\n- create src/x.ts\n\n## Out of scope\n- none\n\n## Acceptance criteria\n- it works\n\n## Hints\n- none\n`;

test("onPlan replans when the plan judge returns FAIL even though the lint passes", async () => {
	const { p, state } = setup("plan-judge-fail");
	writeFileSync(p.plan, "# Plan\n- slices: 001, 002\n");
	writeFileSync(p.planJudgement, "VERDICT: FAIL\ncoverage gap on AC3\n");
	writeFileSync(join(p.slices, "001-a.md"), SLICE("none"));
	writeFileSync(join(p.slices, "002-b.md"), SLICE("001"));
	state.phase = "plan";
	state.pending = { kind: "plan", seq: 0, label: "Phase 3 — PLAN", args: {} };

	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.match(out, /Replanning/);
	assert.equal(state.planRetries, 1);
	assert.equal(existsSync(join(p.slices, "001-a.md")), false, "rejected slices cleared");
});

test("onPrototype re-judges a judgement with no WINNER marker, then gates", async () => {
	const { p, state } = setup("proto-rejudge");
	mkdirSync(p.prototypes, { recursive: true });
	writeFileSync(join(p.prototypes, "JUDGEMENT.md"), "I like proto 2 best\n"); // no WINNER marker
	state.phase = "prototype";
	state.pending = { kind: "prototype", seq: 0, label: "Phase 3a", args: {} };

	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.equal(state.pending.kind, "prototype-judge");
	assert.equal(state.prototypeRetries, 1);
	assert.match(out, /Re-judging/);
});

test("a clean all-pass verification auto-completes only when verify gate is 'auto'", async () => {
	const mk = (slug) => {
		const { p, state } = setup(slug);
		for (const dim of ["code-quality", "simplicity", "security", "evals", "tests"]) {
			writeFileSync(join(p.verify, `${dim}.md`), "VERDICT: PASS\n");
		}
		state.phase = "verify";
		state.pending = { kind: "verify", seq: 0, label: "Phase 5 — VERIFY", args: {} };
		return { p, state };
	};
	// autonomy verify='auto' -> headless completion.
	const a = mk("verify-auto");
	const outAuto = await nextStep(NO_UI, a.p, cfgAuto("verify"), a.state);
	assert.equal(a.state.phase, "done");
	assert.match(outAuto, /COMPLETE/);
	// default 'human' + no UI -> pauses at the completion gate instead of finishing silently.
	const h = mk("verify-human");
	const outHuman = await nextStep(NO_UI, h.p, DEFAULT_CONFIG, h.state);
	assert.notEqual(h.state.phase, "done");
	assert.match(outHuman, /PAUSED/);
});

test("onPrototype with a valid winner gates the human (pauses with no UI)", async () => {
	const { p, state } = setup("proto-gate");
	mkdirSync(join(p.prototypes, "proto-1"), { recursive: true });
	writeFileSync(join(p.prototypes, "proto-1", "README.md"), "# p1\n");
	writeFileSync(join(p.prototypes, "JUDGEMENT.md"), "WINNER: proto-1\n\nwhy it won...\n");
	state.phase = "prototype";
	state.pending = { kind: "prototype", seq: 0, label: "Phase 3a", args: {} };

	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.match(out, /PAUSED/);
});
