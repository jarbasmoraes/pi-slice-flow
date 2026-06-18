import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const pkgPath = join(here, "..", "package.json");
const bundleDir = join(here, "..", "agents");
const discoveredDir = join(repoRoot, ".pi", "agents");

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
