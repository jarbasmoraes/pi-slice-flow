import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const readmePath = join(here, "..", "README.md");
const testPlanPath = join(here, "..", "TEST-PLAN.md");
const readme = readFileSync(readmePath, "utf8");
const testPlan = readFileSync(testPlanPath, "utf8");

const bannedReadmeStrings = [
  "Builtin agents are reused",
  "no custom agent definitions to maintain",
  "zero custom agent definitions",
];

test("README.md no longer contains the stale builtin-reuse claims", () => {
  for (const banned of bannedReadmeStrings) {
    assert.ok(!readme.includes(banned), `README still contains banned string: "${banned}"`);
  }
});

test("both docs mention the dedicated slice-flow-researcher agent", () => {
  assert.ok(readme.includes("slice-flow-researcher"), "README must mention slice-flow-researcher");
  assert.ok(testPlan.includes("slice-flow-researcher"), "TEST-PLAN must mention slice-flow-researcher");
});

test("README documents the /feature-init command and the project profile file", () => {
  assert.ok(readme.includes("/feature-init"), "README must mention the /feature-init command");
  assert.ok(readme.includes(".slice-flow/PROJECT.md"), "README must mention the .slice-flow/PROJECT.md profile");
});
