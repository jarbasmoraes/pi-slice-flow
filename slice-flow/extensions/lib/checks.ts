/**
 * The deterministic check-pack: external-oracle gates that run with NO model in
 * the loop. Tests, SAST, secret/dependency scanners sit *outside* the model's
 * correlated error space, so they catch blind spots a same-family judge panel
 * structurally shares. This module is the Tier-A layer — universal oracles that
 * work on any repo with zero configuration.
 *
 * Each oracle is gated by a tool-on-PATH probe (mirroring codegraph's `which`
 * check): a missing binary is a graceful SKIP with a nudge, never a failure, so
 * turning the feature on never breaks a run on a machine that lacks the tool.
 * Orchestration is pure over an injected `Exec`, so it stays testable without a
 * real subprocess.
 */

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";

import type { Exec } from "./worktree.ts";
import type { StackCheck } from "./detect-stack.ts";
import { type ScanFinding, type SourceFile, scanBannedTokens, scanTenantPredicate } from "./scanners.ts";

/** The shipped universal oracles. Tier-B (stack-templated) and Tier-C
 * (generated) checks are added in later phases against the same result shape. */
export type OracleId = "secrets" | "sast" | "deps";

/** One captured command result, the shape `Exec` returns. */
type ExecResult = { code: number; stdout: string; stderr: string };

/** How to run one oracle and read its result. `tool` is probed on PATH before
 * `build` is ever called; `interpret` turns the raw result into human findings
 * (empty array == clean). Kept declarative so a new oracle is one entry, and so
 * the runner never has to know a specific tool's flags. */
export interface OracleSpec {
	id: OracleId;
	/** Binary that must be on PATH for this oracle to run. */
	tool: string;
	/** Build the argv (the command is `tool`). `cwd` is the tree under audit. */
	build(cwd: string): string[];
	/** Map exit code + output to findings. Most scanners exit non-zero on a hit. */
	interpret(res: ExecResult): string[];
}

/** FrameLint-compatible ({ ok, findings }) so engine handlers consume a check
 * result exactly like `lintSlices`. `skipped` additionally records oracles whose
 * tool was absent — surfaced as a nudge, never folded into `ok`. */
export interface CheckResult {
	ok: boolean;
	findings: string[];
	skipped: string[];
}

/** The Tier-A oracle catalog. Each entry is deterministic: run a real scanner,
 * read its exit code. No model, no heuristic prompt. */
export const TIER_A_ORACLES: Record<OracleId, OracleSpec> = {
	// gitleaks exits non-zero when it finds secrets (`--exit-code 1` makes that
	// explicit and stable across versions). `--redact` keeps secret material out
	// of our logs and the provenance file.
	secrets: {
		id: "secrets",
		tool: "gitleaks",
		build: (cwd) => ["detect", "--no-banner", "--redact", "--exit-code", "1", "--source", cwd],
		interpret: (res) => (res.code === 0 ? [] : ["gitleaks: potential secret(s) detected — run `gitleaks detect` for the redacted report"]),
	},
	// semgrep with the curated OWASP ruleset; `--error` makes a finding a non-zero
	// exit, `--quiet` trims progress noise so stdout is just the result.
	sast: {
		id: "sast",
		tool: "semgrep",
		build: (cwd) => ["--config", "p/owasp-top-ten", "--error", "--quiet", cwd],
		interpret: (res) => (res.code === 0 ? [] : ["semgrep: OWASP SAST finding(s) detected — run `semgrep --config p/owasp-top-ten` for details"]),
	},
	// osv-scanner exits non-zero when a dependency matches a known advisory.
	deps: {
		id: "deps",
		tool: "osv-scanner",
		build: (cwd) => ["--recursive", cwd],
		interpret: (res) => (res.code === 0 ? [] : ["osv-scanner: vulnerable dependency(ies) detected — run `osv-scanner --recursive .` for the advisory list"]),
	},
};

/** Is `tool` on PATH? Mirrors codegraph's probe: only the exit code is consulted,
 * and any thrown error is treated as "absent" so a hostile environment degrades
 * to a skip rather than crashing the verify gate. */
async function toolOnPath(exec: Exec, tool: string): Promise<boolean> {
	try {
		const res = await exec("which", [tool], { timeout: 5000 });
		return res.code === 0;
	} catch {
		return false;
	}
}

/** Run the requested Tier-A oracles against `cwd` and fold them into one result.
 * Unknown ids and oracles whose tool is missing are skipped (not failed); an
 * oracle that throws while running IS a finding (a check that cannot run is not
 * the same as a check that is absent — the former hides risk). */
