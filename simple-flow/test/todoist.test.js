import { test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../extensions/lib/todoist.ts";

/** Records every exec invocation; returns canned output (default success). */
function fakeExec(records, handler) {
  return async (cmd, args, opts) => {
    records.push({ cmd, args, opts });
    return handler ? handler(cmd, args, opts) : { code: 0, stdout: JSON.stringify({ data: { id: "999" } }), stderr: "" };
  };
}

test("listProjects issues TODOIST_GET_ALL_PROJECTS and parses the named list", async () => {
  const records = [];
  const client = createClient({
    exec: fakeExec(records, () => ({
      code: 0,
      stdout: JSON.stringify({ data: { projects: [{ project_id: "p1", name: "Inbox" }, { project_id: "p2", name: "Work" }] } }),
      stderr: "",
    })),
  });
  const projects = await client.listProjects();
  assert.deepEqual(projects, [{ id: "p1", name: "Inbox" }, { id: "p2", name: "Work" }]);
  assert.equal(records[0].cmd, "composio");
  assert.deepEqual(records[0].args.slice(0, 2), ["execute", "TODOIST_GET_ALL_PROJECTS"]);
});

test("createTask issues composio execute TODOIST_CREATE_TASK -d <json> with content and project id, returns the parsed id", async () => {
  const records = [];
  const client = createClient({ exec: fakeExec(records) });
  const id = await client.createTask({ project: "p1", content: "fix the flaky login test" });
  assert.equal(id, "999");
  assert.equal(records[0].cmd, "composio");
  assert.equal(records[0].args[0], "execute");
  assert.equal(records[0].args[1], "TODOIST_CREATE_TASK");
  assert.equal(records[0].args[2], "-d");
  const params = JSON.parse(records[0].args[3]);
  assert.equal(params.content, "fix the flaky login test");
  assert.equal(params.project_id, "p1");
  assert.equal(records[0].opts.timeout, 5000);
});

test("createTask returns null when the create succeeded but the id could not be parsed", async () => {
  const records = [];
  const client = createClient({
    exec: fakeExec(records, () => ({ code: 0, stdout: "not json", stderr: "" })),
  });
  const id = await client.createTask({ project: "p1", content: "c" });
  assert.equal(id, null);
});

test("createTask throws (fail-loud) when exec throws, naming the Composio CLI", async () => {
  const client = createClient({
    exec: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  await assert.rejects(() => client.createTask({ project: "p1", content: "c" }), /Composio/);
});

test("createTask throws (fail-loud) when exec returns a nonzero exit", async () => {
  const client = createClient({
    exec: async () => ({ code: 1, stdout: "", stderr: "auth error" }),
  });
  await assert.rejects(() => client.createTask({ project: "p1", content: "c" }), /Composio/);
});

test("listProjects throws (fail-loud) when exec throws", async () => {
  const client = createClient({
    exec: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  await assert.rejects(() => client.listProjects(), /Composio/);
});

test("listProjects throws (fail-loud) when exec returns a nonzero exit", async () => {
  const client = createClient({
    exec: async () => ({ code: 1, stdout: "", stderr: "not authed" }),
  });
  await assert.rejects(() => client.listProjects(), /Composio/);
});

test("findTask issues composio execute TODOIST_FILTER_TASKS with a free-text search query and parses the found task", async () => {
  const records = [];
  const client = createClient({
    exec: fakeExec(records, () => ({
      code: 0,
      stdout: JSON.stringify({ data: { results: [{ id: "321", project_id: "p2" }] } }),
      stderr: "",
    })),
  });
  const found = await client.findTask("fix the flaky login test");
  assert.deepEqual(found, { taskId: "321", project: "p2" });
  assert.equal(records[0].cmd, "composio");
  assert.equal(records[0].args[0], "execute");
  assert.equal(records[0].args[1], "TODOIST_FILTER_TASKS");
  const params = JSON.parse(records[0].args[3]);
  assert.equal(params.query, "search: fix the flaky login test");
});

test("findTask returns null when nothing matched or the envelope was unparseable", async () => {
  const client = createClient({
    exec: async () => ({ code: 0, stdout: "not json", stderr: "" }),
  });
  const found = await client.findTask("whatever");
  assert.equal(found, null);
});

test("findTask throws (fail-loud) when exec throws, naming the Composio CLI", async () => {
  const client = createClient({
    exec: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  await assert.rejects(() => client.findTask("whatever"), /Composio/);
});

test("findTask throws (fail-loud) when exec returns a nonzero exit", async () => {
  const client = createClient({
    exec: async () => ({ code: 1, stdout: "", stderr: "not authed" }),
  });
  await assert.rejects(() => client.findTask("whatever"), /Composio/);
});

test("comment issues composio execute TODOIST_CREATE_COMMENT_V1 -d <json> with task_id and content", async () => {
  const records = [];
  const client = createClient({ exec: fakeExec(records) });
  await client.comment("555", "saw it fail again on CI");
  assert.equal(records[0].cmd, "composio");
  assert.equal(records[0].args[0], "execute");
  assert.equal(records[0].args[1], "TODOIST_CREATE_COMMENT_V1");
  assert.equal(records[0].args[2], "-d");
  const params = JSON.parse(records[0].args[3]);
  assert.deepEqual(params, { task_id: "555", content: "saw it fail again on CI" });
});

test("comment throws (fail-loud) when exec throws, naming the Composio CLI", async () => {
  const client = createClient({
    exec: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  await assert.rejects(() => client.comment("555", "text"), /Composio/);
});

test("comment throws (fail-loud) when exec returns a nonzero exit", async () => {
  const client = createClient({
    exec: async () => ({ code: 1, stdout: "", stderr: "not authed" }),
  });
  await assert.rejects(() => client.comment("555", "text"), /Composio/);
});
