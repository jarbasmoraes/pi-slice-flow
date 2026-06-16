import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WORKTREES_DIR, createWorktree, validateWorktree, removeWorktree, repoRootOf } from "../extensions/lib/worktree.ts";
import { finalizeWorktree, stopped } from "../extensions/lib/engine.ts";

/** An `Exec`-shaped wrapper around node:child_process execFile. */
function realExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout, cwd: opts.cwd }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** A throwaway git repo with one commit; returns { cwd, baseline }. */
async function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-finalize-"));
  await realExec("git", ["init"], { cwd });
  await realExec("git", ["config", "user.email", "test@example.com"], { cwd });
  await realExec("git", ["config", "user.name", "Test"], { cwd });
  await realExec("git", ["commit", "--allow-empty", "-m", "init"], { cwd });
  const head = await realExec("git", ["rev-parse", "HEAD"], { cwd });
  return { cwd, baseline: head.stdout.trim() };
}

test("repoRootOf returns the main repo root for a .pi/worktrees/<slug> worktree", () => {
  const wt = { path: "/repo/.pi/worktrees/my-slug", cwd: "/repo/.pi/worktrees/my-slug", branch: "slice-flow/my-slug", created_at: "" };
  assert.equal(repoRootOf(wt), "/repo");
});

test("validateWorktree reports clean+merged for a fresh committed-clean worktree", async () => {
  const { cwd, baseline } = await makeRepo();
  const info = await createWorktree(realExec, cwd, "feat");
  const r = await validateWorktree(realExec, info.path, baseline);
  assert.equal(r.isClean, true, "no uncommitted changes");
  assert.equal(r.isUnmerged, false, "no commits ahead of baseline");
});

test("validateWorktree reports isClean false when there is an uncommitted change", async () => {
  const { cwd, baseline } = await makeRepo();
  const info = await createWorktree(realExec, cwd, "feat");
  writeFileSync(join(info.path, "dirty.txt"), "uncommitted", "utf8");
  const r = await validateWorktree(realExec, info.path, baseline);
  assert.equal(r.isClean, false, "uncommitted change detected");
});

test("validateWorktree reports isUnmerged true when the branch is ahead of baseline", async () => {
  const { cwd, baseline } = await makeRepo();
  const info = await createWorktree(realExec, cwd, "feat");
  writeFileSync(join(info.path, "f.txt"), "work", "utf8");
  await realExec("git", ["add", "."], { cwd: info.path });
  await realExec("git", ["commit", "-m", "ahead"], { cwd: info.path });
  const r = await validateWorktree(realExec, info.path, baseline);
  assert.equal(r.isClean, true, "committed work is clean");
  assert.equal(r.isUnmerged, true, "one commit ahead of baseline");
});

test("validateWorktree treats a null baseline as not-unmerged", async () => {
  const { cwd } = await makeRepo();
  const info = await createWorktree(realExec, cwd, "feat");
  const r = await validateWorktree(realExec, info.path, null);
  assert.equal(r.isUnmerged, false);
});

test("removeWorktree removes the worktree directory and throws on failure", async () => {
  const { cwd } = await makeRepo();
  const info = await createWorktree(realExec, cwd, "feat");
  assert.ok(existsSync(info.path), "worktree exists before removal");
  await removeWorktree(realExec, repoRootOf(info), info.path);
  assert.ok(!existsSync(info.path), "worktree directory removed");
  // Removing a path git does not know about fails.
  await assert.rejects(() => removeWorktree(realExec, cwd, join(cwd, WORKTREES_DIR, "nope")), /worktree|git|fatal/i);
});

// --- finalizeWorktree: driven with fake ctx + fake exec ----------------------

/** Records every exec invocation; returns canned output. */
function fakeExec(records, handler) {
  return async (cmd, args, opts) => {
    records.push({ cmd, args, opts });
    return handler ? handler(cmd, args, opts) : { code: 0, stdout: "", stderr: "" };
  };
}

function fakeCtx({ hasUI = true, confirm = async () => false, select = async () => undefined } = {}) {
  const calls = { confirm: [], select: [], notify: [] };
  return {
    ctx: {
      hasUI,
      ui: {
        confirm: async (title, detail) => {
          calls.confirm.push({ title, detail });
          return confirm(title, detail);
        },
        select: async (title, options) => {
          calls.select.push({ title, options });
          return select(title, options);
        },
        notify: (msg, level) => calls.notify.push({ msg, level }),
      },
    },
    calls,
  };
}

function makeEnv(ctx, state) {
  const stateFile = join(mkdtempSync(join(tmpdir(), "slice-flow-env-")), "state.json");
  return { ctx, p: { state: stateFile }, cfg: {}, state, pending: null };
}

function assertNoMergeOrPush(records) {
  for (const r of records) {
    assert.notEqual(r.args[0], "merge", "never runs git merge");
    assert.notEqual(r.args[0], "push", "never runs git push");
  }
}

test("finalizeWorktree is a no-op when no worktree is recorded", async () => {
  const records = [];
  const { ctx, calls } = fakeCtx();
  const state = { baselineCommit: "abc", isolation: undefined };
  const env = makeEnv(ctx, state);
  await finalizeWorktree(env, fakeExec(records));
  assert.equal(records.length, 0, "no git command run");
  assert.equal(calls.confirm.length, 0, "no prompt shown");
  assert.equal(state.isolation, undefined, "state untouched");
});

