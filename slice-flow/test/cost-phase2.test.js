import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { loopDirective } from "../extensions/lib/directives.ts";
import { startAttack } from "../extensions/lib/engine.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

function setup(slug = "feat") {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cost-"));
	const p = workPaths(cwd, ".pi/task", slug);
	ensureWorkTree(p);
	const state = createState("feat", slug, "base123");
	return { cwd, p, state };
}

test("#2 loop re-verify routes failed dims to verify (opus) and regression dims to verifyRegression (sonnet)", () => {
	const { p, state } = setup();
	state.phase = "loop";
	state.loopIteration = 1;
	state.failedDimensions = ["security"]; // 1 failed; the other 4 are regression-checks
	const d = loopDirective(p, state, DEFAULT_CONFIG);
	const reVerify = d.args.chain[d.args.chain.length - 1].parallel;
	const byLabel = (re) => reVerify.find((t) => re.test(t.label));
	assert.equal(byLabel(/Re-verify security/).model, DEFAULT_CONFIG.models.verify); // opus
	assert.equal(byLabel(/Regression-check code-quality/).model, DEFAULT_CONFIG.models.verifyRegression); // sonnet
	assert.equal(byLabel(/Regression-check tests/).model, DEFAULT_CONFIG.models.verifyRegression);
});

test("#5 prototypeCount default is 3", () => {
	assert.equal(DEFAULT_CONFIG.prototypeCount, 3);
});

test("#11 startAttack skips a re-attack when the ledger is byte-identical", () => {
	const { p, state } = setup();
	state.frameStage = "explore";
	writeFileSync(p.ledger, "## Decision\nWe will build X.\n", "utf8");

	const first = startAttack(p, DEFAULT_CONFIG, state);
	assert.ok(state.pending, "first attack issues a directive");
	assert.ok(state.lastAttackedLedgerHash, "the attacked ledger hash is recorded");
	assert.ok(!/unchanged/.test(first), "first attack actually runs");

	// The parent runs the directive and calls next, which clears pending before
	// the user can request another attack.
	state.pending = null;
	const second = startAttack(p, DEFAULT_CONFIG, state);
	assert.match(second, /unchanged since the last attack/);
	assert.equal(state.pending, null, "no new directive was issued");
});

test("#11 a ledger edit makes startAttack run again", () => {
	const { p, state } = setup();
	state.frameStage = "explore";
	writeFileSync(p.ledger, "v1\n", "utf8");
	startAttack(p, DEFAULT_CONFIG, state);
	const h1 = state.lastAttackedLedgerHash;
	state.pending = null; // next() cleared it

	writeFileSync(p.ledger, "v1\n## New objection resolved\nv2\n", "utf8");
	const again = startAttack(p, DEFAULT_CONFIG, state);
	assert.ok(!/unchanged/.test(again), "edited ledger re-attacks");
	assert.notEqual(state.lastAttackedLedgerHash, h1, "the recorded hash advanced");
});