export async function runChecks(exec: Exec, cwd: string, oracleIds: string[]): Promise<CheckResult> {
	const findings: string[] = [];
	const skipped: string[] = [];
	for (const id of oracleIds) {
		const spec = TIER_A_ORACLES[id as OracleId];
		if (!spec) {
			skipped.push(id);
			continue;
		}
		if (!(await toolOnPath(exec, spec.tool))) {
			skipped.push(`${spec.id} (${spec.tool} not installed)`);
			continue;
		}
		try {
			const res = await exec(spec.tool, spec.build(cwd), { timeout: 120000, cwd });
			findings.push(...spec.interpret(res));
		} catch (err) {
			findings.push(`${spec.id}: oracle '${spec.tool}' failed to run (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	return { ok: findings.length === 0, findings, skipped };
}

/** Collect repo-relative source files matching `pattern` under `cwd`, skipping
 * the usual noise dirs so a scanner never wades through node_modules or build
 * output. Unreadable files are silently dropped (a scanner reasons over what it
 * can read; a vanished file is not a finding). */
async function collectFiles(cwd: string, pattern: string): Promise<SourceFile[]> {
	const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.slice-flow|\.pi)(\/|$)/;
	const files: SourceFile[] = [];
	// node's glob yields paths relative to `cwd`; normalize to forward slashes so
	// the SKIP filter and findings are stable across platforms.
	for await (const match of glob(pattern, { cwd })) {
		const rel = match.split("\\").join("/");
		if (SKIP.test(rel)) continue;
		try {
			files.push({ path: rel, text: readFileSync(join(cwd, rel), "utf8") });
		} catch {
			/* unreadable — skip */
		}
	}
	return files;
}

/** Dispatch one stack check to its scanner. Centralizing the scanner→params
 * mapping here keeps the scanners themselves pure and param-typed, and makes
 * "add a scanner" a single-case change. */
function dispatchScanner(check: StackCheck, files: SourceFile[]): ScanFinding[] {
	switch (check.scanner) {
		case "tenant-predicate":
			return scanTenantPredicate(files, {
				labels: (check.params.labels as string[]) ?? [],
				predicateFields: check.params.predicateFields as string[] | undefined,
				safeAnnotation: check.params.safeAnnotation as string | undefined,
			});
		case "banned-tokens":
			return scanBannedTokens(files, {
				tokens: (check.params.tokens as string[]) ?? [],
				guardedSuffixes: check.params.guardedSuffixes as string[] | undefined,
			});
		default:
			return [];
	}
}

/** Run the selected Tier-B stack checks against `cwd`, folding their findings into
 * one FrameLint-shaped result. `pending` checks (unfilled holes — e.g. tenant
 * labels) are skipped with a nudge, never run, so a half-configured pack warns
 * rather than passing silently. A scanner that throws IS a finding (a check that
 * cannot run hides risk), mirroring the Tier-A oracle contract. */
export async function runStackChecks(cwd: string, checks: StackCheck[]): Promise<CheckResult> {
	const findings: string[] = [];
	const skipped: string[] = [];
	for (const check of checks) {
		if (check.pending) {
			skipped.push(`${check.id} (needs configuration — fill its params in .slice-flow/checks/manifest.json)`);
			continue;
		}
		try {
			const pattern = (check.params.glob as string) ?? "**/*.ts";
			const files = await collectFiles(cwd, pattern);
			for (const f of dispatchScanner(check, files)) findings.push(`${check.id}: ${f.path}:${f.line} — ${f.message}`);
		} catch (err) {
			findings.push(`${check.id}: scanner '${check.scanner}' failed to run (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	return { ok: findings.length === 0, findings, skipped };
}

/** The verdict of admitting a generated (Tier-C) or freshly-filled check. A check
 * is admitted ONLY if it goes RED on a planted-violation fixture AND GREEN on a
 * clean tree — the oracle-for-the-oracle. This is the structural guard against a
 * "check" that is theater: one that never fires (useless) or fires on clean code
 * (noise). A non-admitted check is quarantined as a warning, never an enforcer. */
export interface CheckValidation {
	admitted: boolean;
	redOnFixture: boolean;
	greenOnClean: boolean;
	detail: string;
}

/**
 * Validate a check against two trees: `fixtureCwd` must contain a planted
 * violation (the check must find ≥1), and `cleanCwd` must be free of it (the
 * check must find 0). Runs the check deterministically via the same scanner path
 * production uses — no model, no special-casing — so admission proves the check
 * actually discriminates. `pending` is forced off so a half-configured check
 * cannot "pass" by silently skipping.
 */
export async function validateCheck(check: StackCheck, fixtureCwd: string, cleanCwd: string): Promise<CheckValidation> {
	const runnable = { ...check, pending: false };
	const onFixture = await runStackChecks(fixtureCwd, [runnable]);
	const onClean = await runStackChecks(cleanCwd, [runnable]);
	const redOnFixture = onFixture.findings.length > 0;
	const greenOnClean = onClean.findings.length === 0;
	const admitted = redOnFixture && greenOnClean;
	const detail = admitted
		? `admitted: RED on fixture (${onFixture.findings.length} finding(s)), GREEN on clean tree`
		: `rejected: ${redOnFixture ? "" : "did NOT fire on the planted violation; "}${greenOnClean ? "" : `fired on the clean tree (${onClean.findings.join("; ")})`}`.trim();
	return { admitted, redOnFixture, greenOnClean, detail };
}

/** Combine several check results into one (findings and skips concatenate; `ok`
 * is the AND). Lets the engine run Tier-A oracles and Tier-B stack checks
 * independently and present a single check-pack verdict. */
export function mergeResults(...results: CheckResult[]): CheckResult {
	const findings = results.flatMap((r) => r.findings);
	const skipped = results.flatMap((r) => r.skipped);
	return { ok: findings.length === 0, findings, skipped };
}

/** Render a check result as the verify/check-pack.md provenance file, carrying a
 * `VERDICT: PASS|FAIL` marker so it reads like every other verify artifact. */
export function renderCheckReport(result: CheckResult): string {
	const lines = [
		"# Check-pack — deterministic oracles",
		"",
		`VERDICT: ${result.ok ? "PASS" : "FAIL"}`,
		"",
	];
	lines.push("## Findings", "");
	lines.push(result.findings.length ? result.findings.map((f) => `- ${f}`).join("\n") : "- none");
	if (result.skipped.length) {
		lines.push("", "## Skipped (tool not installed)", "");
		lines.push(result.skipped.map((s) => `- ${s}`).join("\n"));
	}
	return `${lines.join("\n")}\n`;
}
