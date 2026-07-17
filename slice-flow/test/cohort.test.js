import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, loadConfig } from "../extensions/lib/config.ts";
import { startWorkflow } from "../extensions/lib/engine.ts";
import { createState, loadState, workPaths } from "../extensions/lib/workspace.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The version tag DEFAULT_CONFIG.cohort should resolve to right now — read
 * from package.json directly so this test never needs a manual bump when the
 * package's own version changes. */
function expectedReleaseCohort() {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  return `v${pkg.version}`;
}

test("DEFAULT_CONFIG.cohort defaults to slice-flow's own package.json version", () => {
  assert.equal(DEFAULT_CONFIG.cohort, expectedReleaseCohort());
});

test("a project slice-flow.json can override cohort for a finer-grained tag within one version", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cohort-cfg-"));
  const home = mkdtempSync(join(tmpdir(), "slice-flow-cohort-home-"));
  writeFileSync(join(cwd, "slice-flow.json"), JSON.stringify({ cohort: "opus-tiering-experiment" }));
  const cfg = loadConfig(cwd, home);
  assert.equal(cfg.cohort, "opus-tiering-experiment");
});

test("createState's placeholder cohort is always overwritten before it matters", () => {
  const s = createState("My feature", "my-feature", "abc123");
  assert.equal(s.cohort, "unknown");
});

test("loadState back-fills a legacy task (predating cohort tracking) distinctly from a real tag", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cohort-state-"));
  const p = workPaths(cwd, ".pi/task", "my-feature");
  mkdirSync(p.root, { recursive: true });

  const legacy = createState("My feature", "my-feature", "abc123");
  delete legacy.cohort;
  writeFileSync(p.state, JSON.stringify(legacy, null, 2), "utf8");
  const loadedLegacy = loadState(p);
  assert.ok(loadedLegacy !== null);
  assert.equal(loadedLegacy.cohort, "pre-cohort-tracking");

  const tagged = createState("My feature", "my-feature", "abc123");
  tagged.cohort = "v0.2.0";
  writeFileSync(p.state, JSON.stringify(tagged, null, 2), "utf8");
  const loadedTagged = loadState(p);
  assert.ok(loadedTagged !== null);
  assert.equal(loadedTagged.cohort, "v0.2.0");
});

test("startWorkflow stamps state.cohort from cfg.cohort, defaulting to the released version", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cohort-start-"));
  const p = workPaths(cwd, ".pi/task", "feat");
  startWorkflow(p, DEFAULT_CONFIG, "Feat", "feat", "base123", cwd, "silent");
  assert.equal(loadState(p).cohort, expectedReleaseCohort());
});

test("startWorkflow stamps a custom cohort from an overridden config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-cohort-start-custom-"));
  const p = workPaths(cwd, ".pi/task", "feat");
  startWorkflow(p, { ...DEFAULT_CONFIG, cohort: "opus-tiering-v2" }, "Feat", "feat", "base123", cwd, "silent");
  assert.equal(loadState(p).cohort, "opus-tiering-v2");
});
