import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { provisionCheckPack } from "../extensions/lib/engine.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { loadManifest, manifestPath } from "../extensions/lib/detect-stack.ts";

/** A throwaway repo with a package.json naming the given deps. */
function repo(deps) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-prov-"));
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: deps }));
	return cwd;
}

/** Fake gate ctx: `choice` is what ui.select resolves to (undefined = dismissed). */
function fakeCtx(choice) {
	const calls = { select: 0 };
	return {
		ctx: { hasUI: true, ui: { notify: () => {}, select: async () => { calls.select++; return choice; } } },
		calls,
	};
}

const NEO4J_CLERK = { "neo4j-driver": "^5", "@clerk/nextjs": "^5" };

test("an approved profile writes a confirmed manifest and returns the profile line", async () => {
	const cwd = repo(NEO4J_CLERK);
	const { ctx } = fakeCtx("Enable check-pack");
	const line = await provisionCheckPack(ctx, DEFAULT_CONFIG, cwd, "2026-06-29T00:00:00Z");
	assert.match(line, /live axes/);
	assert.doesNotMatch(line, /unconfirmed/);
	const m = loadManifest(cwd);
	assert.equal(m.confirmed, true);
	assert.equal(m.detectedAt, "2026-06-29T00:00:00Z");
	assert.ok(m.checks.some((c) => c.id === "tenant-predicate"));
});

test("a declined profile persists unconfirmed and quarantines the checks", async () => {
	const cwd = repo(NEO4J_CLERK);
	const { ctx } = fakeCtx("Not now");
	const line = await provisionCheckPack(ctx, DEFAULT_CONFIG, cwd, "2026-06-29T00:00:00Z");
	assert.match(line, /unconfirmed/);
	assert.equal(loadManifest(cwd).confirmed, false);
});

test("autoApprove cannot silently confirm a security profile", async () => {
	const cwd = repo(NEO4J_CLERK);
	// hasUI=false + autoApprove=true would rubber-stamp a normal clean gate; the
	// check-pack confirm must still NOT enable without an explicit human yes,
	// because detection can be wrong. Headless enforcement is opt-in via a
	// committed manifest with "confirmed": true.
	const ctx = { hasUI: false, ui: { notify: () => {}, select: async () => undefined } };
	const cfg = { ...DEFAULT_CONFIG, autoApprove: true };
	const line = await provisionCheckPack(ctx, cfg, cwd, "t");
	assert.match(line, /unconfirmed/);
	assert.equal(loadManifest(cwd).confirmed, false);
});

test("a repo with no risk-bearing stack writes no manifest and stays silent", async () => {
	const cwd = repo({ lodash: "^4" });
	const { ctx, calls } = fakeCtx("Enable check-pack");
	const line = await provisionCheckPack(ctx, DEFAULT_CONFIG, cwd, "t");
	assert.equal(line, "");
	assert.equal(calls.select, 0, "no gate shown when nothing risk-bearing is detected");
	assert.ok(!existsSync(manifestPath(cwd)), "no manifest litters a plain repo");
});

test("checks disabled is a no-op", async () => {
	const cwd = repo(NEO4J_CLERK);
	const { ctx, calls } = fakeCtx("Enable check-pack");
	const line = await provisionCheckPack(ctx, { ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks, enabled: false } }, cwd, "t");
	assert.equal(line, "");
	assert.equal(calls.select, 0);
});

test("a prior confirmation is honored without re-prompting, and filled labels survive", async () => {
	const cwd = repo(NEO4J_CLERK);
	// First run: approve.
	await provisionCheckPack(fakeCtx("Enable check-pack").ctx, DEFAULT_CONFIG, cwd, "t1");
	// Human fills tenant labels and the check stops being pending.
	const m = loadManifest(cwd);
	const tenant = m.checks.find((c) => c.id === "tenant-predicate");
	tenant.params.labels = ["Project", "Task"];
	tenant.pending = false;
	writeFileSync(manifestPath(cwd), JSON.stringify(m, null, 2));
	// Second run: should NOT re-prompt, and must preserve the typed labels.
	const { ctx, calls } = fakeCtx("Not now");
	await provisionCheckPack(ctx, DEFAULT_CONFIG, cwd, "t2");
	assert.equal(calls.select, 0, "an already-confirmed profile is not re-asked");
	const after = loadManifest(cwd);
	assert.equal(after.confirmed, true);
	assert.deepEqual(after.checks.find((c) => c.id === "tenant-predicate").params.labels, ["Project", "Task"]);
	assert.equal(after.checks.find((c) => c.id === "tenant-predicate").pending, false, "filled check is no longer pending");
	assert.equal(JSON.parse(readFileSync(manifestPath(cwd), "utf8")).detectedAt, "t2", "re-detection refreshes the timestamp");
});
