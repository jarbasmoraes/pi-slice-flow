import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { preflightAgents } from "../extensions/lib/engine.ts";

/** Build a temp cwd containing .pi/agents/ with a file for each present agent. */
function makeTree(present) {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-preflight-"));
  const agentsDir = join(cwd, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const name of present) {
    writeFileSync(join(agentsDir, `${name}.md`), `# ${name}\n`, "utf8");
  }
  return cwd;
}

/** Minimal throwaway config: preflightAgents only reads cfg.agents. */
function cfgWith(agents) {
  return { agents };
}

test("preflightAgents returns normally when every agent file exists", () => {
  const agents = {
    build: "slice-flow-builder",
    review: "slice-flow-reviewer",
    plan: "slice-flow-planner",
  };
  const cwd = makeTree(["slice-flow-builder", "slice-flow-reviewer", "slice-flow-planner"]);
  assert.doesNotThrow(() => preflightAgents(cwd, cfgWith(agents)));
});

test("preflightAgents dedupes repeated agent names and passes with one file each", () => {
  // build and fixup both point at the builder; one file should satisfy both.
  const agents = {
    build: "slice-flow-builder",
    fixup: "slice-flow-builder",
    review: "slice-flow-reviewer",
  };
  const cwd = makeTree(["slice-flow-builder", "slice-flow-reviewer"]);
  assert.doesNotThrow(() => preflightAgents(cwd, cfgWith(agents)));
});

test("preflightAgents throws naming the missing agent and not the present ones", () => {
  const agents = {
    build: "slice-flow-builder",
    review: "slice-flow-reviewer",
    plan: "slice-flow-planner",
  };
  // builder is absent; reviewer and planner are present.
  const cwd = makeTree(["slice-flow-reviewer", "slice-flow-planner"]);
  assert.throws(
    () => preflightAgents(cwd, cfgWith(agents)),
    (err) => {
      assert.ok(err instanceof Error, "throws an Error");
      assert.match(err.message, /slice-flow-builder/, "names the missing agent");
      assert.doesNotMatch(err.message, /slice-flow-reviewer/, "does not name a present agent");
      assert.doesNotMatch(err.message, /slice-flow-planner/, "does not name a present agent");
      return true;
    },
  );
});

test("preflightAgents lists every missing agent when several are absent", () => {
  const agents = {
    build: "slice-flow-builder",
    review: "slice-flow-reviewer",
    plan: "slice-flow-planner",
  };
  // only planner is present.
  const cwd = makeTree(["slice-flow-planner"]);
  assert.throws(
    () => preflightAgents(cwd, cfgWith(agents)),
    (err) => {
      assert.match(err.message, /slice-flow-builder/, "names builder");
      assert.match(err.message, /slice-flow-reviewer/, "names reviewer");
      assert.doesNotMatch(err.message, /slice-flow-planner/, "does not name present planner");
      return true;
    },
  );
});
