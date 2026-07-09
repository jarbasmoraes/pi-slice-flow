import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "../extensions/lib/config.ts";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "simple-flow-config-"));
}

test("DEFAULT_CONFIG.enabled is false", () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
});

test("loadConfig defaults to disabled when no overlay files exist", () => {
  const cwd = tmpDir();
  const home = tmpDir();
  try {
    const cfg = loadConfig(cwd, home);
    assert.equal(cfg.enabled, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig reads enabled from <cwd>/simple-flow.json", () => {
  const cwd = tmpDir();
  const home = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: true }));
    const cfg = loadConfig(cwd, home);
    assert.equal(cfg.enabled, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig reads enabled from ~/.pi/simple-flow.json (global) and cwd overlay overrides it", () => {
  const cwd = tmpDir();
  const home = tmpDir();
  try {
    const piDir = join(home, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "simple-flow.json"), JSON.stringify({ enabled: true, debug: true }));
    const globalOnly = loadConfig(cwd, home);
    assert.equal(globalOnly.enabled, true, "global overlay applies when no project overlay exists");
    assert.equal(globalOnly.debug, true);

    writeFileSync(join(cwd, "simple-flow.json"), JSON.stringify({ enabled: false }));
    const withProject = loadConfig(cwd, home);
    assert.equal(withProject.enabled, false, "project overlay wins over global");
    assert.equal(withProject.debug, true, "keys not restated by the project overlay survive from the global one");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig never reads slice-flow.json", () => {
  const cwd = tmpDir();
  const home = tmpDir();
  try {
    writeFileSync(join(cwd, "slice-flow.json"), JSON.stringify({ enabled: true, todoist: { enabled: true } }));
    const cfg = loadConfig(cwd, home);
    assert.equal(cfg.enabled, false, "slice-flow.json must never be read by simple-flow's loadConfig");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig throws a clear error on malformed JSON", () => {
  const cwd = tmpDir();
  const home = tmpDir();
  try {
    writeFileSync(join(cwd, "simple-flow.json"), "{ not json");
    assert.throws(() => loadConfig(cwd, home), /not valid JSON/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
