import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import {
  architectDirective,
  buildDirective,
  injectIsolationCwd,
  verifyDirective,
} from "../extensions/lib/directives.ts";
import { issue } from "../extensions/lib/engine.ts";
import { createState, ensureWorkTree, loadState, workPaths } from "../extensions/lib/workspace.ts";

const WT_CWD = "/repo/.pi/worktrees/feat";

function sampleWorktree() {
  return { cwd: WT_CWD, branch: "slice-flow/feat", path: WT_CWD, created_at: "2026-06-16T00:00:00.000Z" };
}

/** A workspace on disk + an isolated state, ready for directive builders. */
function isolatedWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-inject-"));
  const p = workPaths(cwd, ".pi/task", "feat");
  ensureWorkTree(p);
  const state = createState("Feat", "feat", "base123", { worktree: sampleWorktree() });
  state.slices = ["001-first.md", "002-second.md"];
  state.sliceIndex = 0;
  return { p, state };
}

/** Collect every object in the tree that carries an `agent` string. */
function agentNodes(node, acc = []) {
  if (Array.isArray(node)) {
    for (const n of node) agentNodes(n, acc);
  } else if (node && typeof node === "object") {
    if (typeof node.agent === "string") acc.push(node);
    for (const v of Object.values(node)) agentNodes(v, acc);
  }
  return acc;
}

test("injectIsolationCwd tags every agent object in a build chain with the worktree cwd", () => {
  const { p, state } = isolatedWorkspace();
  const directive = buildDirective(p, state, DEFAULT_CONFIG);
  injectIsolationCwd(directive.args, state);
  const nodes = agentNodes(directive.args);
  assert.ok(nodes.length >= 2, "builder step + reviewer step");
  for (const n of nodes) assert.equal(n.cwd, WT_CWD);
});

test("injectIsolationCwd tags every verify fan-out task", () => {
  const { p, state } = isolatedWorkspace();
  const directive = verifyDirective(p, state, DEFAULT_CONFIG);
  injectIsolationCwd(directive.args, state);
  const nodes = agentNodes(directive.args);
  assert.equal(nodes.length, 5, "one per VERIFY_DIMENSIONS");
  for (const n of nodes) assert.equal(n.cwd, WT_CWD);
});

test("injectIsolationCwd recurses through architect parallel + judge step", () => {
  const { p, state } = isolatedWorkspace();
  const directive = architectDirective(p, state, DEFAULT_CONFIG);
  injectIsolationCwd(directive.args, state);
  const nodes = agentNodes(directive.args);
  // 3 hypotheses (nested in `parallel`) + the judge step.
  assert.equal(nodes.length, DEFAULT_CONFIG.hypothesisCount + 1);
  for (const n of nodes) assert.equal(n.cwd, WT_CWD);
});

test("injectIsolationCwd is a no-op when isolation is absent (deep-equal input)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-inject-noiso-"));
  const p = workPaths(cwd, ".pi/task", "feat");
  ensureWorkTree(p);
  const state = createState("Feat", "feat", "base123"); // no isolation
  state.slices = ["001-first.md"];
  const directive = buildDirective(p, state, DEFAULT_CONFIG);
  const before = JSON.parse(JSON.stringify(directive.args));
  const result = injectIsolationCwd(directive.args, state);
  assert.equal(result, directive.args, "returns the same args reference");
  assert.deepEqual(directive.args, before, "no cwd keys added anywhere");
  assert.equal(agentNodes(directive.args).every((n) => !("cwd" in n)), true);
});

test("injectIsolationCwd is a no-op when isolation has no worktree", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-inject-emptyiso-"));
  const p = workPaths(cwd, ".pi/task", "feat");
  ensureWorkTree(p);
  const state = createState("Feat", "feat", "base123", {});
  state.slices = ["001-first.md"];
  const directive = buildDirective(p, state, DEFAULT_CONFIG);
  const before = JSON.parse(JSON.stringify(directive.args));
  injectIsolationCwd(directive.args, state);
  assert.deepEqual(directive.args, before);
});

test("issue() routes every directive through injectIsolationCwd (persisted state.pending)", () => {
  const { p, state } = isolatedWorkspace();
  const directive = verifyDirective(p, state, DEFAULT_CONFIG);
  issue(p, state, directive);
  const loaded = loadState(p);
  assert.ok(loaded !== null && loaded.pending !== null);
  const nodes = agentNodes(loaded.pending.args);
  assert.equal(nodes.length, 5);
  for (const n of nodes) assert.equal(n.cwd, WT_CWD);
});
