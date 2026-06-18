import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { syncBundledAgents, preflightAgents } from "../extensions/lib/engine.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(here, "..", "agents");
const roles = ["scout", "researcher", "builder", "oracle-adversary", "oracle-judge", "planner", "reviewer"];

// The full agents map the workflow actually configures (see slice-flow.json /
// DEFAULT_CONFIG.agents) — every value resolves to one of the bundled files.
const cfg = {
  agents: {
    intake: "slice-flow-scout",
    research: "slice-flow-researcher",
    attack: "slice-flow-oracle-adversary",
    compile: "slice-flow-scout",
    frameJudge: "slice-flow-oracle-judge",
    hypothesis: "slice-flow-scout",
    architectJudge: "slice-flow-oracle-judge",
    prototype: "slice-flow-builder",
    prototypeJudge: "slice-flow-oracle-judge",
    plan: "slice-flow-planner",
    planJudge: "slice-flow-oracle-judge",
    build: "slice-flow-builder",
    review: "slice-flow-reviewer",
    fixup: "slice-flow-builder",
    verify: "slice-flow-reviewer",
  },
};

function freshCwd() {
  return mkdtempSync(join(tmpdir(), "slice-flow-provision-"));
}

test("a fresh install provisions all bundled agents into <cwd>/.pi/agents/", () => {
  // Simulates the real install path end-to-end: no .pi/agents/ exists yet.
  const cwd = freshCwd();
  assert.ok(!existsSync(join(cwd, ".pi", "agents")), "precondition: target dir absent");

  const provisioned = syncBundledAgents(cwd);

  assert.equal(provisioned.length, roles.length, "all bundled agents are copied");
  for (const role of roles) {
    const dest = join(cwd, ".pi", "agents", `slice-flow-${role}.md`);
    assert.ok(existsSync(dest), `slice-flow-${role}.md was provisioned`);
    assert.equal(
      readFileSync(dest, "utf8"),
      readFileSync(join(bundleDir, `slice-flow-${role}.md`), "utf8"),
      `provisioned slice-flow-${role}.md matches the bundle byte-for-byte`,
    );
  }
});

test("after provisioning, the preflight passes for the full configured agents map", () => {
  const cwd = freshCwd();
  syncBundledAgents(cwd);
  assert.doesNotThrow(() => preflightAgents(cwd, cfg));
});

test("syncBundledAgents is idempotent and never clobbers an existing copy", () => {
  const cwd = freshCwd();
  syncBundledAgents(cwd);

  // A user customizes one discovered agent; a second sync must leave it intact.
  const custom = join(cwd, ".pi", "agents", "slice-flow-scout.md");
  writeFileSync(custom, "# locally customized\n", "utf8");

  const second = syncBundledAgents(cwd);
  assert.equal(second.length, 0, "nothing is re-copied when every file already exists");
  assert.equal(readFileSync(custom, "utf8"), "# locally customized\n", "existing copy is untouched");
});

test("a missing bundle is a no-op (returns []) so the preflight reports the broken install", () => {
  const cwd = freshCwd();
  const provisioned = syncBundledAgents(cwd, join(cwd, "no-such-bundle"));
  assert.deepEqual(provisioned, [], "no files claimed when the bundle is absent");
  assert.ok(!existsSync(join(cwd, ".pi", "agents")), "no target dir created from an absent bundle");
  assert.throws(() => preflightAgents(cwd, cfg), /required agent\(s\) not found/);
});
