import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, applyTier, loadConfig } from "../extensions/lib/config.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- applyTier: the per-task model scaling ------------------------------------

test("applyTier('medium') equals the un-tiered baseline (empty preset)", () => {
	const tiered = applyTier(DEFAULT_CONFIG, "medium");
	assert.deepEqual(tiered.models, DEFAULT_CONFIG.models);
});

test("applyTier(undefined) returns the config untouched (fail-soft for pre-tier tasks)", () => {
	const tiered = applyTier(DEFAULT_CONFIG, undefined);
	assert.deepEqual(tiered.models, DEFAULT_CONFIG.models);
});

test("applyTier('hard') fans a SOTA flagship across high-leverage roles", () => {
	const m = applyTier(DEFAULT_CONFIG, "hard").models;
	for (const role of ["compile", "frameJudge", "fusion", "hypothesis", "plan", "planJudge", "build", "verify"]) {
		assert.equal(m[role], "anthropic/claude-fable-5", `${role} should be the flagship on hard`);
	}
	// Mechanical discovery roles stay cheaper so cost lands where judgment matters.
	assert.equal(m.intake, "anthropic/claude-sonnet-5");
	assert.equal(m.research, "anthropic/claude-sonnet-5");
});

test("attack is cross-family (model-vs-model) in every tier", () => {
	for (const tier of ["easy", "medium", "hard"]) {
		const spec = applyTier(DEFAULT_CONFIG, tier).models.attack;
		assert.ok(Array.isArray(spec) && spec.length >= 2, `${tier}.attack should be a cross-family array`);
		const families = new Set(spec.map((id) => id.split("/")[0]));
		assert.ok(families.has("anthropic") && families.has("openai-codex"), `${tier}.attack should span Claude and GPT (got ${spec.join(", ")})`);
	}
	// hard attack leads with the flagship of each family.
	assert.deepEqual(applyTier(DEFAULT_CONFIG, "hard").models.attack, ["anthropic/claude-fable-5", "openai-codex/gpt-5.6-sol"]);
});

test("applyTier('easy') caps everything at a workhorse — no opus/fable anywhere", () => {
	const m = applyTier(DEFAULT_CONFIG, "easy").models;
	for (const [role, spec] of Object.entries(m)) {
		const ids = Array.isArray(spec) ? spec : spec ? [spec] : [];
		for (const id of ids) {
			assert.ok(!/opus|fable/.test(id), `easy tier role ${role} must not use a flagship model (got ${id})`);
		}
	}
	// Judges that are opus on the baseline drop to the workhorse on easy.
	assert.equal(m.frameJudge, "anthropic/claude-sonnet-5");
	assert.equal(m.verify, "anthropic/claude-sonnet-5");
});

test("applyTier does not mutate the input config", () => {
	const before = JSON.stringify(DEFAULT_CONFIG.models);
	applyTier(DEFAULT_CONFIG, "hard");
	assert.equal(JSON.stringify(DEFAULT_CONFIG.models), before);
});

test("single-provider modes pin every phase and disable cross-provider routing", () => {
	for (const [modelMode, provider, models] of [
		["anthropic", "anthropic", ["claude-haiku-4-5", "claude-sonnet-5", "claude-fable-5"]],
		["gpt", "openai-codex", ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]],
	]) {
		const cfg = { ...DEFAULT_CONFIG, modelMode };
		for (const [tier, expected] of [["easy", models[0]], ["medium", models[1]], ["hard", models[2]]]) {
			const resolved = applyTier(cfg, tier);
			assert.equal(resolved.judgeFamily, "same");
			for (const [role, spec] of Object.entries(resolved.models)) {
				const ids = Array.isArray(spec) ? spec : [spec];
				for (const id of ids) assert.equal(id, `${provider}/${expected}`, `${modelMode}.${tier}.${role} must stay on one provider`);
			}
		}
	}
});

test("mixed mode preserves the model-vs-model defaults", () => {
	const resolved = applyTier({ ...DEFAULT_CONFIG, modelMode: "mixed" }, "hard");
	assert.equal(resolved.judgeFamily, "cross");
	assert.deepEqual(resolved.models.attack, ["anthropic/claude-fable-5", "openai-codex/gpt-5.6-sol"]);
});

// --- config wiring ------------------------------------------------------------

test("defaultTier is 'medium' and all three tier presets exist", () => {
	assert.equal(DEFAULT_CONFIG.defaultTier, "medium");
	for (const t of ["easy", "medium", "hard"]) {
		assert.ok(DEFAULT_CONFIG.modelTiers[t], `missing tier preset: ${t}`);
	}
});

test("a project overlay can tune ONE role in ONE tier without restating the tier", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-tier-"));
	writeFileSync(join(cwd, "slice-flow.json"), JSON.stringify({ modelTiers: { hard: { build: "openai-codex/gpt-5.6-sol" } } }));
	const cfg = loadConfig(cwd, mkdtempSync(join(tmpdir(), "slice-flow-home-")));
	// The overridden role changes...
	assert.equal(cfg.modelTiers.hard.build, "openai-codex/gpt-5.6-sol");
	// ...while the rest of the hard tier is preserved from the defaults.
	assert.equal(cfg.modelTiers.hard.frameJudge, "anthropic/claude-fable-5");
	// ...and the other tiers are untouched.
	assert.deepEqual(cfg.modelTiers.easy, DEFAULT_CONFIG.modelTiers.easy);
});
