import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyAxes, classifySignals } from "../extensions/lib/detect-stack.ts";

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, "..", "skills", "risk-taxonomy", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");

/** Every axis key the code can emit: classify a maximally-loaded stack. */
function allCodeAxes() {
	const maximal = classifySignals(new Set(["neo4j-driver", "@clerk/nextjs", "@prisma/client", "stripe", "bullmq", "express", "react-markdown"]));
	return new Set(classifyAxes(maximal));
}

/** The axis keys documented in the skill, from `### <key> — ...` headings. */
function skillAxisKeys() {
	const keys = new Set();
	for (const m of skill.matchAll(/^###\s+([a-z-]+)\s+—/gm)) keys.add(m[1]);
	return keys;
}

test("the skill documents exactly the axes the code can emit (no drift)", () => {
	const code = allCodeAxes();
	const doc = skillAxisKeys();
	assert.deepEqual([...doc].sort(), [...code].sort(), "risk-taxonomy SKILL.md axis keys must match the RiskAxis values classifyAxes emits");
});

test("each documented axis carries the three consumer-facing fields", () => {
	// Split on axis headings and assert each section has Live when / Touched when / Check.
	const sections = skill.split(/^###\s+/gm).slice(1);
	for (const section of sections) {
		const key = section.match(/^([a-z-]+)\s+—/)?.[1];
		if (!key) continue;
		assert.match(section, /\*\*Live when:\*\*/, `${key} missing "Live when"`);
		assert.match(section, /\*\*Touched when:\*\*/, `${key} missing "Touched when"`);
		assert.match(section, /\*\*Check:\*\*/, `${key} missing "Check"`);
	}
});

test("the skill preserves the owner-rules override block", () => {
	assert.match(skill, /<!-- BEGIN OWNER RULES -->/);
	assert.match(skill, /<!-- END OWNER RULES -->/);
});
