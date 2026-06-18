import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reflectBrief } from "../extensions/lib/briefs.ts";
import { REFLECT_RUBRICS, reflectDirective, rubricPathOf } from "../extensions/lib/directives.ts";
import { startReflect } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import {
	createState,
	ensureReflectTree,
	ensureWorkTree,
	logEvent,
	reflectPaths,
	saveState,
	workPaths,
} from "../extensions/lib/workspace.ts";

// --- reflectBrief: a pure string that names the paths and forbids edits ------

test("reflectBrief names the rubric path, the cases path, and the judge", () => {
	const b = reflectBrief("plan", "/skills/plan-rubric/SKILL.md", "/reflect/plan-cases.md");
	assert.ok(b.includes("/skills/plan-rubric/SKILL.md"), "must name the rubric path");
	assert.ok(b.includes("/reflect/plan-cases.md"), "must name the cases path");
	assert.ok(b.includes("plan"), "must name the judge");
});

test("reflectBrief forbids editing the skill or any source file (proposals only)", () => {
	const b = reflectBrief("verify", "/r/SKILL.md", "/c/cases.md");
	assert.match(b, /PROPOSALS ONLY/);
	assert.match(b, /MUST NOT edit/);
	assert.match(b, /Apply nothing/);
	assert.match(b, /diff/, "must ask for unified-diff-style hunks");
});

// --- REFLECT_RUBRICS map -----------------------------------------------------

test("REFLECT_RUBRICS maps tunable judges to rubric skills and excludes frame", () => {
	assert.equal(REFLECT_RUBRICS.architect, "architecture-attack");
	assert.equal(REFLECT_RUBRICS.prototype, "prototype-rubric");
	assert.equal(REFLECT_RUBRICS.plan, "plan-rubric");
	assert.equal(REFLECT_RUBRICS.verify, "verify-rubrics");
	assert.equal(REFLECT_RUBRICS.frame, undefined, "frame is human-pinned and has no tunable rubric");
});

test("rubricPathOf points at a real bundled SKILL.md", () => {
	for (const skill of Object.values(REFLECT_RUBRICS)) {
		assert.ok(existsSync(rubricPathOf(skill)), `expected a SKILL.md for ${skill}`);
	}
});

// --- reflectDirective: a fresh-context oracle-judge run that applies nothing --

test("reflectDirective spawns a fresh oracle-judge with the rubric skill, reading cases + rubric", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-reflect-dir-"));
	const r = reflectPaths(cwd, ".pi/task");
	ensureReflectTree(r);
	const d = reflectDirective(r, DEFAULT_CONFIG, "plan", 1);
	assert.equal(d.kind, "reflect");
	assert.equal(d.args.context, "fresh");
	assert.equal(d.args.clarify, false);
	const step = d.args.chain[0];
	assert.equal(step.agent, "slice-flow-oracle-judge");
	assert.equal(step.skill, "plan-rubric");
	assert.equal(step.output, r.proposalsOf("plan"));
	assert.ok(step.reads.includes(r.casesOf("plan")), "must read the cases file");
	assert.ok(step.reads.some((f) => f.endsWith("plan-rubric/SKILL.md")), "must read the rubric file");
	// expects the proposals file, and the brief was written to the reflect logs.
	assert.deepEqual(d.expects, [r.proposalsOf("plan")]);
	assert.ok(step.reads.some((f) => f.includes("reflect") && f.endsWith("-brief.md")), "brief written to disk and injected");
});

test("reflectDirective rejects an unknown judge", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-reflect-bad-"));
	const r = reflectPaths(cwd, ".pi/task");
	ensureReflectTree(r);
	assert.throws(() => reflectDirective(r, DEFAULT_CONFIG, "frame", 1), /Unknown reflect judge/);
});

// --- startReflect: mines override cases from real task state on disk ---------

function taskWith(cwd, slug, events) {
	const p = workPaths(cwd, ".pi/task", slug);
	ensureWorkTree(p);
	const state = createState(slug, slug, "base123");
	for (const e of events) logEvent(state, e);
	saveState(p, state);
	return p;
}

test("startReflect compiles override cases and spawns a reflection agent for the judge", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-reflect-run-"));
	taskWith(cwd, "feat-a", ["gate plan: approve", "gate plan: revise", "plan revision requested"]);
	taskWith(cwd, "feat-b", ["gate plan: approve"]); // no override -> not a case

	const out = startReflect(cwd, DEFAULT_CONFIG, "plan");
	const r = reflectPaths(cwd, ".pi/task");
	assert.ok(existsSync(r.casesOf("plan")), "cases file written");
	const cases = readFileSync(r.casesOf("plan"), "utf8");
	assert.match(cases, /feat-a/, "the overriding task is listed");
	assert.ok(!cases.includes("## feat-b"), "the clean task is not a case");
	// the returned message carries a subagent directive to run
	assert.match(out, /subagent/);
	assert.match(out, /Reflect/);
	assert.match(out, /nothing is applied automatically/i);
});

test("startReflect with no override cases spawns nothing and says so", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-reflect-empty-"));
	taskWith(cwd, "feat-a", ["gate plan: approve", "gate verify: approve"]);
	const out = startReflect(cwd, DEFAULT_CONFIG, "plan");
	assert.match(out, /No human-override cases/);
	// an (empty) cases file is still compiled for inspection
	const r = reflectPaths(cwd, ".pi/task");
	assert.ok(existsSync(r.casesOf("plan")));
	assert.match(readFileSync(r.casesOf("plan"), "utf8"), /No human-override cases/);
});

test("startReflect over all judges defaults to every tunable rubric", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-reflect-all-"));
	taskWith(cwd, "feat-a", ["gate architect: revise", "gate verify: abort"]);
	const out = startReflect(cwd, DEFAULT_CONFIG);
	const r = reflectPaths(cwd, ".pi/task");
	// a cases file exists for every tunable judge, even those with no overrides
	for (const judge of Object.keys(REFLECT_RUBRICS)) {
		assert.ok(existsSync(r.casesOf(judge)), `missing cases file for ${judge}`);
	}
	// architect and verify had overrides -> two reflection directives spawned
	assert.match(out, /architect/);
	assert.match(out, /verify/);
});

test("startReflect rejects an unknown judge name", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-reflect-unknown-"));
	assert.throws(() => startReflect(cwd, DEFAULT_CONFIG, "nope"), /Unknown reflect judge/);
});
