import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, modelWeight } from "../extensions/lib/config.ts";
import { loopIterationCost } from "../extensions/lib/directives.ts";
import { createState } from "../extensions/lib/workspace.ts";

function loopState(failed) {
	const state = createState("feat", "feat", "base123");
	state.phase = "loop";
	state.failedDimensions = failed;
	return state;
}

test("modelWeight resolves families by lowercase substring, with a default fallback", () => {
	const w = { opus: 1, sonnet: 0.25, haiku: 0.08, default: 0.5 };
	assert.equal(modelWeight("anthropic/claude-opus-4-8", w), 1);
	assert.equal(modelWeight("anthropic/claude-sonnet-4-6", w), 0.25);
	assert.equal(modelWeight("anthropic/claude-haiku-4-5", w), 0.08);
	assert.equal(modelWeight(null, w), 0.5, "session-default (null) model uses default weight");
	assert.equal(modelWeight("some/unknown-model", w), 0.5, "unknown family uses default weight");
});

test("modelWeight falls back to 0.5 when no default is configured", () => {
	assert.equal(modelWeight("mystery", {}), 0.5);
});

test("loopIterationCost on DEFAULT_CONFIG tiers regression dims to the cheaper model", () => {
	// reverifyAllInLoop=true → all 5 dims re-run. The 1 FAILED dim uses verify
	// (opus, weight 1); the other 4 are regression-checks on verifyRegression
	// (sonnet, weight 0.25 each = 1.0); fixup is null → default 0.5 per failed dim.
	const cost = loopIterationCost(loopState(["security"]), DEFAULT_CONFIG);
	assert.equal(cost, 1 * 1 + 4 * 0.25 + 1 * 0.5); // 2.5 (was 5.5 before tiering)
});

test("loopIterationCost scales failed (opus) vs regression (sonnet) verifiers and fixers", () => {
	// 3 failed (opus), 2 regression (sonnet), 3 fixers (default).
	const cost = loopIterationCost(loopState(["security", "tests", "evals"]), DEFAULT_CONFIG);
	assert.equal(cost, 3 * 1 + 2 * 0.25 + 3 * 0.5); // 5.0
});

test("reverifyAllInLoop=false only charges for the failed dimensions' verifiers", () => {
	const cfg = { ...DEFAULT_CONFIG, reverifyAllInLoop: false };
	const cost = loopIterationCost(loopState(["security", "tests"]), cfg);
	assert.equal(cost, 2 * 1 + 2 * 0.5); // 2 verifiers + 2 fixers = 3
});

test("tiering the verify model down (sonnet) lowers the iteration cost", () => {
	const cfg = { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, verify: "anthropic/claude-sonnet-4-6" } };
	const cost = loopIterationCost(loopState(["security"]), cfg);
	// failed dim now sonnet (0.25) + 4 regression sonnet (1.0) + fixer (0.5).
	assert.equal(cost, 1 * 0.25 + 4 * 0.25 + 1 * 0.5); // 1.75
});

test("DEFAULT_CONFIG ships the new deterministic budget knobs (and not the old token meter)", () => {
	assert.equal(typeof DEFAULT_CONFIG.loopCostBudget, "number");
	assert.equal(typeof DEFAULT_CONFIG.modelWeights, "object");
	assert.equal(DEFAULT_CONFIG.modelWeights.opus, 1);
	assert.ok(!("loopTokenBudget" in DEFAULT_CONFIG), "the chars/4 token budget is gone");
});
