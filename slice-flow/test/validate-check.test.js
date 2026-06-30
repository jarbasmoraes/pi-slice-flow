import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { validateCheck } from "../extensions/lib/checks.ts";

/** A throwaway tree seeded with files (relative path → contents). */
function tree(files) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-val-"));
	for (const [rel, body] of Object.entries(files)) {
		const abs = join(cwd, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, body);
	}
	return cwd;
}

const tenantCheck = {
	id: "tenant-predicate",
	axis: "multi-tenancy",
	scanner: "tenant-predicate",
	params: { labels: ["Project"], glob: "**/*.ts" },
};

test("a real check is admitted: RED on the planted violation, GREEN on the clean tree", async () => {
	const fixture = tree({ "src/leak.ts": "const q = `MATCH (p:Project) RETURN p`;\n" });
	const clean = tree({ "src/ok.ts": "const q = `MATCH (p:Project) WHERE p.externalUserId = $u RETURN p`;\n" });
	const v = await validateCheck(tenantCheck, fixture, clean);
	assert.equal(v.admitted, true, v.detail);
	assert.equal(v.redOnFixture, true);
	assert.equal(v.greenOnClean, true);
});

test("a check that does NOT fire on the planted violation is rejected (useless)", async () => {
	// The fixture's query already carries a predicate, so the check finds nothing —
	// a planted violation it fails to catch. Must be rejected, not admitted.
	const fixture = tree({ "src/x.ts": "const q = `MATCH (p:Project) WHERE p.externalUserId = $u RETURN p`;\n" });
	const clean = tree({ "src/ok.ts": "const x = 1;\n" });
	const v = await validateCheck(tenantCheck, fixture, clean);
	assert.equal(v.admitted, false);
	assert.equal(v.redOnFixture, false);
	assert.match(v.detail, /did NOT fire on the planted violation/);
});

test("a check that fires on the clean tree is rejected (noise)", async () => {
	const fixture = tree({ "src/leak.ts": "const q = `MATCH (p:Project) RETURN p`;\n" });
	// The "clean" tree actually contains a violation, so the check is too eager.
	const clean = tree({ "src/notclean.ts": "const q = `MATCH (p:Project) RETURN p`;\n" });
	const v = await validateCheck(tenantCheck, fixture, clean);
	assert.equal(v.admitted, false);
	assert.equal(v.greenOnClean, false);
	assert.match(v.detail, /fired on the clean tree/);
});

test("a check forced runnable cannot pass by silently skipping (pending ignored)", async () => {
	const fixture = tree({ "src/leak.ts": "const q = `MATCH (p:Project) RETURN p`;\n" });
	const clean = tree({ "src/ok.ts": "const x = 1;\n" });
	// Even marked pending, validateCheck forces it runnable so admission is real.
	const v = await validateCheck({ ...tenantCheck, pending: true }, fixture, clean);
	assert.equal(v.admitted, true, v.detail);
});
