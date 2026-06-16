import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { startWorkflow } from "../extensions/lib/engine.ts";
import { codegraphPreamble } from "../extensions/lib/codegraph.ts";
import { loadState, workPaths } from "../extensions/lib/workspace.ts";

/** Run startWorkflow on a throwaway cwd. syncBundledAgents provisions the
 * bundled agents into <cwd>/.pi/agents/, so preflight passes without setup. */
function runStart(codegraphState) {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-start-"));
  const p = workPaths(cwd, ".pi/task", "feat");
  const text = startWorkflow(p, DEFAULT_CONFIG, "Feat", "feat", "base123", cwd, codegraphState);
  // The preamble is everything before the directive's "## <label>" heading.
  const preamble = text.split("\n## ")[0];
  return { p, text, preamble };
}

/** The exact startup line emitted today, with no codegraph announcement. */
function basePreamble(p) {
  return `slice-flow started. Task slug: feat (folder ${p.root}). Pass "slug":"feat" on every follow-up slice_flow call. Baseline commit: base123.`;
}

// --- the detection→injection bridge (gates AC 5/6) -----------------------------

test("startWorkflow persists codegraphReady=true only for 'ready'", () => {
  const { p } = runStart("ready");
  const state = loadState(p);
  assert.ok(state !== null);
  assert.equal(state.codegraphReady, true);
});

test("startWorkflow persists codegraphReady=false for 'nudge'", () => {
  const { p } = runStart("nudge");
  assert.equal(loadState(p).codegraphReady, false);
});

test("startWorkflow persists codegraphReady=false for 'silent'", () => {
  const { p } = runStart("silent");
  assert.equal(loadState(p).codegraphReady, false);
});

// --- the startup announcement (AC 2/3/4, AC 10 "appending" half) ----------------

test("startWorkflow appends the ready announcement to the preamble (AC 2)", () => {
  const { p, preamble } = runStart("ready");
  assert.equal(preamble, `${basePreamble(p)}\n${codegraphPreamble("ready")}`);
  assert.match(preamble, /scout and builder use codegraph/);
});

test("startWorkflow appends the nudge announcement to the preamble (AC 3)", () => {
  const { p, preamble } = runStart("nudge");
  assert.equal(preamble, `${basePreamble(p)}\n${codegraphPreamble("nudge")}`);
  assert.match(preamble, /codegraph init/);
});

test("startWorkflow preamble is byte-identical to today when silent (AC 4)", () => {
  const { p, preamble } = runStart("silent");
  assert.equal(preamble, basePreamble(p));
  assert.doesNotMatch(preamble, /codegraph/);
});
