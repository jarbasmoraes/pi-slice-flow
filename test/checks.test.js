import { test } from "node:test";
import assert from "node:assert/strict";

import { runChecks, renderCheckReport, TIER_A_ORACLES } from "../extensions/lib/checks.ts";

/**
 * A fake Exec: `which <tool>` returns 0 only for tools in `onPath`; running a
 * tool returns its entry from `results` (a result object, or a function that may
 * throw). Lets us drive every oracle outcome without a real subprocess.
 */
function fakeExec({ onPath = [], results = {} } = {}) {
	const present = new Set(onPath);
	const calls = [];
	const exec = async (cmd, args) => {
		calls.push({ cmd, args });
		if (cmd === "which") return { code: present.has(args[0]) ? 0 : 1, stdout: "", stderr: "" };
		const r = results[cmd];
		if (typeof r === "function") return r();
		return r ?? { code: 0, stdout: "", stderr: "" };
	};
	exec.calls = calls;
	return exec;
}

const ALL = ["secrets", "sast", "deps"];
const ALL_TOOLS = ALL.map((id) => TIER_A_ORACLES[id].tool); // gitleaks, semgrep, osv-scanner

test("clean tree: every oracle present and exits 0 → PASS, no findings", async () => {
	const exec = fakeExec({ onPath: ALL_TOOLS });
	const r = await runChecks(exec, "/repo", ALL);
	assert.equal(r.ok, true, r.findings.join("; "));
	assert.deepEqual(r.findings, []);
	assert.deepEqual(r.skipped, []);
});

test("a non-zero oracle exit is a finding → FAIL", async () => {
	const exec = fakeExec({ onPath: ALL_TOOLS, results: { gitleaks: { code: 1, stdout: "", stderr: "" } } });
	const r = await runChecks(exec, "/repo", ALL);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /gitleaks/);
});

test("a tool missing from PATH is a graceful skip, not a failure", async () => {
	// semgrep absent; the other two present and clean.
	const exec = fakeExec({ onPath: ["gitleaks", "osv-scanner"] });
	const r = await runChecks(exec, "/repo", ALL);
	assert.equal(r.ok, true, "a missing tool must never fail the gate");
	assert.equal(r.findings.length, 0);
	assert.match(r.skipped.join(" "), /sast \(semgrep not installed\)/);
});

test("unknown oracle id is skipped, never run", async () => {
	const exec = fakeExec({ onPath: ALL_TOOLS });
	const r = await runChecks(exec, "/repo", ["secrets", "bogus"]);
	assert.equal(r.ok, true);
	assert.match(r.skipped.join(" "), /bogus/);
	// 'bogus' must not have triggered a `which` probe or a run.
	assert.ok(!exec.calls.some((c) => c.args?.includes("bogus")));
});

test("an oracle that throws while running IS a finding (cannot-run hides risk)", async () => {
	const exec = fakeExec({
		onPath: ALL_TOOLS,
		results: {
			semgrep: () => {
				throw new Error("semgrep crashed");
			},
		},
	});
	const r = await runChecks(exec, "/repo", ["sast"]);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /failed to run.*semgrep crashed/);
});

test("oracles run against the given cwd", async () => {
	const exec = fakeExec({ onPath: ALL_TOOLS });
	await runChecks(exec, "/audited/tree", ["secrets"]);
	const run = exec.calls.find((c) => c.cmd === "gitleaks");
	assert.ok(run.args.includes("/audited/tree"), "the audited tree path must be passed to the oracle");
});

test("renderCheckReport carries a parseable VERDICT marker", () => {
	const pass = renderCheckReport({ ok: true, findings: [], skipped: [] });
	assert.match(pass, /VERDICT:\s*PASS/);
	const fail = renderCheckReport({ ok: false, findings: ["x: bad"], skipped: ["deps (osv-scanner not installed)"] });
	assert.match(fail, /VERDICT:\s*FAIL/);
	assert.match(fail, /- x: bad/);
	assert.match(fail, /Skipped/);
});
