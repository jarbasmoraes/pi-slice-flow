import { test } from "node:test";
import assert from "node:assert/strict";

import { runTags, normalizeDisposition } from "../extensions/lib/engine.ts";

/** A minimal State stub carrying only the fields runTags reads. */
function stateWith(overrides = {}) {
	return {
		cohort: "v0.3.0",
		phase: "frame",
		ui: null,
		codegraphReady: false,
		isolation: undefined,
		judgeFamilies: ["claude"],
		projectProfile: undefined,
		todoist: undefined,
		compileRetries: 0,
		archRejudgeRetries: 0,
		archReconsiderRetries: 0,
		planRetries: 0,
		prototypeRetries: 0,
		...overrides,
	};
}

test("runTags emits cohort, phase, codegraph, isolation and judge tags by default", () => {
	const tags = runTags(stateWith());
	assert.ok(tags.includes("cohort:v0.3.0"));
	assert.ok(tags.includes("phase:frame"));
	assert.ok(tags.includes("codegraph:absent"));
	assert.ok(tags.includes("isolation:inplace"));
	assert.ok(tags.includes("judge:claude"));
	// Optional tags are absent when their state is missing.
	assert.ok(!tags.some((t) => t.startsWith("ui:")));
	assert.ok(!tags.includes("profile:present"));
	assert.ok(!tags.includes("todoist:on"));
	assert.ok(!tags.some((t) => t.startsWith("branch:")));
	assert.ok(!tags.some((t) => t.startsWith("disposition:")));
	assert.ok(!tags.some((t) => t.startsWith("retries:")));
});

test("runTags emits branch, disposition and per-gate retry tags", () => {
	const tags = runTags(
		stateWith({
			isolation: { worktree: { branch: "slice-flow/my-feature" }, disposition: "Create a PR" },
			planRetries: 2,
			compileRetries: 1,
		}),
	);
	assert.ok(tags.includes("branch:slice-flow/my-feature"));
	assert.ok(tags.includes("disposition:pr"));
	assert.ok(tags.includes("retries:plan:2"));
	assert.ok(tags.includes("retries:compile:1"));
	// Zero-count retry gates are not tagged.
	assert.ok(!tags.includes("retries:prototype:0"));
});

test("normalizeDisposition collapses labels to categorical values", () => {
	assert.equal(normalizeDisposition("Create a PR"), "pr");
	assert.equal(normalizeDisposition("Merge to a local branch"), "local-merge");
	assert.equal(normalizeDisposition("Manual merge — leave the branch to inspect later"), "manual");
	assert.equal(normalizeDisposition("manual"), "manual");
	assert.equal(normalizeDisposition("something else"), "other");
});

test("phase tag tracks the current phase (upsert reflects the furthest reached)", () => {
	assert.ok(runTags(stateWith({ phase: "plan" })).includes("phase:plan"));
	assert.ok(runTags(stateWith({ phase: "done" })).includes("phase:done"));
	assert.ok(runTags(stateWith({ phase: "stopped" })).includes("phase:stopped"));
});

test("runTags reflects resolved run attributes", () => {
	const tags = runTags(
		stateWith({
			ui: "greenfield",
			codegraphReady: true,
			isolation: { worktree: { path: "/tmp/wt", branch: "b" } },
			judgeFamilies: ["claude", "gpt"],
			projectProfile: { text: "x" },
			todoist: { taskId: "123", project: "p", sectionMode: "sections" },
		}),
	);
	assert.ok(tags.includes("ui:greenfield"));
	assert.ok(tags.includes("codegraph:ready"));
	assert.ok(tags.includes("isolation:worktree"));
	assert.ok(tags.includes("judge:claude"));
	assert.ok(tags.includes("judge:gpt"));
	assert.ok(tags.includes("profile:present"));
	assert.ok(tags.includes("todoist:on"));
});

test('ui:"none" is not emitted as a tag', () => {
	assert.ok(!runTags(stateWith({ ui: "none" })).some((t) => t.startsWith("ui:")));
});
