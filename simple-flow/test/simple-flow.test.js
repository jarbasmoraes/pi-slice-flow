import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import simpleFlow from "../extensions/simple-flow.ts";
import { load, save } from "../extensions/lib/state.ts";

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

test("enabled config: an unparseable create id is recovered via findTask and persisted", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      if (args[1] === "TODOIST_GET_ALL_PROJECTS") {
        return { code: 0, stdout: JSON.stringify({ data: { projects: [{ project_id: "p1", name: "Inbox" }] } }), stderr: "" };
      }
      if (args[1] === "TODOIST_CREATE_TASK") {
        return { code: 0, stdout: "not json", stderr: "" };
      }
      if (args[1] === "TODOIST_FILTER_TASKS") {
        return { code: 0, stdout: JSON.stringify({ data: { results: [{ id: "888", project_id: "p1" }] } }), stderr: "" };
      }
      throw new Error(`unexpected tool ${args[1]}`);
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd, { select: "Inbox" });
    await pi.commands["simple-task"].handler("fix the flaky login test", ctx);

    const search = records.find((r) => r.args[1] === "TODOIST_FILTER_TASKS");
    assert.ok(search, "recovers via findTask when the create id is unparseable");
    const params = JSON.parse(search.args[3]);
    assert.equal(params.query, "search: fix the flaky login test");

    assert.deepEqual(load(cwd), { taskId: "888", project: "Inbox", content: "fix the flaky login test" });
    assert.ok(ctx.notifications.some((n) => n.level === "info" && /888/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("enabled config: unparseable create id AND findTask returning null reports an error and persists nothing", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const pi = fakePi(async (cmd, args) => {
      if (args[1] === "TODOIST_GET_ALL_PROJECTS") {
        return { code: 0, stdout: JSON.stringify({ data: { projects: [{ project_id: "p1", name: "Inbox" }] } }), stderr: "" };
      }
      if (args[1] === "TODOIST_CREATE_TASK") {
        return { code: 0, stdout: "not json", stderr: "" };
      }
      if (args[1] === "TODOIST_FILTER_TASKS") {
        return { code: 0, stdout: "not json", stderr: "" };
      }
      throw new Error(`unexpected tool ${args[1]}`);
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd, { select: "Inbox" });
    await pi.commands["simple-task"].handler("do a thing", ctx);

    assert.equal(load(cwd), null, "never a half-tracked task");
    assert.ok(ctx.notifications.some((n) => n.level === "error" && /could not be determined/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("enabled config: happy path (id parses directly) never calls findTask", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      if (args[1] === "TODOIST_GET_ALL_PROJECTS") {
        return { code: 0, stdout: JSON.stringify({ data: { projects: [{ project_id: "p1", name: "Inbox" }] } }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ data: { id: "555" } }), stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd, { select: "Inbox" });
    await pi.commands["simple-task"].handler("fix the flaky login test", ctx);

    assert.ok(!records.some((r) => r.args[1] === "TODOIST_FILTER_TASKS"), "happy path never calls findTask");
    assert.deepEqual(load(cwd), { taskId: "555", project: "Inbox", content: "fix the flaky login test" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registers /simple-status without error", () => {
  const pi = fakePi(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  assert.doesNotThrow(() => simpleFlow(pi));
  assert.ok(pi.commands["simple-status"], "registers a simple-status command");
  assert.equal(typeof pi.commands["simple-status"].handler, "function");
});

test("simple-status: disabled config notifies a warning and makes no CLI call", async () => {
  const cwd = tmpDir();
  try {
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-status"].handler("", ctx);
    assert.equal(records.length, 0, "disabled config must never call the CLI");
    assert.ok(ctx.notifications.some((n) => n.level === "warning"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-status: no tracked task reports a clear message and makes no Composio call", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-status"].handler("", ctx);
    assert.equal(records.length, 0, "simple-status must never call the CLI");
    assert.ok(ctx.notifications.some((n) => n.level === "info" && /No tracked task/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-status: reports the exact tracked task after a save", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    save(cwd, { taskId: "555", project: "Work", content: "fix the flaky login test" });
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-status"].handler("", ctx);
    assert.equal(records.length, 0, "simple-status must never call the CLI");
    const n = ctx.notifications.find((n) => n.level === "info");
    assert.ok(n, "reports an info notification");
    assert.match(n.msg, /555/);
    assert.match(n.msg, /Work/);
    assert.match(n.msg, /fix the flaky login test/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-status: simulates a restart via a fresh state.load and still reports the same task", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    save(cwd, { taskId: "777", project: "Home", content: "buy groceries" });

    // Simulate a restart: no in-memory state carried over, just a fresh
    // state.load(cwd) reading the same on-disk .simple-flow/state.json.
    const reloaded = load(cwd);
    assert.deepEqual(reloaded, { taskId: "777", project: "Home", content: "buy groceries" });

    const pi = fakePi(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-status"].handler("", ctx);
    const n = ctx.notifications.find((n) => n.level === "info");
    assert.ok(n);
    assert.match(n.msg, /777/);
    assert.match(n.msg, /Home/);
    assert.match(n.msg, /buy groceries/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registers /simple-comment without error", () => {
  const pi = fakePi(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  assert.doesNotThrow(() => simpleFlow(pi));
  assert.ok(pi.commands["simple-comment"], "registers a simple-comment command");
  assert.equal(typeof pi.commands["simple-comment"].handler, "function");
});

test("simple-comment: disabled config notifies a warning and makes no CLI call", async () => {
  const cwd = tmpDir();
  try {
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-comment"].handler("saw it fail again on CI", ctx);
    assert.equal(records.length, 0, "disabled config must never call the CLI");
    assert.ok(ctx.notifications.some((n) => n.level === "warning"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-comment: enabled config + empty text: usage warning, no CLI call", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-comment"].handler("   ", ctx);
    assert.equal(records.length, 0);
    assert.ok(ctx.notifications.some((n) => n.level === "warning" && /Usage/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-comment: no tracked task reports a clear message and makes no Composio call", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-comment"].handler("saw it fail again on CI", ctx);
    assert.equal(records.length, 0, "no tracked task must never call the CLI");
    assert.ok(ctx.notifications.some((n) => n.level === "warning" && /No tracked task/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-comment: with a tracked task, issues TODOIST_CREATE_COMMENT_V1 with the exact text and reports success", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    save(cwd, { taskId: "555", project: "Work", content: "fix the flaky login test" });
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-comment"].handler("saw it fail again on CI", ctx);

    assert.equal(records.length, 1, "issues exactly one Composio call");
    assert.equal(records[0].cmd, "composio");
    assert.equal(records[0].args[0], "execute");
    assert.equal(records[0].args[1], "TODOIST_CREATE_COMMENT_V1");
    assert.equal(records[0].args[2], "-d");
    const params = JSON.parse(records[0].args[3]);
    assert.deepEqual(params, { task_id: "555", content: "saw it fail again on CI" });
    assert.ok(ctx.notifications.some((n) => n.level === "info" && /555/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-comment: a Composio failure (nonzero exit) reports a clear error and not success", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    save(cwd, { taskId: "555", project: "Work", content: "fix the flaky login test" });
    const pi = fakePi(async () => ({ code: 1, stdout: "", stderr: "not authed" }));
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-comment"].handler("saw it fail again on CI", ctx);

    assert.ok(ctx.notifications.some((n) => n.level === "error"), "reports an error notification");
    assert.ok(!ctx.notifications.some((n) => n.level === "info"), "no success notification on failure");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registers /simple-finish without error", () => {
  const pi = fakePi(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  assert.doesNotThrow(() => simpleFlow(pi));
  assert.ok(pi.commands["simple-finish"], "registers a simple-finish command");
  assert.equal(typeof pi.commands["simple-finish"].handler, "function");
});

test("simple-finish: disabled config notifies a warning and makes no CLI call", async () => {
  const cwd = tmpDir();
  try {
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-finish"].handler("", ctx);
    assert.equal(records.length, 0, "disabled config must never call the CLI");
    assert.ok(ctx.notifications.some((n) => n.level === "warning"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-finish: no tracked task reports a clear message and makes no Composio call", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-finish"].handler("", ctx);
    assert.equal(records.length, 0, "no tracked task must never call the CLI");
    assert.ok(ctx.notifications.some((n) => n.level === "warning" && /No tracked task/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-finish: with a tracked task, issues TODOIST_CLOSE_TASK_V1 with the exact task_id and reports success", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    save(cwd, { taskId: "555", project: "Work", content: "fix the flaky login test" });
    const records = [];
    const pi = fakePi(async (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { code: 0, stdout: "{}", stderr: "" };
    });
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-finish"].handler("", ctx);

    assert.equal(records.length, 1, "issues exactly one Composio call");
    assert.equal(records[0].cmd, "composio");
    assert.equal(records[0].args[0], "execute");
    assert.equal(records[0].args[1], "TODOIST_CLOSE_TASK_V1");
    assert.equal(records[0].args[2], "-d");
    const params = JSON.parse(records[0].args[3]);
    assert.deepEqual(params, { task_id: "555" });
    assert.ok(ctx.notifications.some((n) => n.level === "info" && /555/.test(n.msg)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-finish: a Composio failure (nonzero exit) reports a clear error and not success", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    save(cwd, { taskId: "555", project: "Work", content: "fix the flaky login test" });
    const pi = fakePi(async () => ({ code: 1, stdout: "", stderr: "not authed" }));
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-finish"].handler("", ctx);

    assert.ok(ctx.notifications.some((n) => n.level === "error"), "reports an error notification");
    assert.ok(!ctx.notifications.some((n) => n.level === "info"), "no success notification on failure");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("simple-finish: does not clear the tracked-task state after closing", async () => {
  const cwd = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    save(cwd, { taskId: "555", project: "Work", content: "fix the flaky login test" });
    const pi = fakePi(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    simpleFlow(pi);
    const ctx = fakeCtx(cwd);
    await pi.commands["simple-finish"].handler("", ctx);

    assert.deepEqual(load(cwd), { taskId: "555", project: "Work", content: "fix the flaky login test" }, "tracked task record is left in place after finish");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
