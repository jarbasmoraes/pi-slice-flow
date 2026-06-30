import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { runStackChecks, mergeResults } from "../extensions/lib/checks.ts";

/** A throwaway repo seeded with files (relative path → contents). */
function repo(files) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-rsc-"));
	for (const [rel, body] of Object.entries(files)) {
		const abs = join(cwd, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, body);
	}
	return cwd;
}

const tenantCheck = (labels) => ({
	id: "tenant-predicate",
	axis: "multi-tenancy",
	scanner: "tenant-predicate",
	params: { labels, glob: "**/*.ts" },
});

test("a configured tenant-predicate check finds a real violation on disk", async () => {
	const cwd = repo({ "src/projects.repository.ts": "const q = `MATCH (p:Project) WHERE p.id = $id RETURN p`;\n" });
	const r = await runStackChecks(cwd, [tenantCheck(["Project"])]);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /tenant-predicate: src\/projects\.repository\.ts:1 — MATCH on :Project/);
});

test("a clean tree passes", async () => {
	const cwd = repo({ "src/ok.ts": "const q = `MATCH (p:Project) WHERE p.externalUserId = $u RETURN p`;\n" });
	const r = await runStackChecks(cwd, [tenantCheck(["Project"])]);
	assert.equal(r.ok, true, r.findings.join("; "));
	assert.deepEqual(r.findings, []);
});

test("a pending check is skipped with a configuration nudge, never run", async () => {
	const cwd = repo({ "src/x.ts": "`MATCH (p:Project) RETURN p`" });
	const r = await runStackChecks(cwd, [{ ...tenantCheck([]), pending: true }]);
	assert.equal(r.ok, true, "pending must not fail the gate");
	assert.equal(r.findings.length, 0);
	assert.match(r.skipped.join(" "), /tenant-predicate \(needs configuration/);
});

test("node_modules and build output are not scanned", async () => {
	const cwd = repo({
		"node_modules/dep/index.ts": "`MATCH (p:Project) RETURN p`",
		"dist/bundle.ts": "`MATCH (p:Project) RETURN p`",
		"src/ok.ts": "const x = 1;\n",
	});
	const r = await runStackChecks(cwd, [tenantCheck(["Project"])]);
	assert.equal(r.ok, true, r.findings.join("; "));
});

test("the banned-tokens scanner runs against its own glob", async () => {
	const cwd = repo({ "src/markdown.tsx": "<div dangerouslySetInnerHTML={{ __html: x }} />" });
	const check = { id: "banned-tokens", axis: "xss", scanner: "banned-tokens", params: { tokens: ["dangerouslySetInnerHTML"], guardedSuffixes: [".tsx"], glob: "**/*.tsx" } };
	const r = await runStackChecks(cwd, [check]);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /banned-tokens: src\/markdown\.tsx.*dangerouslySetInnerHTML/);
});

test("mergeResults ANDs ok and concatenates findings/skips", () => {
	const a = { ok: true, findings: [], skipped: ["deps (osv-scanner not installed)"] };
	const b = { ok: false, findings: ["tenant-predicate: x.ts:1 — bad"], skipped: [] };
	const merged = mergeResults(a, b);
	assert.equal(merged.ok, false);
	assert.deepEqual(merged.findings, ["tenant-predicate: x.ts:1 — bad"]);
	assert.deepEqual(merged.skipped, ["deps (osv-scanner not installed)"]);
});

test("mergeResults of all-clean results is clean", () => {
	const merged = mergeResults({ ok: true, findings: [], skipped: [] }, { ok: true, findings: [], skipped: [] });
	assert.equal(merged.ok, true);
});
