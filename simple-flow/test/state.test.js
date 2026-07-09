import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load, save, clear } from "../extensions/lib/state.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "simple-flow-state-"));
}

test("load returns null when no state file exists", () => {
  const cwd = tmpDir();
  try {
    assert.equal(load(cwd), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("save then load round-trips the tracked task record", () => {
  const cwd = tmpDir();
  try {
    const task = { taskId: "123", project: "Work", content: "fix the flaky login test" };
    save(cwd, task);
    assert.deepEqual(load(cwd), task);
    assert.ok(existsSync(join(cwd, ".simple-flow", "state.json")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a second save overwrites the first (single active task)", () => {
  const cwd = tmpDir();
  try {
    save(cwd, { taskId: "1", project: "Work", content: "first" });
    save(cwd, { taskId: "2", project: "Home", content: "second" });
    assert.deepEqual(load(cwd), { taskId: "2", project: "Home", content: "second" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("clear removes the state file", () => {
  const cwd = tmpDir();
  try {
    save(cwd, { taskId: "1", project: "Work", content: "first" });
    clear(cwd);
    assert.equal(load(cwd), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
