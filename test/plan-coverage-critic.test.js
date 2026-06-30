import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planDirective } from "../extensions/lib/directives.ts";
import { planJudgeBrief, planSelectBrief, riskCoverageClause } from "../extensions/lib/briefs.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cov-"));
	const p = workPaths(cwd, ".pi/task", slug);
	ensureWorkTree(p);
	const state = createState(slug, slug, "base");
	state.ui = "none";
	return { p, state };
}

// --- riskCoverageClause (pure) ------------------------------------------------

test("riskCoverageClause is empty when there are no live axes", () => {
	assert.equal(riskCoverageClause([]), "");
	assert.equal(riskCoverageClause(undefined), "");
});

test("riskCoverageClause names the axes and makes an uncovered touched axis FAIL", () => {
	const clause = riskCoverageClause(["multi-tenancy", "xss"]);
	assert.match(clause, /multi-tenancy, xss/);
	assert.match(clause, /risk-taxonomy skill/);
	assert.match(clause, /touched but uncovered/);
	assert.match(clause, /FAIL/);
	// Must not invite flagging untouched axes (anti-false-positive).
	assert.match(clause, /Do not flag an axis the plan does not touch/);
});

// --- brief injection ----------------------------------------------------------

test("planJudgeBrief includes the coverage clause only when axes are live", () => {
	const { p } = setup("brief");
	assert.doesNotMatch(planJudgeBrief(p, []), /Risk-axis coverage/);
	assert.match(planJudgeBrief(p, ["authz"]), /Risk-axis coverage/);
});

test("planSelectBrief includes the coverage clause only when axes are live", () => {
	const { p } = setup("brief2");
	assert.doesNotMatch(planSelectBrief(p, 3, []), /Risk-axis coverage/);
	assert.match(planSelectBrief(p, 3, ["injection"]), /Risk-axis coverage/);
});

// --- directive skill injection ------------------------------------------------

test("single-planner judge gets risk-taxonomy injected when axes are live", () => {
	const { p, state } = setup("inject1");
	state.liveAxes = ["multi-tenancy"];
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1 });
	assert.deepEqual(d.args.chain[1].skill, ["plan-rubric", "risk-taxonomy"]);
});

test("single-planner judge keeps the plain plan-rubric when no axes are live", () => {
	const { p, state } = setup("inject2");
	// createState defaults liveAxes to [] — the judge stays exactly as before.
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1 });
	assert.equal(d.args.chain[1].skill, "plan-rubric");
});

test("divergent selector also gets risk-taxonomy injected when axes are live", () => {
	const { p, state } = setup("inject3");
	state.liveAxes = ["multi-tenancy", "rate-limit"];
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 3 });
	const selector = d.args.chain[1];
	assert.deepEqual(selector.skill, ["plan-rubric", "risk-taxonomy"]);
});

// --- check-generator skill injection (Tier-C) ---------------------------------

test("the planner gets the check-generator playbook when axes are live and generate is on", () => {
	const { p, state } = setup("gen1");
	state.liveAxes = ["multi-tenancy"];
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1 });
	assert.ok(d.args.chain[0].skill.includes("check-generator"), "planner should carry the check-generator skill");
	assert.ok(d.args.chain[0].skill.includes("slice-rules"), "without dropping its base slice-rules skill");
});

test("generate:false withholds the check-generator playbook even with live axes", () => {
	const { p, state } = setup("gen2");
	state.liveAxes = ["multi-tenancy"];
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1, checks: { ...DEFAULT_CONFIG.checks, generate: false } });
	assert.ok(!d.args.chain[0].skill.includes("check-generator"));
});

test("no live axes → planner skills are untouched (no check-generator)", () => {
	const { p, state } = setup("gen3");
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1 });
	assert.ok(!d.args.chain[0].skill.includes("check-generator"));
});
