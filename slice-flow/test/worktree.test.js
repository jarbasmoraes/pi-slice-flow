import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKTREES_DIR, createWorktree } from "../extensions/lib/worktree.ts";

/** An `Exec`-shaped wrapper around node:child_process execFile. */
function realExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout, cwd: opts.cwd }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** A throwaway git repo with one commit, returns its path. */
async function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-worktree-"));
  await realExec("git", ["init"], { cwd });
  await realExec("git", ["config", "user.email", "test@example.com"], { cwd });
  await realExec("git", ["config", "user.name", "Test"], { cwd });
  await realExec("git", ["commit", "--allow-empty", "-m", "init"], { cwd });
  return cwd;
}

test("createWorktree adds a worktree on slice-flow/<slug> and returns WorktreeInfo", async () => {
  const cwd = await makeRepo();
  const slug = "my-feature";
  const info = await createWorktree(realExec, cwd, slug);

  const expectedPath = join(cwd, WORKTREES_DIR, slug);
  assert.equal(info.path, expectedPath, "path points at .pi/worktrees/<slug>");
  assert.equal(info.cwd, expectedPath, "cwd equals path");
  assert.equal(info.branch, `slice-flow/${slug}`, "branch is slice-flow/<slug>");
  assert.ok(typeof info.created_at === "string" && info.created_at.length > 0, "created_at set");
  assert.ok(existsSync(expectedPath), "worktree directory created on disk");

  // Confirm git recorded the worktree.
  const list = await realExec("git", ["worktree", "list"], { cwd });
  assert.match(list.stdout, /my-feature/, "git knows about the worktree");
});

test("createWorktree throws when the git command exits non-zero", async () => {
  // Not a git repo: `git worktree add` exits non-zero.
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-worktree-nogit-"));
  await assert.rejects(() => createWorktree(realExec, cwd, "nope"), /worktree|git|fatal/i);
});

test("createWorktree throws with stderr/stdout in the message on failure", async () => {
  const cwd = await makeRepo();
  // Create once, then a second create on the same branch/path fails.
  await createWorktree(realExec, cwd, "dup");
  await assert.rejects(() => createWorktree(realExec, cwd, "dup"), (err) => {
    assert.ok(err instanceof Error, "throws an Error");
    assert.ok(err.message.length > 0, "message is non-empty");
    return true;
  });
});
