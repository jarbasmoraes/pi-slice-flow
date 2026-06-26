import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const bundleDir = join(here, "..", "agents");
const discoveredDir = join(repoRoot, ".pi", "agents");

const roles = ["scout", "researcher", "builder", "oracle-adversary", "oracle-judge", "planner", "reviewer"];

function frontmatter(text) {
  const lines = text.split("\n");
  const first = lines.indexOf("---");
  const second = lines.indexOf("---", first + 1);
  assert.ok(first !== -1 && second !== -1, "file must have frontmatter delimited by ---");
  return lines.slice(first + 1, second);
}

function frontmatterValue(text, key) {
  for (const line of frontmatter(text)) {
    if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

test("all bundle files exist in slice-flow/agents/", () => {
  for (const role of roles) {
    assert.ok(existsSync(join(bundleDir, `slice-flow-${role}.md`)), `missing bundle slice-flow-${role}.md`);
  }
});

test("each bundle frontmatter uses the namespaced name and no bare slice-<role> name line", () => {
  // Note: the prose system-prompt body of each agent contains a descriptive
  // self-reference (e.g. "You are `slice-scout` ..."). The slice's byte-fidelity
  // requirement and "do not change the system prompt" rule forbid editing it, so
  // the "no bare name" guard is scoped to the resolution-relevant frontmatter.
  for (const role of roles) {
    const text = readFileSync(join(bundleDir, `slice-flow-${role}.md`), "utf8");
    assert.equal(frontmatterValue(text, "name"), `slice-flow-${role}`);
    const fm = frontmatter(text).join("\n");
    assert.ok(!/^name: slice-(scout|researcher|builder|oracle|planner|reviewer)$/m.test(fm), `bundle slice-flow-${role}.md frontmatter still carries a bare slice-<role> name`);
  }
});

test("read-only verdict agents disable the completion mutation guard", () => {
  // oracle-judge / oracle-adversary / reviewer return a verdict as their captured
  // final answer and never edit source. Without completionGuard: false, pi-subagents
  // misclassifies a (correct) no-edit completion as a failed "implementation task"
  // and the verdict is never saved — re-running the phase and littering slices.
  for (const role of ["oracle-judge", "oracle-adversary", "reviewer"]) {
    const text = readFileSync(join(bundleDir, `slice-flow-${role}.md`), "utf8");
    assert.equal(frontmatterValue(text, "completionGuard"), "false", `slice-flow-${role} must set completionGuard: false`);
  }
});

test("researcher bundle keeps web_search and fetch_content tools", () => {
  const text = readFileSync(join(bundleDir, "slice-flow-researcher.md"), "utf8");
  const tools = frontmatterValue(text, "tools");
  assert.ok(tools.includes("web_search"), "researcher must keep web_search");
  assert.ok(tools.includes("fetch_content"), "researcher must keep fetch_content");
});

test("model lines are preserved per role", () => {
  const builder = readFileSync(join(bundleDir, "slice-flow-builder.md"), "utf8");
  const planner = readFileSync(join(bundleDir, "slice-flow-planner.md"), "utf8");
  assert.equal(frontmatterValue(builder, "model"), undefined, "builder must have no model line");
  assert.equal(frontmatterValue(planner, "model"), undefined, "planner must have no model line");

  assert.equal(frontmatterValue(readFileSync(join(bundleDir, "slice-flow-scout.md"), "utf8"), "model"), "anthropic/claude-haiku-4-5");
  assert.equal(frontmatterValue(readFileSync(join(bundleDir, "slice-flow-researcher.md"), "utf8"), "model"), "anthropic/claude-haiku-4-5");
  assert.equal(frontmatterValue(readFileSync(join(bundleDir, "slice-flow-oracle-adversary.md"), "utf8"), "model"), "anthropic/claude-opus-4-8");
  assert.equal(frontmatterValue(readFileSync(join(bundleDir, "slice-flow-oracle-judge.md"), "utf8"), "model"), "anthropic/claude-opus-4-8");
  assert.equal(frontmatterValue(readFileSync(join(bundleDir, "slice-flow-reviewer.md"), "utf8"), "model"), "anthropic/claude-opus-4-8");
});

test("apart from the name line, each bundle is byte-identical to its source", () => {
  for (const role of roles) {
    // Slice 003 deletes the original .pi/agents/slice-<role>.md sources; once gone,
    // slice-flow/agents/ is the source of truth and this fidelity check is moot.
    const sourcePath = join(discoveredDir, `slice-${role}.md`);
    if (!existsSync(sourcePath)) continue;
    const source = readFileSync(sourcePath, "utf8");
    const bundle = readFileSync(join(bundleDir, `slice-flow-${role}.md`), "utf8");
    const strip = (t) => t.split("\n").filter((l) => !l.startsWith("name:")).join("\n");
    assert.equal(strip(bundle), strip(source), `bundle slice-flow-${role}.md differs from source beyond the name line`);
  }
});

test("the same namespaced files exist in .pi/agents/", () => {
  for (const role of roles) {
    const discovered = join(discoveredDir, `slice-flow-${role}.md`);
    assert.ok(existsSync(discovered), `missing discovered copy slice-flow-${role}.md`);
    const bundle = readFileSync(join(bundleDir, `slice-flow-${role}.md`), "utf8");
    assert.equal(readFileSync(discovered, "utf8"), bundle, `discovered slice-flow-${role}.md differs from bundle`);
  }
});

test("slice-flow.json agents object points only at namespaced agents", () => {
  const cfg = JSON.parse(readFileSync(join(repoRoot, "slice-flow.json"), "utf8"));
  const pattern = /^slice-flow-(scout|researcher|builder|oracle-adversary|oracle-judge|planner|reviewer)$/;
  for (const [phase, value] of Object.entries(cfg.agents)) {
    assert.match(value, pattern, `agent for phase ${phase} is not namespaced: ${value}`);
  }
  // Model overrides may be null (inherit), a single "provider/model" id, or a
  // list of such ids that round-robins across a fan-out's parallel runs.
  const modelId = /^[a-z0-9-]+\/[A-Za-z0-9.:_-]+$/;
  const assertModelSpec = (spec, phase) => {
    if (spec === null) return;
    const list = Array.isArray(spec) ? spec : [spec];
    assert.ok(list.length > 0, `model override for ${phase} is an empty list`);
    for (const id of list) {
      assert.match(id, modelId, `model override for ${phase} is not a provider/model id: ${id}`);
    }
  };
  for (const [phase, value] of Object.entries(cfg.models)) {
    assertModelSpec(value, phase);
  }
});