test("finalizeWorktree does not remove by default when dirty/unmerged and declined", async () => {
  const records = [];
  const wt = { path: "/repo/.pi/worktrees/feat", cwd: "/repo/.pi/worktrees/feat", branch: "slice-flow/feat", created_at: "" };
  // dirty status (porcelain output present) + commits ahead
  const exec = fakeExec(records, (cmd, args) => {
    if (args[0] === "status") return { code: 0, stdout: " M file.txt\n", stderr: "" };
    if (args[0] === "log") return { code: 0, stdout: "deadbeef ahead\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const { ctx, calls } = fakeCtx({ confirm: async () => false });
  const state = { baselineCommit: "base", isolation: { worktree: wt } };
  const env = makeEnv(ctx, state);
  await finalizeWorktree(env, exec);
  // No `worktree remove` issued because the user declined.
  assert.ok(!records.some((r) => r.args[0] === "worktree" && r.args[1] === "remove"), "no removal when declined");
  // The unsafe prompt names the dirty/unmerged condition.
  assert.match(calls.confirm[0].detail, /dirty|unmerged|uncommitted/i);
  assertNoMergeOrPush(records);
});

test("finalizeWorktree records the disposition and runs no merge/PR command", async () => {
  const records = [];
  const wt = { path: "/repo/.pi/worktrees/feat", cwd: "/repo/.pi/worktrees/feat", branch: "slice-flow/feat", created_at: "" };
  const exec = fakeExec(records, (cmd, args) => {
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" }; // clean
    if (args[0] === "log") return { code: 0, stdout: "", stderr: "" }; // merged
    return { code: 0, stdout: "", stderr: "" };
  });
  const { ctx } = fakeCtx({ confirm: async () => false, select: async () => "Create a PR" });
  const state = { baselineCommit: "base", isolation: { worktree: wt } };
  const env = makeEnv(ctx, state);
  await finalizeWorktree(env, exec);
  assert.equal(state.isolation.disposition, "Create a PR", "disposition recorded");
  assert.deepEqual(state.isolation.worktree, wt, "worktree preserved");
  assertNoMergeOrPush(records);
  // persisted to disk
  const onDisk = JSON.parse(readFileSync(env.p.state, "utf8"));
  assert.equal(onDisk.isolation.disposition, "Create a PR");
});

test("finalizeWorktree removes a clean worktree when confirmed", async () => {
  const records = [];
  const wt = { path: "/repo/.pi/worktrees/feat", cwd: "/repo/.pi/worktrees/feat", branch: "slice-flow/feat", created_at: "" };
  const exec = fakeExec(records, () => ({ code: 0, stdout: "", stderr: "" }));
  const { ctx } = fakeCtx({ confirm: async () => true, select: async () => "Manual merge — leave the branch to inspect later" });
  const state = { baselineCommit: "base", isolation: { worktree: wt } };
  const env = makeEnv(ctx, state);
  await finalizeWorktree(env, exec);
  const removal = records.find((r) => r.args[0] === "worktree" && r.args[1] === "remove");
  assert.ok(removal, "git worktree remove issued");
  assert.equal(removal.opts.cwd, "/repo", "removal run from the repo root");
  assertNoMergeOrPush(records);
});

// --- stopped(): abort leaves the worktree intact with a naming note (risk #9) -

test("stopped names the worktree path and branch and notes it was left intact", () => {
  const wt = { path: "/repo/.pi/worktrees/feat", cwd: "/repo/.pi/worktrees/feat", branch: "slice-flow/feat", created_at: "" };
  const stateFile = join(mkdtempSync(join(tmpdir(), "slice-flow-stopped-")), "state.json");
  const p = { root: "/repo", state: stateFile, logs: "/repo/logs", report: "/repo/report.md" };
  const state = { phase: "verify", pending: null, log: [], isolation: { worktree: wt } };
  const msg = stopped(p, state, "user aborted");
  assert.match(msg, /\/repo\/\.pi\/worktrees\/feat/, "names the worktree path");
  assert.match(msg, /slice-flow\/feat/, "names the branch");
  assert.match(msg, /left intact/i, "notes the worktree was left intact");
  // The worktree directory is never touched on abort — no removal happened here.
  assert.equal(state.phase, "stopped");
});

test("stopped omits the worktree note when no worktree is recorded", () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "slice-flow-stopped-")), "state.json");
  const p = { root: "/repo", state: stateFile, logs: "/repo/logs", report: "/repo/report.md" };
  const state = { phase: "verify", pending: null, log: [], isolation: undefined };
  const msg = stopped(p, state, "user aborted");
  assert.doesNotMatch(msg, /left intact/i, "no worktree note without a worktree");
});

test("finalizeWorktree defaults disposition to manual with no UI and never removes", async () => {
  const records = [];
  const wt = { path: "/repo/.pi/worktrees/feat", cwd: "/repo/.pi/worktrees/feat", branch: "slice-flow/feat", created_at: "" };
  const exec = fakeExec(records, () => ({ code: 0, stdout: "", stderr: "" }));
  const { ctx, calls } = fakeCtx({ hasUI: false });
  const state = { baselineCommit: "base", isolation: { worktree: wt } };
  const env = makeEnv(ctx, state);
  await finalizeWorktree(env, exec);
  assert.equal(state.isolation.disposition, "manual", "manual default with no UI");
  assert.equal(calls.confirm.length, 0, "no prompt without UI");
  assert.ok(!records.some((r) => r.args[0] === "worktree" && r.args[1] === "remove"), "no removal without UI");
  assertNoMergeOrPush(records);
});
