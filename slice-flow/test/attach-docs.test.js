import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextStep } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";
import { resetTodoist, getTodoist } from "../extensions/lib/todoist.ts";

const NO_UI = { hasUI: false, ui: {} };
const cfg = { ...DEFAULT_CONFIG, autoApprove: true, todoist: { enabled: true } };

/** Records every exec invocation; returns canned success output. */
function fakeExec(records, handler) {
	return async (cmd, args, opts) => {
		records.push({ cmd, args, opts });
		return handler ? handler(cmd, args, opts) : { code: 0, stdout: "{}", stderr: "" };
	};
}

/** Isolates just the attach ops (TODOIST_CREATE_COMMENT_V1 calls carrying an
 * `attachment` param) from a record list. As of slice 008, a `comment-only`
 * `state.todoist` (this fixture's sectionMode, chosen back in slice 006 to
 * keep transitionPhase's own move/comment traffic out of these attach-focused
 * assertions) now also enqueues its own plain phase-transition comment on
 * every transition; filtering to attach ops keeps these assertions about
 * exactly what they were always meant to test. */
function attachOps(records) {
	return records.filter((r) => r.args[1] === "TODOIST_CREATE_COMMENT_V1" && JSON.parse(r.args[3]).attachment);
}

function setup(slug) {
	const cwd = mkdtempSync(join(tmpdir(), `slice-flow-${slug}-`));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);
	return { p, state: createState("feat", "feat", "base123") };
}

const VALID_FRAME = `## Problem
- something needs doing
## What the code does today
- nothing yet
## Proposed solution
- add the feature
## Why this solves the problem
- it closes the gap
## Acceptance criteria
- the thing works
## Out of scope
- other stuff
## Open questions
- none
`;

const VALID_ARCH = `WINNER: hypothesis-1

## Winner
The winning design.
\`\`\`mermaid
graph TD; A-->B;
\`\`\`

## Goals & Non-Goals
- Goal: ship it.
- Non-goal: not that.

## Architecture Overview
Prose overview of the structure and the main flow.
\`\`\`mermaid
sequenceDiagram; A->>B: call;
\`\`\`

## Components
- ComponentX — does X (src/x.ts).

## Data Models & Schema Changes
No database impact.

## Error Handling
Errors bubble to the caller.

## Alternatives Considered
- hypothesis-2: more moving parts.

## Risks & Mitigations
- watch the seam; mitigate with a contract test.

## Requirement Traceability
| AC | Component |
| - | - |
| 1 | ComponentX |

## Scores
| hypothesis | fit |
| - | - |
| 1 | 5 |
`;

function frameReady(slug) {
	const { p, state } = setup(slug);
	writeFileSync(p.frame, VALID_FRAME);
	writeFileSync(p.frameJudgement, "VERDICT: PASS\n");
	state.phase = "frame";
	state.pending = { kind: "frame-compile", seq: 0, label: "Phase 1 — FRAME", args: {} };
	state.todoist = { taskId: "t1", project: "P", sectionMode: "comment-only", attachedFrame: false, attachedArch: false };
	return { p, state };
}

function archReady(slug, uiShape) {
	const { p, state } = setup(slug);
	writeFileSync(p.architecture, VALID_ARCH);
	const report = join(p.archAttacks, "001-x.md");
	writeFileSync(report, "## Objection\nfine\n");
	writeFileSync(p.archDispositions, "ARCH-ATTACK: HOLDS\n\n## Attack dispositions\n- resolved\n");
	state.phase = "architect";
	state.pending = { kind: "arch-attack", seq: 0, label: "attack", args: {}, expects: [report, p.archDispositions] };
	state.ui = uiShape;
	state.todoist = { taskId: "t1", project: "P", sectionMode: "comment-only", attachedFrame: true, attachedArch: false };
	return { p, state };
}

test.beforeEach(() => {
	resetTodoist();
});

// --- Frame docs: attach exactly once at frame -> architect ------------------

