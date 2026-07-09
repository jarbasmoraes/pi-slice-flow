import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import simpleFlow from "../extensions/simple-flow.ts";
import { load } from "../extensions/lib/state.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "simple-flow-ext-"));
}

/** A fake ExtensionAPI capturing registered commands; exec is a fake Composio CLI. */
function fakePi(execHandler) {
  const commands = {};
  return {
    commands,
    exec: execHandler,
    registerCommand(name, spec) {
      commands[name] = spec;
    },
  };
}

/** A fake ctx: notify records, select returns the configured pick. */
function fakeCtx(cwd, { select } = {}) {
  const notifications = [];
  return {
    cwd,
    hasUI: true,
    notifications,
    ui: {
      notify: (msg, level) => notifications.push({ msg, level }),
      select: async () => select,
    },
  };
}

test("registers /simple-task without error", () => {
  const pi = fakePi(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  assert.doesNotThrow(() => simpleFlow(pi));
  assert.ok(pi.commands["simple-task"], "registers a simple-task command");
  assert.equal(typeof pi.commands["simple-task"].handler, "function");
});

test("disabled config: notifies a warning and makes no CLI call", async () => {
  const cwd = tmpDir();
  try {
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: JSON.stringify({ data: { id: "999" } }), stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-task"].handler("do a thing", ctx);
    assert.equal(records.length, 0, "disabled config must never call the CLI");
    assert.ok(ctx.notifications.some((n) => n.level === "warning"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("enabled config + empty prompt: usage warning, no CLI call", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: JSON.stringify({ data: { id: "999" } }), stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-task"].handler("   ", ctx);
    assert.equal(records.length, 0);
    assert.ok(ctx.notifications.some((n) => n.level === "warning" && /Usage/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("enabled config: creates the task in the chosen project, persists and prints the id", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      if (args[1] === "TODOIST_GET_ALL_PROJECTS") {
        return { code: 0, stdout: JSON.stringify({ data: { projects: [{ project_id: "p1", name: "Inbox" }, { project_id: "p2", name: "Work" }] } }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ data: { id: "555" } }), stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd, { select: "Work" });
    await pi.commands["simple-task"].handler("fix the flaky login test", ctx);

    const create = records.find((r) => r.args[1] === "TODOIST_CREATE_TASK");
    assert.ok(create, "issued a create call");
    assert.equal(create.args[0], "execute");
    assert.equal(create.args[2], "-d");
    const params = JSON.parse(create.args[3]);
    assert.equal(params.content, "fix the flaky login test");
    assert.equal(params.project_id, "p2", "uses the chosen project's id, not its name");

    assert.deepEqual(load(cwd), { taskId: "555", project: "Work", content: "fix the flaky login test" });
    assert.ok(ctx.notifications.some((n) => n.level === "info" && /555/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("enabled config: a create failure (nonzero exit) is reported and nothing is persisted", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const pi = fakePi(async (cmd, args) => {
      if (args[1] === "TODOIST_GET_ALL_PROJECTS") {
        return { code: 0, stdout: JSON.stringify({ data: { projects: [{ project_id: "p1", name: "Inbox" }] } }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "not authed" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd, { select: "Inbox" });
    await pi.commands["simple-task"].handler("do a thing", ctx);
    assert.equal(load(cwd), null, "nothing tracked on a failed create");
    assert.ok(ctx.notifications.some((n) => n.level === "error"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
