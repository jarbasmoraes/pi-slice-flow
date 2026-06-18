import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyCodegraph, codegraphIndexExists, codegraphPreamble, detectCodegraph } from "../extensions/lib/codegraph.ts";
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
