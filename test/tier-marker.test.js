import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tierMarkerOf, composeHandoff } from "../extensions/lib/workspace.ts";
import { intakeBrief } from "../extensions/lib/briefs.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { JUDGE_FAMILY_REGISTRY } from "../extensions/lib/judge-family.ts";

const dir = mkdtempSync(join(tmpdir(), "tier-"));
const file = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

test("tierMarkerOf: reads GATED and FULL, case-insensitive", () => {
  assert.equal(tierMarkerOf(file("a.md", "INTAKE: SUFFICIENT\nTIER: GATED\n")), "GATED");
  assert.equal(tierMarkerOf(file("b.md", "INTAKE: QUESTIONS\ntier: full\n")), "FULL");
});

test("tierMarkerOf: null when absent or file missing (older intakes)", () => {
  assert.equal(tierMarkerOf(file("c.md", "INTAKE: SUFFICIENT\nno verdict here")), null);
  assert.equal(tierMarkerOf(join(dir, "missing.md")), null);
});

test("intake brief instructs the TIER verdict with the gated criteria", () => {
  const paths = { intake: "/task/frame/00-intake.md" };
  const brief = intakeBrief(paths, "add retry to webhooks", false);
  assert.ok(brief.includes('"TIER: GATED" or "TIER: FULL"'));
  for (const criterion of ["blast radius", "400 LOC", "machine-verifiable"]) {
    assert.ok(brief.toLowerCase().includes(criterion.toLowerCase()), `criterion missing: ${criterion}`);
  }
});

test("composeHandoff carries the task, the assessment, and both valve directions", () => {
  const md = composeHandoff({
    feature: "add retry to webhooks",
    intakeText: "INTAKE: SUFFICIENT\nTIER: GATED\n- summary line",
    cwd: "/repo",
    slug: "20260720-webhooks",
    when: "2026-07-20T12:00:00Z",
  });
  for (const needle of [
    "GATED",
    "add retry to webhooks",
    "INTAKE: SUFFICIENT",
    "/auto-validate",
    "fh-workhorse",
    ".fusion/escalation.md",
    "/feature-escalate",
    "20260720-webhooks",
  ]) {
    assert.ok(md.includes(needle), `missing: ${needle}`);
  }
});

test("model roster: fable and gpt-5.6 are weighted, judge registry rides current codex models", () => {
  assert.ok(DEFAULT_CONFIG.modelWeights.fable >= DEFAULT_CONFIG.modelWeights.opus, "fable (Mythos tier) must weigh at least opus");
  assert.ok(DEFAULT_CONFIG.modelWeights["gpt-5.6"] > 0, "gpt-5.6 family must be weighted");
  const gpt = JUDGE_FAMILY_REGISTRY.find((e) => e.family === "gpt");
  assert.ok(gpt.model.startsWith("openai-codex/gpt-5.6"), `stale judge model: ${gpt.model}`);
  assert.ok(gpt.cheapModel.startsWith("openai-codex/gpt-5.6"), `stale cheap judge: ${gpt.cheapModel}`);
});
