import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { architectDirective, buildDirective, loopDirective, planDirective, prototypeDirective } from "../extensions/lib/directives.ts";
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

// --- per-slice reviewer -------------------------------------------------------

test("the per-slice reviewer cross-routes like a judge when another family exists", () => {
	const { p, state } = setup("jr6");
	state.judgeFamilies = ["claude", "gpt"];
	state.slices = ["001-demo.md"];
	const d = buildDirective(p, state, DEFAULT_CONFIG);
	// chain = [builder, reviewer]; review: null is same-family (claude) → routed.
	assert.match(d.args.chain[1].model, /gpt/);
	assert.equal(d.args.chain[0].model, undefined, "the builder itself is never rerouted");
});

test("Claude-only: the reviewer keeps inheriting its agent default (no override)", () => {
	const { p, state } = setup("jr7");
	state.judgeFamilies = ["claude"];
	state.slices = ["001-demo.md"];
	const d = buildDirective(p, state, DEFAULT_CONFIG);
	assert.equal(d.args.chain[1].model, undefined);
});

// --- tier-aware loop re-verification -------------------------------------------

test("regression re-checks cross-route at the cheap tier; failed dims at the strong tier", () => {
	const { p, state } = setup("jr8");
	state.judgeFamilies = ["claude", "gpt"];
	state.phase = "loop";
	state.loopIteration = 1;
	state.failedDimensions = ["security"];
	const d = loopDirective(p, state, { ...DEFAULT_CONFIG, reverifyAllInLoop: true });
	const group = d.args.chain.at(-1).parallel;
	const regression = group.find((t) => /Regression-check/.test(t.label));
	const failed = group.find((t) => /Re-verify security/.test(t.label));
	assert.equal(regression.model, "openai-codex/gpt-5.6-terra", "cheap tier is preserved across the family boundary");
	assert.equal(failed.model, "openai-codex/gpt-5.6-sol", "dims under repair keep the strong tier");
});

test("with a live local family, regression re-checks go local while strong stays hosted", () => {
	const { p, state } = setup("jr8b");
	state.judgeFamilies = ["claude", "gpt", "qwen"];
	state.phase = "loop";
	state.loopIteration = 1;
	state.failedDimensions = ["security"];
	const d = loopDirective(p, state, { ...DEFAULT_CONFIG, reverifyAllInLoop: true });
	const group = d.args.chain.at(-1).parallel;
	assert.equal(group.find((t) => /Regression-check/.test(t.label)).model, "ollama/qwen3.6-coder:latest");
	assert.equal(group.find((t) => /Re-verify security/.test(t.label)).model, "openai-codex/gpt-5.6-sol");
});

// --- comparative judges position-swap -------------------------------------------

test("the architecture judge position-swaps its hypothesis reads by seq", () => {
	const { p, state } = setup("jr9");
	state.seq = 1;
	const d = architectDirective(p, state, DEFAULT_CONFIG);
	const generated = d.args.chain[0].parallel.map((t) => t.output);
	const judged = d.args.chain[1].reads.filter((r) => /hypothesis-[^/]+\.md$/.test(r));
	assert.equal(judged.length, generated.length);
	assert.deepEqual(judged, [...generated.slice(1), generated[0]], "seq=1 rotates the candidate order by one");
});

test("the prototype judge brief lists candidates in position-swapped order", () => {
	const { p, state } = setup("jr10");
	state.seq = 1;
	const d = prototypeDirective(p, state, { ...DEFAULT_CONFIG, prototypeCount: 3 });
	const brief = readFileSync(d.args.chain[1].reads[0], "utf8");
	assert.match(brief, /proto-2, proto-3, proto-1/, "the brief carries the rotated inspection order");
});
