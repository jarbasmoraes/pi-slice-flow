import { test } from "node:test";
import assert from "node:assert/strict";

import { scanTenantPredicate, scanBannedTokens } from "../extensions/lib/scanners.ts";

// --- tenant-predicate scanner -------------------------------------------------

const NEWRON_LABELS = ["Project", "Task", "ChatSession", "Meeting", "Person"];

test("a tenant-scoped MATCH without a predicate is a finding (the P0 shape)", () => {
	const files = [
		{
			path: "apps/api/src/projects.repository.ts",
			// MATCH on :Project with no externalUserId/ownerId/userId predicate — the
			// exact cross-tenant leak shape newron shipped and later gated.
			text: "const q = `MATCH (p:Project) WHERE p.id = $id RETURN p`;\n",
		},
	];
	const findings = scanTenantPredicate(files, { labels: NEWRON_LABELS });
	assert.equal(findings.length, 1, JSON.stringify(findings));
	assert.match(findings[0].message, /:Project without a tenant predicate/);
	assert.equal(findings[0].line, 1);
});

test("the same MATCH WITH a tenant predicate in the literal is clean", () => {
	const files = [
		{
			path: "ok.ts",
			text: "const q = `MATCH (p:Project) WHERE p.externalUserId = $uid AND p.id = $id RETURN p`;\n",
		},
	];
	assert.deepEqual(scanTenantPredicate(files, { labels: NEWRON_LABELS }), []);
});

test("an inline { externalUserId: $uid } predicate counts", () => {
	const files = [{ path: "ok.ts", text: "tx.run(`MATCH (t:Task { externalUserId: $uid }) RETURN t`)" }];
	assert.deepEqual(scanTenantPredicate(files, { labels: NEWRON_LABELS }), []);
});

test("a `// @tenant-safe: <reason>` annotation above the literal opts out", () => {
	const files = [
		{
			path: "safe.ts",
			text: "// @tenant-safe: keyed on globally-unique composio id\nconst q = `MATCH (c:Project) RETURN c`;\n",
		},
	];
	assert.deepEqual(scanTenantPredicate(files, { labels: NEWRON_LABELS }), []);
});

test("an empty @tenant-safe reason does NOT opt out", () => {
	const files = [{ path: "x.ts", text: "// @tenant-safe:\nconst q = `MATCH (c:Project) RETURN c`;\n" }];
	assert.equal(scanTenantPredicate(files, { labels: NEWRON_LABELS }).length, 1);
});

test("a search procedure call without a predicate is a finding", () => {
	const files = [
		{
			path: "search.ts",
			text: "const q = `CALL db.index.vector.queryNodes('chunk_embedding', 10, $vec) YIELD node RETURN node`;\n",
		},
	];
	const findings = scanTenantPredicate(files, { labels: NEWRON_LABELS });
	assert.equal(findings.length, 1, JSON.stringify(findings));
	assert.match(findings[0].message, /search procedure db\.index\.vector\.queryNodes/);
});

test("a backtick span inside a // comment is not parsed as a query", () => {
	const files = [{ path: "c.ts", text: "// example: `MATCH (p:Project) RETURN p`\nconst x = 1;\n" }];
	assert.deepEqual(scanTenantPredicate(files, { labels: NEWRON_LABELS }), []);
});

test("no labels configured disables the scanner entirely", () => {
	const files = [{ path: "x.ts", text: "`MATCH (p:Project) RETURN p`" }];
	assert.deepEqual(scanTenantPredicate(files, { labels: [] }), []);
});

test("a non-tenant label (e.g. :User) is not flagged", () => {
	const files = [{ path: "u.ts", text: "`MATCH (u:User) RETURN u`" }];
	assert.deepEqual(scanTenantPredicate(files, { labels: NEWRON_LABELS }), []);
});

test("custom predicateFields are honored", () => {
	const files = [{ path: "x.ts", text: "`MATCH (p:Project) WHERE p.tenantId = $t RETURN p`" }];
	assert.deepEqual(scanTenantPredicate(files, { labels: ["Project"], predicateFields: ["tenantId"] }), []);
});

// --- banned-tokens scanner ----------------------------------------------------

const XSS_TOKENS = ["dangerouslySetInnerHTML", "rehype-raw", "skipHtml"];

test("a banned token in a guarded file is a finding", () => {
	const files = [{ path: "src/markdown.tsx", text: "<div dangerouslySetInnerHTML={{ __html: x }} />" }];
	const findings = scanBannedTokens(files, { tokens: XSS_TOKENS, guardedSuffixes: ["markdown.tsx"] });
	assert.equal(findings.length, 1);
	assert.match(findings[0].message, /dangerouslySetInnerHTML/);
});

test("a banned token only inside a comment is NOT a finding", () => {
	const files = [{ path: "src/markdown.tsx", text: "// never use dangerouslySetInnerHTML here\nconst x = 1;" }];
	assert.deepEqual(scanBannedTokens(files, { tokens: XSS_TOKENS, guardedSuffixes: ["markdown.tsx"] }), []);
});

test("a file outside the guarded suffixes is ignored", () => {
	const files = [{ path: "src/other.ts", text: "const x = `dangerouslySetInnerHTML`;" }];
	assert.deepEqual(scanBannedTokens(files, { tokens: XSS_TOKENS, guardedSuffixes: ["markdown.tsx"] }), []);
});

test("empty guardedSuffixes scans every file", () => {
	const files = [{ path: "anywhere.ts", text: "skipHtml" }];
	assert.equal(scanBannedTokens(files, { tokens: XSS_TOKENS }).length, 1);
});

test("no tokens configured disables the scanner", () => {
	const files = [{ path: "x.tsx", text: "dangerouslySetInnerHTML" }];
	assert.deepEqual(scanBannedTokens(files, { tokens: [] }), []);
});
