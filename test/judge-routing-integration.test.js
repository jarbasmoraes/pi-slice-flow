import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planDirective } from "../extensions/lib/directives.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-jri-"));
	const p = workPaths(cwd, ".pi/task", slug);
	ensureWorkTree(p);
	const state = createState(slug, slug, "base");
	state.ui = "none";
	return { p, state };
}

test("Claude-only: the plan judge keeps its configured opus model", () => {
	const { p, state } = setup("jr1");
	state.judgeFamilies = ["claude"];
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1 });
	assert.equal(d.args.chain[1].model, "anthropic/claude-opus-4-8");
});

test("cross mode with a second family reroutes the Claude judge to the other family", () => {
	const { p, state } = setup("jr2");
	state.judgeFamilies = ["claude", "gpt"];
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1 });
	// builder is the session default (claude), so an opus judge is same-family →
	// it routes to the available gpt registry model.
	assert.match(d.args.chain[1].model, /gpt/);
});

test('judgeFamily:"same" disables rerouting even when another family exists', () => {
	const { p, state } = setup("jr3");
	state.judgeFamilies = ["claude", "gpt"];
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 1, judgeFamily: "same" });
	assert.equal(d.args.chain[1].model, "anthropic/claude-opus-4-8");
});

test("the divergent selector position-swaps its candidate reads by seq", () => {
	const { p, state } = setup("jr4");
	state.seq = 1; // rotate by 1
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 3 });
	const reads = d.args.chain[1].reads;
	// reads = [briefPath, frame, architecture, ...candidatePlans-rotated]
	const candidates = reads.filter((r) => /plan-\d\/plan\.md$/.test(r));
	assert.equal(candidates.length, 3);
	// seq=1 rotation of [plan-1, plan-2, plan-3] → [plan-2, plan-3, plan-1].
	assert.match(candidates[0], /plan-2\/plan\.md$/);
	assert.match(candidates[2], /plan-1\/plan\.md$/);
});

test("seq=0 leaves candidate order unrotated (stable baseline)", () => {
	const { p, state } = setup("jr5");
	state.seq = 0;
	const d = planDirective(p, state, { ...DEFAULT_CONFIG, planCount: 3 });
	const candidates = d.args.chain[1].reads.filter((r) => /plan-\d\/plan\.md$/.test(r));
	assert.match(candidates[0], /plan-1\/plan\.md$/);
});
