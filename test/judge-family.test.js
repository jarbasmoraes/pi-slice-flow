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

test("cheap tier routes to the family's cheapModel; strong keeps the flagship", () => {
	const strong = resolveJudge(CLAUDE, null, new Set(["claude", "gpt"]), "cross", "strong");
	assert.equal(strong.model, "openai-codex/gpt-5.5");
	const cheap = resolveJudge(CLAUDE, null, new Set(["claude", "gpt"]), "cross", "cheap");
	assert.equal(cheap.model, "openai-codex/gpt-5.4-mini");
	assert.equal(cheap.crossed, true);
});

test("tier defaults to strong when omitted", () => {
	const r = resolveJudge(CLAUDE, null, new Set(["claude", "gpt"]), "cross");
	assert.equal(r.model, "openai-codex/gpt-5.5");
});

test("cheap tier prefers the free local family when available; strong is never handed to it", () => {
	const fams = new Set(["claude", "gpt", "qwen"]);
	const cheap = resolveJudge(CLAUDE, null, fams, "cross", "cheap");
	assert.equal(cheap.model, "ollama/qwen3.6-coder:latest", "cheap routes to the local family first");
	const strong = resolveJudge(CLAUDE, null, fams, "cross", "strong");
	assert.equal(strong.model, "openai-codex/gpt-5.5", "strong skips the cheap-only family");
});

test("a cheap-only family alone cannot take strong judging: degrade + caveat", () => {
	const r = resolveJudge(CLAUDE, null, new Set(["claude", "qwen"]), "cross", "strong");
	assert.equal(r.model, CLAUDE);
	assert.equal(r.crossed, false);
	assert.match(r.caveat, /self-preference bias/);
});

test("cheap tier still degrades to the configured judge + caveat when only the host family exists", () => {
	const cheapJudge = "anthropic/claude-sonnet-5";
	const r = resolveJudge(cheapJudge, null, new Set(["claude"]), "cross", "cheap");
	assert.equal(r.model, cheapJudge);
	assert.equal(r.crossed, false);
	assert.match(r.caveat, /only the claude family is available/);
});

test("a non-Claude builder flips which family is 'self'", () => {
	// Builder on GPT, judge configured GPT → same-family; route to claude.
	const r = resolveJudge(GPT, GPT, new Set(["claude", "gpt"]), "cross");
	assert.equal(modelFamily(r.model), "claude");
	assert.equal(r.crossed, true);
});

// --- detectJudgeFamilies ------------------------------------------------------

test("detectJudgeFamilies always includes claude and adds families whose route model is runnable", async () => {
	const fams = await detectJudgeFamilies([
		{ provider: "anthropic", id: "claude-opus-4-8" },
		{ provider: "openai-codex", id: "gpt-5.5" },
	]);
	assert.ok(fams.includes("claude"));
	assert.ok(fams.includes("gpt"));
});

test("detectJudgeFamilies degrades to claude-only when no registry route model is available", async () => {
	assert.deepEqual(await detectJudgeFamilies([{ provider: "anthropic", id: "claude-opus-4-8" }]), ["claude"]);
	assert.deepEqual(await detectJudgeFamilies([]), ["claude"]);
});

test("an available model that is not a registry route model does not enable its family", async () => {
	// Only the exact route model counts: a stray gpt-family model pi can run is
	// not what resolveJudge would route to.
	assert.deepEqual(await detectJudgeFamilies([{ provider: "openai-codex", id: "gpt-5.3-codex-spark" }]), ["claude"]);
});

test("a local (http) family needs its endpoint to answer the probe; hosted families do not", async () => {
	const models = [
		{ provider: "openai-codex", id: "gpt-5.5", baseUrl: "https://chatgpt.com/backend-api" },
		{ provider: "ollama", id: "qwen3.6-coder:latest", baseUrl: "http://jarbass-macbook-pro.local:11434/v1" },
	];
	const up = await detectJudgeFamilies(models, async () => true);
	assert.deepEqual(new Set(up), new Set(["claude", "gpt", "qwen"]));
	const down = await detectJudgeFamilies(models, async () => false);
	assert.deepEqual(new Set(down), new Set(["claude", "gpt"]), "offline LAN server drops qwen, never gpt");
	const throwing = await detectJudgeFamilies(models, async () => {
		throw new Error("ECONNREFUSED");
	});
	assert.deepEqual(new Set(throwing), new Set(["claude", "gpt"]), "a throwing probe is absence, not a crash");
});

test("without a probe, a local family is taken on registry presence alone", async () => {
	const fams = await detectJudgeFamilies([{ provider: "ollama", id: "qwen3.6-coder:latest", baseUrl: "http://host:11434/v1" }]);
	assert.ok(fams.includes("qwen"));
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
