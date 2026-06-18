import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loopDirective } from "../extensions/lib/directives.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { VERIFY_DIMENSIONS, createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-loop-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p); // makeBriefStep writes brief files under p.logs
	const state = createState("feat", "feat", "base123");
	state.phase = "loop";
	state.loopIteration = 1;
	state.failedDimensions = ["security", "tests"]; // only 2 of 5 failed
	return { p, state };
}

/** The re-verify fan-out is the parallel group at the end of the loop chain. */
function reVerifyGroup(directive) {
	const chain = directive.args.chain;
	return chain[chain.length - 1].parallel;
}

test("reverifyAllInLoop=true re-verifies ALL five dimensions, not just the failed ones", () => {
	const { p, state } = setup();
	const d = loopDirective(p, state, { ...DEFAULT_CONFIG, reverifyAllInLoop: true });
	const group = reVerifyGroup(d);
	assert.equal(group.length, VERIFY_DIMENSIONS.length, "every dimension is re-verified");
	const outputs = group.map((t) => t.output);
	for (const dim of VERIFY_DIMENSIONS) {
		assert.ok(outputs.some((o) => o.endsWith(`${dim}.md`)), `re-verifies ${dim}`);
	}
});

test("fix steps stay scoped to the failed dimensions only", () => {
	const { p, state } = setup();
	const d = loopDirective(p, state, { ...DEFAULT_CONFIG, reverifyAllInLoop: true });
	const chain = d.args.chain;
	const fixSteps = chain.slice(0, chain.length - 1);
	assert.equal(fixSteps.length, state.failedDimensions.length, "only failed dims get a fix step");
});

test("passing dimensions are labelled as regression checks, failed ones as re-verify", () => {
	const { p, state } = setup();
	const d = loopDirective(p, state, { ...DEFAULT_CONFIG, reverifyAllInLoop: true });
	const group = reVerifyGroup(d);
	const byOutput = (dim) => group.find((t) => t.output.endsWith(`${dim}.md`));
	assert.match(byOutput("security").label, /Re-verify/);
	assert.match(byOutput("code-quality").label, /Regression-check/);
});

test("reverifyAllInLoop=false restores the cheaper failed-only behavior", () => {
	const { p, state } = setup();
	const d = loopDirective(p, state, { ...DEFAULT_CONFIG, reverifyAllInLoop: false });
	const group = reVerifyGroup(d);
	assert.equal(group.length, state.failedDimensions.length);
});
