import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextStep } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { VERIFY_DIMENSIONS, createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";
import { resetTodoist } from "../extensions/lib/todoist.ts";

/** A verify-phase run with all five dimensions PASS, poised at the completion
 * gate. checks are disabled so the gate title carries only the judge notice. */
function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), `slice-flow-${slug}-`));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	const state = createState("feat", "feat", "base123");
	for (const dim of VERIFY_DIMENSIONS) {
		writeFileSync(join(p.verify, `${dim}.md`), "VERDICT: PASS\n");
	}
	state.phase = "verify";
	state.pending = { kind: "verify", seq: 0, label: "Phase 5 — VERIFY", args: {} };
	return { p, state };
}

/** A UI that approves the gate and captures the select dialog's title. */
function approvingUi(captured) {
	return {
		hasUI: true,
		ui: {
			notify() {},
			select: async (title) => {
				captured.push(title);
				return "Approve and continue";
			},
		},
	};
}

const cfg = { ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks, enabled: false } };

test.beforeEach(() => {
	resetTodoist();
});

test("Claude-only cross mode surfaces the same-family caveat on the completion gate", async () => {
	const { p, state } = setup("gate-caveat");
	state.judgeFamilies = ["claude"];
	const captured = [];
	const out = await nextStep(approvingUi(captured), p, cfg, state);
	assert.equal(state.phase, "done");
	assert.match(out, /COMPLETE/);
	assert.equal(captured.length, 1);
	assert.match(captured[0], /judge provenance: only the claude family is available/);
});

test("no provenance notice when the judges actually crossed families", async () => {
	const { p, state } = setup("gate-crossed");
	state.judgeFamilies = ["claude", "gpt"];
	const captured = [];
	await nextStep(approvingUi(captured), p, cfg, state);
	assert.equal(captured.length, 1);
	assert.doesNotMatch(captured[0], /judge provenance/);
});

test('no provenance notice under judgeFamily:"same" (nothing was requested, nothing degraded)', async () => {
	const { p, state } = setup("gate-same");
	state.judgeFamilies = ["claude"];
	const captured = [];
	await nextStep(approvingUi(captured), p, { ...cfg, judgeFamily: "same" }, state);
	assert.equal(captured.length, 1);
	assert.doesNotMatch(captured[0], /judge provenance/);
});
