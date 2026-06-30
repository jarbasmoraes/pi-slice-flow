import { test } from "node:test";
import assert from "node:assert/strict";

import { modelFamily, resolveJudge, detectJudgeFamilies, positionSwap } from "../extensions/lib/judge-family.ts";

// --- modelFamily --------------------------------------------------------------

test("modelFamily extracts coarse families; null defaults to claude (builder default)", () => {
	assert.equal(modelFamily("anthropic/claude-opus-4-8"), "claude");
	assert.equal(modelFamily("openai-codex/gpt-5.5"), "gpt");
	assert.equal(modelFamily("google-gemini/gemini-2.5-pro"), "gemini");
	assert.equal(modelFamily("ollama/qwen2.5"), "qwen");
	assert.equal(modelFamily(null), "claude");
});

// --- resolveJudge -------------------------------------------------------------

const CLAUDE = "anthropic/claude-opus-4-8";
const GPT = "openai-codex/gpt-5.5";

test("cross mode routes a same-family judge to an available other family", () => {
	const r = resolveJudge(CLAUDE, null /* claude builder */, new Set(["claude", "gpt"]), "cross");
	assert.equal(modelFamily(r.model), "gpt");
	assert.equal(r.crossed, true);
	assert.equal(r.caveat, undefined);
});

test("cross mode keeps a judge that is already cross-family", () => {
	const r = resolveJudge(GPT, null /* claude builder */, new Set(["claude", "gpt"]), "cross");
	assert.equal(r.model, GPT);
	assert.equal(r.crossed, true);
});

test("cross mode degrades to the configured judge + caveat when only the host family exists", () => {
	const r = resolveJudge(CLAUDE, null, new Set(["claude"]), "cross");
	assert.equal(r.model, CLAUDE, "keeps the configured Claude judge");
	assert.equal(r.crossed, false);
	assert.match(r.caveat, /only the claude family is available/);
	assert.match(r.caveat, /position-swap/);
});

test("same mode never reroutes, but still reports whether it happens to be cross", () => {
	const same = resolveJudge(CLAUDE, null, new Set(["claude", "gpt"]), "same");
	assert.equal(same.model, CLAUDE);
	assert.equal(same.crossed, false);
	const cross = resolveJudge(GPT, null, new Set(["claude", "gpt"]), "same");
	assert.equal(cross.model, GPT);
	assert.equal(cross.crossed, true);
});

test("a non-Claude builder flips which family is 'self'", () => {
	// Builder on GPT, judge configured GPT → same-family; route to claude.
	const r = resolveJudge(GPT, GPT, new Set(["claude", "gpt"]), "cross");
	assert.equal(modelFamily(r.model), "claude");
	assert.equal(r.crossed, true);
});

// --- detectJudgeFamilies ------------------------------------------------------

test("detectJudgeFamilies always includes claude and adds families whose CLI is present", async () => {
	const exec = async (_cmd, args) => ({ code: args[0] === "codex" ? 0 : 1 });
	const fams = await detectJudgeFamilies(exec);
	assert.ok(fams.includes("claude"));
	assert.ok(fams.includes("gpt"));
});

test("detectJudgeFamilies degrades to claude-only when no extra CLI is found", async () => {
	const exec = async () => ({ code: 1 });
	assert.deepEqual(await detectJudgeFamilies(exec), ["claude"]);
});

test("a throwing probe is treated as absent, never crashes", async () => {
	const exec = async () => {
		throw new Error("no such command");
	};
	assert.deepEqual(await detectJudgeFamilies(exec), ["claude"]);
});

// --- positionSwap -------------------------------------------------------------

test("positionSwap rotates by seq, stable within a run and varying across runs", () => {
	const items = ["a", "b", "c"];
	assert.deepEqual(positionSwap(items, 0), ["a", "b", "c"]);
	assert.deepEqual(positionSwap(items, 1), ["b", "c", "a"]);
	assert.deepEqual(positionSwap(items, 2), ["c", "a", "b"]);
	assert.deepEqual(positionSwap(items, 3), ["a", "b", "c"], "wraps around");
});

test("positionSwap is a no-op for 0/1 items and does not mutate input", () => {
	assert.deepEqual(positionSwap([], 5), []);
	assert.deepEqual(positionSwap(["only"], 5), ["only"]);
	const src = ["a", "b"];
	positionSwap(src, 1);
	assert.deepEqual(src, ["a", "b"], "input is not mutated");
});
