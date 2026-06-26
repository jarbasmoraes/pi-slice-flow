import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, modelWeight } from "../extensions/lib/config.ts";
import { loopIterationCost } from "../extensions/lib/directives.ts";
import { VERIFY_DIMENSIONS, createState } from "../extensions/lib/workspace.ts";

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

test("loopIterationCost on DEFAULT_CONFIG: 1 failed dim = 5 opus verifiers + 1 default fixer", () => {
	// reverifyAllInLoop=true → all 5 dims re-verified at models.verify (opus, weight 1);
	// fixup model is null → default weight 0.5; one fixer per failed dim.
	const cost = loopIterationCost(loopState(["security"]), DEFAULT_CONFIG);
	assert.equal(cost, VERIFY_DIMENSIONS.length * 1 + 1 * 0.5); // 5.5
});

test("loopIterationCost scales the fixer term with the number of failed dimensions", () => {
	const cost = loopIterationCost(loopState(["security", "tests", "evals"]), DEFAULT_CONFIG);
	assert.equal(cost, VERIFY_DIMENSIONS.length * 1 + 3 * 0.5); // 6.5
});

test("reverifyAllInLoop=false only charges for the failed dimensions' verifiers", () => {
	const cfg = { ...DEFAULT_CONFIG, reverifyAllInLoop: false };
	const cost = loopIterationCost(loopState(["security", "tests"]), cfg);
	assert.equal(cost, 2 * 1 + 2 * 0.5); // 2 verifiers + 2 fixers = 3
});

test("tiering the verify model down (sonnet) lowers the iteration cost", () => {
	const cfg = { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, verify: "anthropic/claude-sonnet-4-6" } };
	const cost = loopIterationCost(loopState(["security"]), cfg);
	assert.equal(cost, VERIFY_DIMENSIONS.length * 0.25 + 1 * 0.5); // 1.75 — far cheaper than 5.5
});

test("DEFAULT_CONFIG ships the new deterministic budget knobs (and not the old token meter)", () => {
	assert.equal(typeof DEFAULT_CONFIG.loopCostBudget, "number");
	assert.equal(typeof DEFAULT_CONFIG.modelWeights, "object");
	assert.equal(DEFAULT_CONFIG.modelWeights.opus, 1);
	assert.ok(!("loopTokenBudget" in DEFAULT_CONFIG), "the chars/4 token budget is gone");
});
