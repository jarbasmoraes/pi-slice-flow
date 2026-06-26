import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { nextStep } from "../extensions/lib/engine.ts";
import { prototypeRejectsAll, createState, ensureWorkTree, workPaths } from "../extensions/lib/workspace.ts";

const NO_UI = { hasUI: false, mode: "json", ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {} } };

function protoReady(slug, judgementFirstLine) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-proto-"));
	const p = workPaths(cwd, ".pi/task", slug);
	ensureWorkTree(p);
	mkdirSync(p.prototypes, { recursive: true });
	mkdirSync(join(p.prototypes, "proto-1"), { recursive: true });
	writeFileSync(join(p.prototypes, "proto-1", "README.md"), "# p1", "utf8");
	writeFileSync(join(p.prototypes, "JUDGEMENT.md"), `${judgementFirstLine}\n\nbody...\n`, "utf8");
	const state = createState("feat", slug, "base");
	state.phase = "prototype";
	state.ui = "greenfield";
	state.pending = { kind: "prototype-judge", seq: 1, label: "Judge prototypes", args: {} };
	return { p, state };
}

test("prototypeRejectsAll detects the NONE-ACCEPTABLE marker only on the first line", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-pr-"));
	const f = join(cwd, "j.md");
	writeFileSync(f, "WINNER: NONE-ACCEPTABLE\nall too weak", "utf8");
	assert.equal(prototypeRejectsAll(f), true);
	writeFileSync(f, "WINNER: proto-2\n...maybe none-acceptable in prose...", "utf8");
	assert.equal(prototypeRejectsAll(f), false);
});

test("#10 NONE-ACCEPTABLE triggers a bounded regenerate (not an auto-adopted winner)", async () => {
	const { p, state } = protoReady("reject", "WINNER: NONE-ACCEPTABLE");
	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	assert.equal(state.pending.kind, "prototype", "regenerates the prototype fan-out, not a judge-only re-run");
	assert.equal(state.prototypeRetries, 1);
	assert.equal(existsSync(join(p.prototypes, "JUDGEMENT.md")), false, "stale judgement cleared");
	assert.equal(existsSync(join(p.prototypes, "proto-1")), false, "stale prototypes cleared");
	assert.match(out, /none acceptable|Regenerating/i);
});

test("#10 a NONE-ACCEPTABLE that exhausts the budget surfaces to the human gate", async () => {
	const { p, state } = protoReady("reject2", "WINNER: NONE-ACCEPTABLE");
	state.prototypeRetries = DEFAULT_CONFIG.maxPrototypeRetries; // budget already spent
	const out = await nextStep(NO_UI, p, DEFAULT_CONFIG, state);
	// No more regenerates; with no UI the gate pauses for the human.
	assert.notEqual(state.pending?.kind, "prototype");
	assert.match(out, /PAUSED|approve/i);
});
