import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyCodegraph, codegraphIndexExists, codegraphIndexReachable, codegraphPreamble, detectCodegraph } from "../extensions/lib/codegraph.ts";
import { createState, loadState, workPaths } from "../extensions/lib/workspace.ts";

test("classifyCodegraph maps the three states", () => {
  assert.equal(classifyCodegraph(true, false), "ready");
  assert.equal(classifyCodegraph(false, true), "nudge");
  assert.equal(classifyCodegraph(false, false), "silent");
  // graphDbExists wins regardless of cliOnPath
  assert.equal(classifyCodegraph(true, true), "ready");
});

test("codegraphPreamble is non-empty for ready/nudge and empty for silent", () => {
  const ready = codegraphPreamble("ready");
  const nudge = codegraphPreamble("nudge");
  assert.ok(ready.length > 0);
  assert.ok(nudge.length > 0);
  assert.match(ready.toLowerCase(), /codegraph/);
  assert.match(nudge, /codegraph init/);
  assert.equal(codegraphPreamble("silent"), "");
});

test("codegraphIndexExists detects any *.db under .codegraph/ (real-world codegraph.db name)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-index-"));
  assert.equal(codegraphIndexExists(cwd), false, "no .codegraph dir -> false");
  mkdirSync(join(cwd, ".codegraph"), { recursive: true });
  assert.equal(codegraphIndexExists(cwd), false, "empty .codegraph dir -> false");
  writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "");
  assert.equal(codegraphIndexExists(cwd), true, "codegraph.db present -> true");
});

test("codegraphIndexReachable finds an ancestor index from a nested worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "slice-flow-cg-reach-"));
  mkdirSync(join(root, ".codegraph"), { recursive: true });
  writeFileSync(join(root, ".codegraph", "codegraph.db"), "");
  // The build agents run here: <root>/.pi/worktrees/<slug>/ — no .codegraph of its own.
  const worktree = join(root, ".pi", "worktrees", "my-slug");
  mkdirSync(worktree, { recursive: true });
  assert.equal(codegraphIndexExists(worktree), false, "worktree has no index of its own");
  assert.equal(codegraphIndexReachable(worktree, root), true, "ancestor index is reachable up to repo root");
});

test("codegraphIndexReachable stays within repoRoot and ignores a stray ancestor index", () => {
  const outer = mkdtempSync(join(tmpdir(), "slice-flow-cg-stray-"));
  // A .codegraph above the repo root must NOT count as this project's index.
  mkdirSync(join(outer, ".codegraph"), { recursive: true });
  writeFileSync(join(outer, ".codegraph", "codegraph.db"), "");
  const repoRoot = join(outer, "repo");
  const worktree = join(repoRoot, ".pi", "worktrees", "my-slug");
  mkdirSync(worktree, { recursive: true });
  assert.equal(codegraphIndexReachable(worktree, repoRoot), false, "walk stops at repoRoot, stray index ignored");
});

test("codegraphIndexReachable with repoRoot === start is a single-dir check", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-single-"));
  assert.equal(codegraphIndexReachable(cwd, cwd), false);
  mkdirSync(join(cwd, ".codegraph"), { recursive: true });
  writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "");
  assert.equal(codegraphIndexReachable(cwd, cwd), true);
});

test("detectCodegraph resolves ready from a worktree when the repo-root index is an ancestor", async () => {
  const root = mkdtempSync(join(tmpdir(), "slice-flow-cg-wt-ready-"));
  mkdirSync(join(root, ".codegraph"), { recursive: true });
  writeFileSync(join(root, ".codegraph", "codegraph.db"), "");
  const worktree = join(root, ".pi", "worktrees", "my-slug");
  mkdirSync(worktree, { recursive: true });
  let called = false;
  const exec = async () => {
    called = true;
    return { code: 0 };
  };
  assert.equal(await detectCodegraph(worktree, exec, root), "ready");
  assert.equal(called, false, "ancestor index found -> CLI probe not consulted");
});

test("detectCodegraph resolves ready when a .codegraph/*.db index exists (exec not consulted)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-ready-"));
  mkdirSync(join(cwd, ".codegraph"), { recursive: true });
  // codegraph names its db after the project, not a fixed graph.db.
  writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "");
  let called = false;
  const exec = async () => {
    called = true;
    return { code: 0 };
  };
  assert.equal(await detectCodegraph(cwd, exec), "ready");
  assert.equal(called, false, "exec must not be consulted when an index exists");
});

test("detectCodegraph resolves nudge when no index and exec returns code 0", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-nudge-"));
  const exec = async () => ({ code: 0 });
  assert.equal(await detectCodegraph(cwd, exec), "nudge");
});

test("detectCodegraph resolves silent when graph.db absent and exec returns non-zero", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-silent-"));
  const exec = async () => ({ code: 1 });
  assert.equal(await detectCodegraph(cwd, exec), "silent");
});

test("detectCodegraph resolves silent when graph.db absent and exec throws", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-throw-"));
  const exec = async () => {
    throw new Error("ENOENT");
  };
  assert.equal(await detectCodegraph(cwd, exec), "silent");
});

test("createState initializes codegraphReady to false", () => {
  const s = createState("My feature", "my-feature", "abc123");
  assert.equal(s.codegraphReady, false);
});

test("loadState back-fills codegraphReady to false and round-trips true", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cg-state-"));
  const p = workPaths(cwd, ".pi/task", "my-feature");
  mkdirSync(p.root, { recursive: true });

  const legacy = createState("My feature", "my-feature", "abc123");
  delete legacy.codegraphReady;
  writeFileSync(p.state, JSON.stringify(legacy, null, 2), "utf8");
  const loadedLegacy = loadState(p);
  assert.ok(loadedLegacy !== null);
  assert.equal(loadedLegacy.codegraphReady, false);

  const ready = createState("My feature", "my-feature", "abc123");
  ready.codegraphReady = true;
  writeFileSync(p.state, JSON.stringify(ready, null, 2), "utf8");
  const loadedReady = loadState(p);
  assert.ok(loadedReady !== null);
  assert.equal(loadedReady.codegraphReady, true);
});
