import { test } from "node:test";
import assert from "node:assert/strict";

import { setupWorktree } from "../extensions/lib/engine.ts";
import { WORKTREES_DIR } from "../extensions/lib/worktree.ts";

/** Records every exec invocation; returns canned output (default success). */
function fakeExec(records, handler) {
  return async (cmd, args, opts) => {
    records.push({ cmd, args, opts });
    return handler ? handler(cmd, args, opts) : { code: 0, stdout: "", stderr: "" };
  };
}

function fakeCtx({ hasUI = true, confirm = async () => false } = {}) {
  const calls = { confirm: [], notify: [] };
  return {
    ctx: {
      hasUI,
      ui: {
        confirm: async (title, detail) => {
          calls.confirm.push({ title, detail });
          return confirm(title, detail);
        },
        notify: (msg, level) => calls.notify.push({ msg, level }),
      },
    },
    calls,
  };
}

const cfg = { workDir: ".pi/task" };

// AC11 — no prompt when the project is not a git repo (baseline === null).
test("setupWorktree does not prompt and returns undefined when baseline is null", async () => {
  const records = [];
  const { ctx, calls } = fakeCtx({ confirm: async () => true });
  const isolation = await setupWorktree(ctx, fakeExec(records), cfg, "/repo", "feat", null);
  assert.equal(isolation, undefined, "no isolation recorded");
  assert.equal(calls.confirm.length, 0, "no prompt shown for a non-git project");
  assert.equal(records.length, 0, "no git command run");
});

// No interactive UI: never prompt, behave exactly as before.
test("setupWorktree does not prompt and returns undefined when there is no UI", async () => {
  const records = [];
  const { ctx, calls } = fakeCtx({ hasUI: false, confirm: async () => true });
  const isolation = await setupWorktree(ctx, fakeExec(records), cfg, "/repo", "feat", "base");
  assert.equal(isolation, undefined, "no isolation recorded without a UI");
  assert.equal(calls.confirm.length, 0, "no prompt without a UI");
  assert.equal(records.length, 0, "no git command run");
});

// AC1 + AC2 — the prompt appears in a git repo and a worktree is created+recorded on yes.
test("setupWorktree prompts in a git repo and records the created worktree on yes", async () => {
  const records = [];
  const { ctx, calls } = fakeCtx({ confirm: async () => true });
  const isolation = await setupWorktree(ctx, fakeExec(records), cfg, "/repo", "feat", "base");

  assert.equal(calls.confirm.length, 1, "the worktree prompt appears");
  assert.match(calls.confirm[0].title, /run in a worktree\?/i, "prompt asks to run in a worktree");

  const add = records.find((r) => r.args[0] === "worktree" && r.args[1] === "add");
  assert.ok(add, "git worktree add issued");
  assert.equal(add.opts.cwd, "/repo", "worktree created from the project root");

  assert.ok(isolation && isolation.worktree, "isolation recorded");
  assert.equal(isolation.worktree.branch, "slice-flow/feat", "feature branch named for the slug");
  assert.equal(isolation.worktree.path, `/repo/${WORKTREES_DIR}/feat`, "worktree path under the worktrees dir");
  assert.equal(isolation.worktree.cwd, isolation.worktree.path, "subagent cwd is the worktree path");
});

// AC3 — declining the prompt leaves behavior identical to pre-feature (no worktree).
test("setupWorktree returns undefined and creates nothing when the prompt is declined", async () => {
  const records = [];
  const { ctx, calls } = fakeCtx({ confirm: async () => false });
  const isolation = await setupWorktree(ctx, fakeExec(records), cfg, "/repo", "feat", "base");
  assert.equal(calls.confirm.length, 1, "the prompt was shown");
  assert.equal(isolation, undefined, "no isolation recorded on no");
  assert.ok(!records.some((r) => r.args[0] === "worktree" && r.args[1] === "add"), "no worktree created on no");
});

// risk #8 — a creation failure surfaces and is NOT recorded (no half-made worktree).
test("setupWorktree surfaces a creation failure and records no isolation", async () => {
  const records = [];
  // git worktree add fails (non-zero exit) -> createWorktree throws.
  const exec = fakeExec(records, (cmd, args) => {
    if (args[0] === "worktree" && args[1] === "add") return { code: 128, stdout: "", stderr: "fatal: boom" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const { ctx, calls } = fakeCtx({ confirm: async () => true });
  const isolation = await setupWorktree(ctx, exec, cfg, "/repo", "feat", "base");
  assert.equal(isolation, undefined, "no isolation recorded when creation throws (risk #8)");
  assert.equal(calls.notify.length, 1, "the failure is surfaced to the user");
  assert.equal(calls.notify[0].level, "warning", "surfaced as a warning");
  assert.match(calls.notify[0].msg, /worktree/i, "the warning mentions the worktree");
});
