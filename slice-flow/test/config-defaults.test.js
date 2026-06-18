import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, "..", "extensions", "lib", "config.ts");
const configText = readFileSync(configPath, "utf8");

// The expected mapping from phase to namespaced agent (must match slice-flow.json).
const expectedAgents = {
  intake: "slice-flow-scout",
  research: "slice-flow-researcher",
  attack: "slice-flow-oracle",
  compile: "slice-flow-scout",
  frameJudge: "slice-flow-oracle",
  hypothesis: "slice-flow-scout",
  architectJudge: "slice-flow-oracle",
  prototype: "slice-flow-builder",
  prototypeJudge: "slice-flow-oracle",
  plan: "slice-flow-planner",
  build: "slice-flow-builder",
  review: "slice-flow-reviewer",
  fixup: "slice-flow-builder",
  verify: "slice-flow-reviewer",
};

/** Isolate the DEFAULT_CONFIG.agents { ... } block text. */
function agentsBlock() {
  const start = configText.indexOf("agents: {");
  assert.ok(start !== -1, "could not find agents: { block in config.ts");
  const end = configText.indexOf("}", start);
  assert.ok(end !== -1, "could not find closing } of agents block");
  return configText.slice(start, end + 1);
}

test("DEFAULT_CONFIG.agents maps all 14 phases to namespaced slice-flow-<role> agents", () => {
  const block = agentsBlock();
  for (const [phase, agent] of Object.entries(expectedAgents)) {
    assert.match(
      block,
      new RegExp(`${phase}:\\s*"${agent}"`),
      `phase ${phase} must map to "${agent}"`,
    );
  }
});

test("every quoted value in the agents block is a slice-flow-* name", () => {
  const block = agentsBlock();
  const values = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(values.length, 14, "agents block must have 14 values");
  for (const value of values) {
    assert.match(value, /^slice-flow-(scout|researcher|builder|oracle|planner|reviewer)$/, `value ${value} is not namespaced`);
  }
});

test("the agents block contains no generic builtin token as a value", () => {
  const block = agentsBlock();
  for (const token of ["scout", "researcher", "oracle", "worker", "planner", "reviewer"]) {
    assert.doesNotMatch(block, new RegExp(`"${token}"`), `agents block still uses generic builtin "${token}"`);
  }
});

test("config.ts no longer contains the stale fallback comment phrase", () => {
  assert.ok(!configText.includes("unchanged until slice-flow.json overrides"), "banned comment phrase still present");
});

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";

test("high-leverage phases are not pinned to the cheapest tier (T0.2 re-tier)", () => {
  // Architecture seams and correctness fix-ups must not run on the lightweight
  // tier. hypothesis is named explicitly (its scout agent is haiku-pinned);
  // fixup is null so it inherits the builder's strong session default.
  assert.notEqual(DEFAULT_CONFIG.models.hypothesis, "anthropic/claude-haiku-4-5", "hypothesis must not be haiku");
  assert.equal(DEFAULT_CONFIG.models.fixup, null, "fixup must inherit the strong session default");
});

test("loop re-verifies all dimensions by default and bounds plan replans", () => {
  assert.equal(DEFAULT_CONFIG.reverifyAllInLoop, true);
  assert.equal(typeof DEFAULT_CONFIG.maxPlanRetries, "number");
});