test("frame -> architect attaches ledger and frame exactly once, guarded by attachedFrame", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const { p, state } = frameReady("frame-attach");

	const out = await nextStep(NO_UI, p, cfg, state);
	assert.equal(state.phase, "architect");
	assert.equal(state.todoist.attachedFrame, true);

	await getTodoist(cfg).flush();
	const ops = attachOps(records);
	assert.equal(ops.length, 2, "exactly one attach op per doc");
	assert.equal(ops[0].args[1], "TODOIST_CREATE_COMMENT_V1");
	const params1 = JSON.parse(ops[0].args[3]);
	assert.equal(params1.task_id, "t1");
	assert.equal(params1.attachment.file_url, p.ledger);
	assert.equal(ops[1].args[1], "TODOIST_CREATE_COMMENT_V1");
	const params2 = JSON.parse(ops[1].args[3]);
	assert.equal(params2.attachment.file_url, p.frame);

	// Idempotent re-entry: a second pass through the same transition (state
	// reset back to frame/frame-compile, as a resumed/duplicate call would see)
	// must not re-attach, because attachedFrame is now persisted true.
	state.phase = "frame";
	state.pending = { kind: "frame-compile", seq: 1, label: "Phase 1 — FRAME", args: {} };
	const out2 = await nextStep(NO_UI, p, cfg, state);
	assert.equal(state.phase, "architect");
	assert.match(out2, /Frame approved/);
	await getTodoist(cfg).flush();
	assert.equal(attachOps(records).length, 2, "no new attach ops on re-entry");
});

test("frame -> architect with no state.todoist attaches nothing", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const { p, state } = frameReady("frame-attach-no-todoist");
	state.todoist = undefined;

	const out = await nextStep(NO_UI, p, cfg, state);
	assert.equal(state.phase, "architect");
	assert.match(out, /Frame approved/);

	await getTodoist(cfg).flush();
	assert.equal(records.length, 0, "no attach when state.todoist is absent");
});

// --- Architecture doc: attach exactly once when the architect phase completes,
// on both exit paths (greenfield -> prototype, and -> plan) --------------------

test("architect -> prototype (greenfield exit) attaches 02-architecture.md even though the section does not change", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const { p, state } = archReady("arch-attach-greenfield", "greenfield");

	const out = await nextStep(NO_UI, p, cfg, state);
	assert.equal(state.phase, "prototype");
	assert.equal(state.todoist.attachedArch, true);
	assert.match(out, /Greenfield UI/);

	await getTodoist(cfg).flush();
	const ops = attachOps(records);
	assert.equal(ops.length, 1, "exactly one attach op, no move (section unchanged)");
	assert.equal(ops[0].args[1], "TODOIST_CREATE_COMMENT_V1");
	const params = JSON.parse(ops[0].args[3]);
	assert.equal(params.task_id, "t1");
	assert.equal(params.attachment.file_url, p.architecture);
});

test("architect -> plan (non-greenfield exit) attaches 02-architecture.md exactly once", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const { p, state } = archReady("arch-attach-plan", "existing");

	const out = await nextStep(NO_UI, p, cfg, state);
	assert.equal(state.phase, "plan");
	assert.equal(state.todoist.attachedArch, true);

	await getTodoist(cfg).flush();
	const ops = attachOps(records);
	assert.equal(ops.length, 1, "exactly one attach op");
	const params = JSON.parse(ops[0].args[3]);
	assert.equal(params.attachment.file_url, p.architecture);
});

test("architecture attach is guarded by attachedArch: a preset-true flag skips the attach", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const { p, state } = archReady("arch-attach-guard", "existing");
	state.todoist.attachedArch = true;

	const out = await nextStep(NO_UI, p, cfg, state);
	assert.equal(state.phase, "plan");
	assert.match(out, /Architecture approved/);

	await getTodoist(cfg).flush();
	assert.equal(attachOps(records).length, 0, "no attach when attachedArch already true");
});

test("architect exit with no state.todoist attaches nothing", async () => {
	const records = [];
	getTodoist(cfg, fakeExec(records));
	const { p, state } = archReady("arch-attach-no-todoist", "existing");
	state.todoist = undefined;

	const out = await nextStep(NO_UI, p, cfg, state);
	assert.equal(state.phase, "plan");
	assert.match(out, /Architecture approved/);

	await getTodoist(cfg).flush();
	assert.equal(records.length, 0, "no attach when state.todoist is absent");
});

// --- Fail-soft: a throwing transport does not block either transition -------

test("a throwing transport does not block the frame->architect transition", async () => {
	getTodoist(cfg, async () => {
		throw new Error("spawn failed");
	});
	const { p, state } = frameReady("frame-attach-throws");

	let out;
	await assert.doesNotReject(async () => {
		out = await nextStep(NO_UI, p, cfg, state);
	});
	assert.equal(state.phase, "architect");
	assert.equal(state.todoist.attachedFrame, true);
	assert.match(out, /Frame approved/);
});

test("a throwing transport does not block the architect->prototype transition", async () => {
	getTodoist(cfg, async () => {
		throw new Error("spawn failed");
	});
	const { p, state } = archReady("arch-attach-throws", "greenfield");

	let out;
	await assert.doesNotReject(async () => {
		out = await nextStep(NO_UI, p, cfg, state);
	});
	assert.equal(state.phase, "prototype");
	assert.equal(state.todoist.attachedArch, true);
	assert.match(out, /Greenfield UI/);
});
