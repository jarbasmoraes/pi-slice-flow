import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(join(here, "..", "prompts", "feature-escalate.md"), "utf8");

test("/feature-escalate: reads the fusion handoff and starts the standard workflow", () => {
  assert.match(prompt, /^---\n/, "needs prompt frontmatter");
  assert.ok(prompt.includes(".fusion/escalation.md"), "must default to the fusion handoff path");
  assert.ok(prompt.includes('"action": "start"'), "must enter the same slice_flow entry point as /feature");
  assert.ok(prompt.includes("## Task (verbatim)"), "must extract the verbatim task section");
  assert.ok(prompt.includes("FRAMING PARTNER"), "explore-stage contract must carry over");
  assert.ok(/nothing to escalate/i.test(prompt), "must stop cleanly when no handoff exists");
});
