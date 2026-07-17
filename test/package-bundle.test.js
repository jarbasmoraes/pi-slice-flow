import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { syncBundledAgents } from "../extensions/lib/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const bundleDir = join(here, "..", "agents");

// .pi/agents/ is a *provisioned* artifact, not something to discover in a
// fresh clone or CI — provision it into a throwaway dir so this test is
// hermetic rather than depending on some ambient project's sync history.
const tmpProjectDir = mkdtempSync(join(tmpdir(), "slice-flow-package-bundle-test-"));
syncBundledAgents(tmpProjectDir, bundleDir);
const discoveredDir = join(tmpProjectDir, ".pi", "agents");

const roles = ["scout", "researcher", "builder", "oracle-adversary", "oracle-judge", "planner", "reviewer"];

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

test("package.json parses and pi.agents includes ./agents", () => {
  assert.ok(Array.isArray(pkg.pi.agents), "pi.agents must be an array");
  assert.ok(pkg.pi.agents.includes("./agents"), "pi.agents must include ./agents");
});

test("pi.extensions, pi.skills, pi.prompts are unchanged", () => {
  assert.deepEqual(pkg.pi.extensions, [
    "./extensions/slice-flow.ts",
    "./extensions/web-research.ts",
  ]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.deepEqual(pkg.pi.prompts, ["./prompts"]);
});

test("all slice-flow-<role> bundle files still exist", () => {
  for (const role of roles) {
    assert.ok(
      existsSync(join(bundleDir, `slice-flow-${role}.md`)),
      `missing bundle slice-flow-${role}.md`,
    );
  }
});

test("none of the orphaned old slice-<role>.md files remain in .pi/agents/", () => {
  for (const role of roles) {
    assert.ok(
      !existsSync(join(discoveredDir, `slice-${role}.md`)),
      `orphaned slice-${role}.md still present in .pi/agents/`,
    );
  }
});

test("all namespaced slice-flow-<role>.md files still exist in .pi/agents/", () => {
  for (const role of roles) {
    assert.ok(
      existsSync(join(discoveredDir, `slice-flow-${role}.md`)),
      `missing discovered slice-flow-${role}.md`,
    );
  }
});
