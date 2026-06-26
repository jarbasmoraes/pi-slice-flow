import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import {
  architectDirective,
  attackDirective,
  buildDirective,
  prototypeDirective,
  researchDirective,
  verifyDirective,
} from "../extensions/lib/directives.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

/** A workspace on disk + a state ready for directive builders. */
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-model-fanout-"));
  const p = workPaths(cwd, ".pi/task", "x");
  ensureWorkTree(p);
  const state = createState("f", "x", null);
  state.slices = ["001-x.md"];
  state.sliceIndex = 0;
  return { p, state };
}

/** A config with one phase's model spec overridden. */
function cfgWith(models) {
  return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models, ...models } };
}

// --- single string applies to every parallel run -----------------------------

test("a single string model applies to every fan-out run", () => {
  const { p, state } = workspace();
  const d = attackDirective(p, state, cfgWith({ attack: "anthropic/claude-opus-4-8" }));
  for (const t of d.args.tasks) {
    assert.equal(t.model, "anthropic/claude-opus-4-8");
  }
});

// --- a list round-robins across the parallel runs ----------------------------

test("attack list round-robins across the parallel adversaries", () => {
  const { p, state } = workspace();
  const list = ["openai-codex/gpt-5.5", "anthropic/claude-opus-4-8", "ollama/qwen3-coder-next:latest"];
  const d = attackDirective(p, state, cfgWith({ attack: list }));
  assert.deepEqual(d.args.tasks.map((t) => t.model), list.slice(0, d.args.tasks.length));
});

test("hypothesis list assigns a distinct model per architecture angle", () => {
  const { p, state } = workspace();
  const list = ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.5", "anthropic/claude-sonnet-4-6"];
  const d = architectDirective(p, state, cfgWith({ hypothesis: list }));
  const models = d.args.chain[0].parallel.map((t) => t.model);
  assert.deepEqual(models, list.slice(0, models.length));
});

test("prototype list round-robins (and wraps if shorter than the run count)", () => {
  const { p, state } = workspace();
  const list = ["anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.4"];
  // prototypeCount is a top-level config key (default 3), not a models key.
  const d = prototypeDirective(p, state, { ...cfgWith({ prototype: list }), prototypeCount: 4 });
  const models = d.args.chain[0].parallel.map((t) => t.model);
  assert.deepEqual(models, [list[0], list[1], list[0], list[1]]);
});

test("research list round-robins across the per-question researchers", () => {
  const { p, state } = workspace();
  const list = ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.4-mini", "ollama/qwen3.6-27b-256k:latest"];
  const questions = ["q one", "q two", "q three", "q four"];
  const d = researchDirective(p, state, cfgWith({ research: list }), questions);
  assert.deepEqual(
    d.args.tasks.map((t) => t.model),
    [list[0], list[1], list[2], list[0]],
  );
});

test("verify list assigns a model per dimension in order", () => {
  const { p, state } = workspace();
  const list = ["a/one", "b/two", "c/three", "d/four", "e/five"];
  const d = verifyDirective(p, state, cfgWith({ verify: list }));
  assert.deepEqual(d.args.tasks.map((t) => t.model), list);
});

// --- null still inherits (no model field emitted) ----------------------------

test("a null spec emits no model field on any run", () => {
  const { p, state } = workspace();
  const d = attackDirective(p, state, cfgWith({ attack: null }));
  for (const t of d.args.tasks) {
    assert.equal("model" in t, false);
  }
});

// --- an empty list inherits rather than crashing -----------------------------

test("an empty list emits no model field", () => {
  const { p, state } = workspace();
  const d = buildDirective(p, state, cfgWith({ build: [] }));
  assert.equal("model" in d.args.chain[0], false);
});
