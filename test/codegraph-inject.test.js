import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import {
  architectDirective,
  buildDirective,
  fixupDirective,
  intakeDirective,
  verifyDirective,
} from "../extensions/lib/directives.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

/** A workspace on disk + a state ready for directive builders. */
function workspace(codegraphReady) {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-inject-"));
  const p = workPaths(cwd, ".pi/task", "x");
  ensureWorkTree(p);
  const state = createState("f", "x", null);
  state.slices = ["001-x.md"];
  state.sliceIndex = 0;
  state.codegraphReady = codegraphReady;
  return { p, state };
}

// --- codegraphReady === true ---------------------------------------------------

test("buildDirective builder step gets [codegraph, slice-rules] when ready", () => {
  const { p, state } = workspace(true);
  const d = buildDirective(p, state, DEFAULT_CONFIG);
  assert.deepEqual(d.args.chain[0].skill, ["codegraph", "slice-rules"]);
});

test("fixupDirective builder step gets [codegraph, slice-rules] when ready", () => {
  const { p, state } = workspace(true);
  state.fixupRound = 1;
  const d = fixupDirective(p, state, DEFAULT_CONFIG);
  assert.deepEqual(d.args.chain[0].skill, ["codegraph", "slice-rules"]);
});

test("intakeDirective chain step gets skill 'codegraph' when ready", () => {
  const { p, state } = workspace(true);
  const d = intakeDirective(p, state, DEFAULT_CONFIG);
  assert.equal(d.args.chain[0].skill, "codegraph");
});

test("every architect hypothesis task gets skill 'codegraph' when ready", () => {
  const { p, state } = workspace(true);
  const d = architectDirective(p, state, DEFAULT_CONFIG);
  const hyps = d.args.chain[0].parallel;
  assert.ok(hyps.length >= 1);
  for (const t of hyps) assert.equal(t.skill, "codegraph");
});

// --- codegraphReady === false (byte-identical to today) ------------------------

test("buildDirective builder step keeps skill 'slice-rules' when not ready", () => {
  const { p, state } = workspace(false);
  const d = buildDirective(p, state, DEFAULT_CONFIG);
  assert.equal(d.args.chain[0].skill, "slice-rules");
});

test("fixupDirective builder step keeps skill 'slice-rules' when not ready", () => {
  const { p, state } = workspace(false);
  state.fixupRound = 1;
  const d = fixupDirective(p, state, DEFAULT_CONFIG);
  assert.equal(d.args.chain[0].skill, "slice-rules");
});

test("intakeDirective chain step has no skill property when not ready", () => {
  const { p, state } = workspace(false);
  const d = intakeDirective(p, state, DEFAULT_CONFIG);
  assert.equal("skill" in d.args.chain[0], false);
});

test("architect hypothesis tasks have no skill property when not ready", () => {
  const { p, state } = workspace(false);
  const d = architectDirective(p, state, DEFAULT_CONFIG);
  for (const t of d.args.chain[0].parallel) assert.equal("skill" in t, false);
});

// --- exclusions hold even when ready ------------------------------------------

test("review step in build/fixup never carries codegraph", () => {
  const { p, state } = workspace(true);
  const build = buildDirective(p, state, DEFAULT_CONFIG);
  const reviewSkill = build.args.chain[1].skill;
  assert.ok(!flatSkill(reviewSkill).includes("codegraph"));

  state.fixupRound = 1;
  const fixup = fixupDirective(p, state, DEFAULT_CONFIG);
  assert.ok(!flatSkill(fixup.args.chain[1].skill).includes("codegraph"));
});

test("verify tasks keep skill 'verify-rubrics' and never carry codegraph", () => {
  const { p, state } = workspace(true);
  const d = verifyDirective(p, state, DEFAULT_CONFIG);
  for (const t of d.args.tasks) {
    assert.equal(t.skill, "verify-rubrics");
    assert.ok(!flatSkill(t.skill).includes("codegraph"));
  }
});

test("architect judge step carries no codegraph skill when ready", () => {
  const { p, state } = workspace(true);
  const d = architectDirective(p, state, DEFAULT_CONFIG);
  const judge = d.args.chain[1];
  assert.ok(!flatSkill(judge.skill).includes("codegraph"));
});

function flatSkill(skill) {
  if (skill === undefined) return [];
  return Array.isArray(skill) ? skill : [skill];
}
