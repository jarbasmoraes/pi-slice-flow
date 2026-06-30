import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "../extensions/lib/config.ts";

/** A throwaway pair of (project cwd, fake home dir) for hermetic loadConfig runs. */
function dirs() {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cfg-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "slice-flow-cfg-home-"));
  return { cwd, home };
}

function writeGlobal(home, obj) {
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "slice-flow.json"), JSON.stringify(obj));
}

function writeProject(cwd, obj) {
  writeFileSync(join(cwd, "slice-flow.json"), JSON.stringify(obj));
}

test("with neither file present, loadConfig returns the defaults", () => {
  const { cwd, home } = dirs();
  const cfg = loadConfig(cwd, home);
  assert.equal(cfg.prototypeCount, DEFAULT_CONFIG.prototypeCount);
  assert.equal(cfg.autoApprove, DEFAULT_CONFIG.autoApprove);
});

test("the global ~/.pi/slice-flow.json applies when no project file exists", () => {
  const { cwd, home } = dirs();
  writeGlobal(home, { prototypeCount: 7, autoApprove: true });
  const cfg = loadConfig(cwd, home);
  assert.equal(cfg.prototypeCount, 7);
  assert.equal(cfg.autoApprove, true);
});

test("a project slice-flow.json overrides the global one key-by-key", () => {
  const { cwd, home } = dirs();
  writeGlobal(home, { prototypeCount: 7, planCount: 4 });
  writeProject(cwd, { prototypeCount: 2 });
  const cfg = loadConfig(cwd, home);
  // project wins where it speaks...
  assert.equal(cfg.prototypeCount, 2);
  // ...the global still supplies the keys the project omits...
  assert.equal(cfg.planCount, 4);
  // ...and DEFAULT_CONFIG fills the rest.
  assert.equal(cfg.maxLoopIterations, DEFAULT_CONFIG.maxLoopIterations);
});

test("nested maps merge across all three layers (default < global < project)", () => {
  const { cwd, home } = dirs();
  writeGlobal(home, { models: { build: "anthropic/claude-sonnet-4-6", review: "openai-codex/gpt-5.5" } });
  writeProject(cwd, { models: { build: "anthropic/claude-opus-4-8" } });
  const cfg = loadConfig(cwd, home);
  assert.equal(cfg.models.build, "anthropic/claude-opus-4-8", "project overrides global for build");
  assert.equal(cfg.models.review, "openai-codex/gpt-5.5", "global supplies review");
  assert.equal(cfg.models.verify, DEFAULT_CONFIG.models.verify, "default supplies untouched keys");
});

test("autonomy and agents maps also merge rather than replace wholesale", () => {
  const { cwd, home } = dirs();
  writeGlobal(home, { autonomy: { plan: "auto" }, agents: { build: "slice-flow-builder" } });
  writeProject(cwd, { autonomy: { verify: "auto" } });
  const cfg = loadConfig(cwd, home);
  assert.equal(cfg.autonomy.plan, "auto", "global autonomy key survives");
  assert.equal(cfg.autonomy.verify, "auto", "project autonomy key applies");
  assert.equal(cfg.autonomy.frame, "human", "default autonomy keys remain");
});

test("the checks map merges key-by-key like the other nested maps", () => {
  const { cwd, home } = dirs();
  writeGlobal(home, { checks: { mode: "block" } });
  writeProject(cwd, { checks: { enabled: false } });
  const cfg = loadConfig(cwd, home);
  assert.equal(cfg.checks.enabled, false, "project checks key applies");
  assert.equal(cfg.checks.mode, "block", "global checks key survives");
  assert.deepEqual(cfg.checks.oracles, DEFAULT_CONFIG.checks.oracles, "default checks keys remain");
});

test("a malformed global file throws a path-qualified error", () => {
  const { cwd, home } = dirs();
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "slice-flow.json"), "{ not json");
  assert.throws(() => loadConfig(cwd, home), /slice-flow\.json is not valid JSON/);
});
