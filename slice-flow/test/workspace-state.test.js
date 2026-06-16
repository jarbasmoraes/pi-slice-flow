import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createState, loadState, ensureGitignored, workPaths } from "../extensions/lib/workspace.ts";

const sampleWorktree = {
  cwd: "/repo/.pi/worktrees/feat",
  branch: "slice-flow/feat",
  path: "/repo/.pi/worktrees/feat",
  created_at: "2026-06-16T00:00:00.000Z",
};

test("createState with isolation produces a v2 state carrying the worktree", () => {
  const s = createState("My feature", "my-feature", "abc123", { worktree: sampleWorktree });
  assert.equal(s.version, 2);
  assert.deepEqual(s.isolation, { worktree: sampleWorktree });
});

test("createState without isolation is a valid v2 state with isolation undefined", () => {
  const s = createState("My feature", "my-feature", "abc123");
  assert.equal(s.version, 2);
  assert.equal(s.isolation, undefined);
});

test("a state.json written without isolation round-trips through loadState with isolation undefined", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-state-"));
  const p = workPaths(cwd, ".pi/task", "my-feature");
  mkdirSync(p.root, { recursive: true });
  const legacy = createState("My feature", "my-feature", "abc123");
  delete legacy.isolation;
  legacy.version = 1;
  writeFileSync(p.state, JSON.stringify(legacy, null, 2), "utf8");

  const loaded = loadState(p);
  assert.ok(loaded !== null);
  assert.equal(loaded.isolation, undefined);
});

test("ensureGitignored adds .pi/worktrees/ alongside the work-dir entry", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-gitignore-"));
  ensureGitignored(cwd, ".pi/task");
  const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
  assert.match(gi, /^\.pi\/task\/$/m, "work-dir entry present");
  assert.match(gi, /^\.pi\/worktrees\/$/m, "worktrees entry present");
});

test("ensureGitignored does not duplicate entries on a second call", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-gitignore-dup-"));
  ensureGitignored(cwd, ".pi/task");
  ensureGitignored(cwd, ".pi/task");
  const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
  const worktreeLines = gi.split("\n").filter((l) => l.trim() === ".pi/worktrees/");
  const workDirLines = gi.split("\n").filter((l) => l.trim() === ".pi/task/");
  assert.equal(worktreeLines.length, 1, ".pi/worktrees/ only once");
  assert.equal(workDirLines.length, 1, ".pi/task/ only once");
});

test("ensureGitignored is non-fatal when .gitignore cannot be written", () => {
  // Point cwd at a path whose .gitignore is a directory: append fails, no throw.
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-gitignore-fatal-"));
  mkdirSync(join(cwd, ".gitignore"));
  assert.doesNotThrow(() => ensureGitignored(cwd, ".pi/task"));
});
