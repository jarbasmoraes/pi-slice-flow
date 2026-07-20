import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextStep } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

const NO_UI = { hasUI: false, ui: {} };

function setup(slug, intakeBody) {
  const cwd = mkdtempSync(join(tmpdir(), `tier-intake-${slug}-`));
  const p = workPaths(cwd, ".pi/task", "feat");
  ensureWorkTree(p);
  const state = createState("add retry to webhooks", "feat", "base123");
  state.pending = { kind: "intake", label: "intake check" };
  writeFileSync(p.intake, intakeBody);
  return { cwd, p, state };
}

test("intake TIER: GATED writes HANDOFF.md and tells the framing partner", async () => {
  const { cwd, p, state } = setup("gated", "INTAKE: SUFFICIENT\nTIER: GATED\n- contained one-module change\n");
  const msg = await nextStep(NO_UI, p, DEFAULT_CONFIG, state, undefined, cwd);
  const handoff = join(p.frameDir, "HANDOFF.md");
  assert.ok(existsSync(handoff), "HANDOFF.md must be written for a GATED verdict");
  const body = readFileSync(handoff, "utf8");
  assert.ok(body.includes("add retry to webhooks"), "handoff carries the feature verbatim");
  assert.ok(body.includes("INTAKE: SUFFICIENT"), "handoff embeds the intake assessment");
  assert.ok(body.includes(cwd), "handoff names the real project root");
  assert.ok(msg.includes("TIER: GATED"), "explore preamble surfaces the verdict");
  assert.ok(msg.includes(handoff), "explore preamble points at the handoff");
  assert.equal(state.frameStage, "explore", "workflow still advances — the gate stays human");
});

test("intake TIER: FULL proceeds without a handoff", async () => {
  const { cwd, p, state } = setup("full", "INTAKE: SUFFICIENT\nTIER: FULL\n- architectural reach\n");
  const msg = await nextStep(NO_UI, p, DEFAULT_CONFIG, state, undefined, cwd);
  assert.ok(!existsSync(join(p.frameDir, "HANDOFF.md")));
  assert.ok(!msg.includes("TIER: GATED"));
  assert.equal(state.frameStage, "explore");
});

test("intake without a TIER marker defaults to FULL (older intakes)", async () => {
  const { cwd, p, state } = setup("legacy", "INTAKE: SUFFICIENT\nno tier line\n");
  await nextStep(NO_UI, p, DEFAULT_CONFIG, state, undefined, cwd);
  assert.ok(!existsSync(join(p.frameDir, "HANDOFF.md")));
});
