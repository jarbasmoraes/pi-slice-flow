import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintMemo } from "../extensions/lib/workspace.ts";

const GOOD_MEMO = (commit = "a1b2c3d") => `# Memo: 001 — title

## What exists now
- the feature works

## Changed files
- src/x.ts — added the thing

## Commit
${commit}

## Tests
- x.test.ts — proves the thing

## Deviations
- none

## Notes for later slices
- none
`;

function write(body) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-lint-memo-"));
	const file = join(cwd, "memo.md");
	writeFileSync(file, body);
	return file;
}

test("a well-formed memo with a commit hash passes when auto_commit is on", () => {
	const r = lintMemo(write(GOOD_MEMO()), true);
	assert.equal(r.ok, true, r.findings.join("; "));
});

test("missing commit hash fails only when auto_commit is on", () => {
	const noHash = GOOD_MEMO("not committed (auto_commit off)");
	assert.equal(lintMemo(write(noHash), true).ok, false);
	assert.equal(lintMemo(write(noHash), false).ok, true);
});

test("missing required section is caught", () => {
	const missing = GOOD_MEMO().replace("## Tests\n- x.test.ts — proves the thing\n\n", "");
	const r = lintMemo(write(missing), true);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /missing required section "## Tests"/);
});

test("empty changed-files list is caught", () => {
	const empty = GOOD_MEMO().replace("- src/x.ts — added the thing", "");
	const r = lintMemo(write(empty), true);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /"## Changed files" has no entries/);
});

test("a missing memo file fails", () => {
	const r = lintMemo(join(tmpdir(), "does-not-exist-memo.md"), true);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /missing or empty/);
});
