import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifySignals, classifyAxes, selectChecks, detectStack, stackPreamble } from "../extensions/lib/detect-stack.ts";

/** A throwaway repo dir seeded with the given files (relative path → contents). */
function repo(files) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-stack-"));
	for (const [rel, body] of Object.entries(files)) writeFileSync(join(cwd, rel), body);
	return cwd;
}

function pkg(deps) {
	return JSON.stringify({ dependencies: deps });
}

// --- classifySignals (pure) ---------------------------------------------------

test("neo4j driver + clerk + bullmq classify into the right categories", () => {
	const s = classifySignals(new Set(["neo4j-driver", "@clerk/nextjs", "bullmq", "react-markdown"]));
	assert.deepEqual(s.db, ["neo4j"]);
	assert.deepEqual(s.auth, ["clerk"]);
	assert.deepEqual(s.queue, ["bullmq"]);
	assert.deepEqual(s.markdown, ["react-markdown"]);
});

test("a database in docker-compose is detected even without a client dep", () => {
	const s = classifySignals(new Set([]), "services:\n  neo4j:\n    image: neo4j:5\n");
	assert.deepEqual(s.db, ["neo4j"]);
});

// --- classifyAxes (pure) ------------------------------------------------------

test("secrets is always a live axis", () => {
	assert.ok(classifyAxes(classifySignals(new Set([]))).includes("secrets"));
});

test("db + auth makes multi-tenancy live; db alone does not", () => {
	const withAuth = classifyAxes(classifySignals(new Set(["neo4j-driver", "@clerk/nextjs"])));
	assert.ok(withAuth.includes("multi-tenancy"));
	const dbOnly = classifyAxes(classifySignals(new Set(["neo4j-driver"])));
	assert.ok(!dbOnly.includes("multi-tenancy"));
	assert.ok(dbOnly.includes("injection"), "db alone still implies injection");
});

test("payments implies money-idempotency; orm implies migration-lineage", () => {
	const axes = classifyAxes(classifySignals(new Set(["stripe", "@prisma/client"])));
	assert.ok(axes.includes("money-idempotency"));
	assert.ok(axes.includes("migration-lineage"));
});

// --- selectChecks (pure) ------------------------------------------------------

test("neo4j selects the tenant-predicate check, quarantined pending labels", () => {
	const checks = selectChecks(classifySignals(new Set(["neo4j-driver"])));
	const tenant = checks.find((c) => c.id === "tenant-predicate");
	assert.ok(tenant);
	assert.equal(tenant.pending, true, "must start quarantined: labels cannot be inferred");
	assert.deepEqual(tenant.params.labels, []);
});

test("a markdown renderer selects the banned-tokens check, ready to enforce", () => {
	const checks = selectChecks(classifySignals(new Set(["react-markdown"])));
	const banned = checks.find((c) => c.id === "banned-tokens");
	assert.ok(banned);
	assert.ok(!banned.pending, "banned-tokens ships ready (tokens are known)");
	assert.ok(banned.params.tokens.includes("dangerouslySetInnerHTML"));
});

test("a stack with neither graph DB nor markdown selects no Tier-B checks", () => {
	assert.deepEqual(selectChecks(classifySignals(new Set(["express", "pg"]))), []);
});

// --- detectStack (disk probe) -------------------------------------------------

test("detectStack reads root package.json deps", () => {
	const cwd = repo({ "package.json": pkg({ "neo4j-driver": "^5", "@clerk/nextjs": "^5" }) });
	const s = detectStack(cwd);
	assert.deepEqual(s.db, ["neo4j"]);
	assert.deepEqual(s.auth, ["clerk"]);
});

test("detectStack recovers a workspace dep named only in the lockfile", () => {
	// Thin root package.json, but the lockfile names the package (monorepo shape).
	const cwd = repo({
		"package.json": pkg({}),
		"pnpm-lock.yaml": "packages:\n  /react-markdown@9.0.0:\n    resolution: {}\n",
	});
	assert.deepEqual(detectStack(cwd).markdown, ["react-markdown"]);
});

test("detectStack on an empty repo yields all-empty signals", () => {
	const cwd = repo({});
	const s = detectStack(cwd);
	assert.deepEqual(s.db, []);
	assert.deepEqual(s.markdown, []);
});

// --- stackPreamble (pure) -----------------------------------------------------

test("stackPreamble stays silent when only the universal secrets axis is live", () => {
	assert.equal(stackPreamble(["secrets"], []), "");
});

test("stackPreamble names enforcing and pending checks distinctly", () => {
	const checks = selectChecks(classifySignals(new Set(["neo4j-driver", "@clerk/nextjs", "react-markdown"])));
	const line = stackPreamble(classifyAxes(classifySignals(new Set(["neo4j-driver", "@clerk/nextjs", "react-markdown"]))), checks);
	assert.match(line, /live axes/);
	assert.match(line, /Stack checks enabled: banned-tokens/);
	assert.match(line, /Pending configuration.*tenant-predicate/);
});
