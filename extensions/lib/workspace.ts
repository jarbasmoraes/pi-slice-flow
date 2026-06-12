/**
 * The workflow's domain model and its persistence: state, paths, and every
 * read/write of the ./feature-work/ tree. Nothing here knows about prompts,
 * subagent call shapes, or Pi APIs — it only answers "what is true on disk?".
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const VERIFY_DIMENSIONS = ["code-quality", "simplicity", "security", "evals", "tests"] as const;
export type VerifyDimension = (typeof VERIFY_DIMENSIONS)[number];

export type Phase = "frame" | "architect" | "prototype" | "plan" | "implement" | "verify" | "loop" | "done" | "stopped";

export interface Directive {
	kind: string; // frame | architect | prototype | plan | build | fixup | verify | loop-fix
	seq: number;
	label: string;
	args: Record<string, unknown>; // exact subagent tool input
}

export interface State {
	version: 1;
	feature: string;
	createdAt: string;
	updatedAt: string;
	baselineCommit: string | null;
	phase: Phase;
	pending: Directive | null;
	ui: "none" | "greenfield" | "existing" | null;
	slices: string[]; // slice file basenames, in order
	sliceIndex: number;
	fixupRound: number; // 0 = initial build; 1..maxFixupsPerSlice = fix-up rounds
	loopIteration: number;
	failedDimensions: VerifyDimension[];
	tokensSpent: number; // best-effort estimate across all subagent runs
	loopStartTokens: number;
	seq: number;
	log: Array<{ ts: string; event: string }>;
}

export interface Paths {
	root: string;
	state: string;
	logs: string;
	calls: string;
	chains: string;
	arch: string;
	slices: string;
	memos: string;
	reviews: string;
	verify: string;
	prototypes: string;
	frame: string;
	architecture: string;
	plan: string;
	report: string;
}

export function workPaths(cwd: string, workDir: string): Paths {
	const root = resolve(cwd, workDir);
	return {
		root,
		state: join(root, "state.json"),
		logs: join(root, "logs"),
		calls: join(root, "logs", "calls"),
		chains: join(root, "chains"),
		arch: join(root, "arch"),
		slices: join(root, "slices"),
		memos: join(root, "memos"),
		reviews: join(root, "reviews"),
		verify: join(root, "verify"),
		prototypes: join(root, "prototypes"),
		frame: join(root, "01-frame.md"),
		architecture: join(root, "02-architecture.md"),
		plan: join(root, "03-plan.md"),
		report: join(root, "REPORT.md"),
	};
}

export function ensureWorkTree(p: Paths): void {
	for (const dir of [p.root, p.logs, p.calls, p.chains, p.arch, p.slices, p.memos, p.reviews, p.verify, p.prototypes]) {
		mkdirSync(dir, { recursive: true });
	}
}

export function createState(feature: string, baselineCommit: string | null): State {
	const now = new Date().toISOString();
	return {
		version: 1,
		feature,
		createdAt: now,
		updatedAt: now,
		baselineCommit,
		phase: "frame",
		pending: null,
		ui: null,
		slices: [],
		sliceIndex: 0,
		fixupRound: 0,
		loopIteration: 0,
		failedDimensions: [],
		tokensSpent: 0,
		loopStartTokens: 0,
		seq: 0,
		log: [],
	};
}

export function loadState(p: Paths): State | null {
	if (!existsSync(p.state)) return null;
	return JSON.parse(readFileSync(p.state, "utf8")) as State;
}

export function saveState(p: Paths, state: State): void {
	state.updatedAt = new Date().toISOString();
	writeFileSync(p.state, JSON.stringify(state, null, 2), "utf8");
}

export function logEvent(state: State, event: string): void {
	state.log.push({ ts: new Date().toISOString(), event });
}

export function isActive(state: State | null): state is State {
	return state !== null && state.phase !== "done" && state.phase !== "stopped";
}

// --- Small disk predicates shared across the workflow -----------------------

export function nonEmpty(file: string): boolean {
	try {
		return existsSync(file) && readFileSync(file, "utf8").trim().length > 0;
	} catch {
		return false;
	}
}

/** First `VERDICT: PASS|FAIL` found in a file; null when absent/missing. */
export function verdictOf(file: string): "PASS" | "FAIL" | null {
	if (!existsSync(file)) return null;
	const match = readFileSync(file, "utf8").match(/VERDICT:\s*(PASS|FAIL)/i);
	return match ? (match[1].toUpperCase() as "PASS" | "FAIL") : null;
}

export function readVerifyVerdicts(p: Paths): Record<VerifyDimension, "PASS" | "FAIL" | null> {
	const out = {} as Record<VerifyDimension, "PASS" | "FAIL" | null>;
	for (const dim of VERIFY_DIMENSIONS) out[dim] = verdictOf(join(p.verify, `${dim}.md`));
	return out;
}

export function listSliceFiles(p: Paths): string[] {
	if (!existsSync(p.slices)) return [];
	return readdirSync(p.slices).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort();
}

export function pad3(n: number): string {
	return String(n).padStart(3, "0");
}

/** Files derived from the slice currently being implemented. */
export interface SliceArtifacts {
	sliceFile: string;
	sliceId: string;
	slicePath: string;
	memoPath: string;
	reviewPath: string;
}

export function sliceArtifacts(p: Paths, state: State): SliceArtifacts {
	const sliceFile = state.slices[state.sliceIndex];
	const sliceId = sliceFile.replace(/\.md$/, "");
	return {
		sliceFile,
		sliceId,
		slicePath: join(p.slices, sliceFile),
		memoPath: join(p.memos, `${sliceId}.md`),
		reviewPath: join(p.reviews, `${sliceId}-r${state.fixupRound}.md`),
	};
}

export function priorMemoPaths(p: Paths, state: State): string[] {
	return state.slices
		.slice(0, state.sliceIndex)
		.map((s) => join(p.memos, `${s.replace(/\.md$/, "")}.md`))
		.filter((f) => existsSync(f));
}

// --- Observability (used by the entry's tool hooks) --------------------------

/** Persist an observed `subagent` tool invocation for inspectability. */
export function observeSubagentCall(p: Paths, input: unknown): void {
	mkdirSync(p.calls, { recursive: true });
	const file = join(p.calls, `${new Date().toISOString().replace(/[:.]/g, "-")}-subagent-call.json`);
	writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), input }, null, 2), "utf8");
}

/** Accumulate a chars/4 token estimate from a `subagent` tool result. */
export function observeSubagentResult(p: Paths, state: State, input: unknown, content: Array<{ type: string; text?: string }>): void {
	const inputChars = JSON.stringify(input ?? {}).length;
	const outputChars = (content ?? [])
		.map((c) => (c.type === "text" ? (c.text?.length ?? 0) : 0))
		.reduce((a, b) => a + b, 0);
	state.tokensSpent += Math.ceil((inputChars + outputChars) / 4);
	saveState(p, state);
}

// --- Misc --------------------------------------------------------------------

export function statusSummary(p: Paths, state: State): string {
	const parts = [`slice-flow: ${state.feature}`, `phase: ${state.phase}`];
	if (state.phase === "implement" && state.slices.length > 0) {
		parts.push(`slice: ${state.slices[state.sliceIndex] ?? "?"} (${state.sliceIndex + 1}/${state.slices.length}, fix-up round ${state.fixupRound})`);
	}
	if (state.phase === "loop") {
		parts.push(`loop: iteration ${state.loopIteration}, failing: ${state.failedDimensions.join(", ")}`);
	}
	if (state.pending) parts.push(`awaiting: ${state.pending.label}`);
	parts.push(`tokens (est): ${state.tokensSpent}`, `state: ${p.state}`);
	return parts.join(" | ");
}

export function ensureGitignored(cwd: string, workDir: string): void {
	try {
		const gi = join(cwd, ".gitignore");
		const entry = `${workDir.replace(/\/$/, "")}/`;
		const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
		if (!current.split("\n").some((l) => l.trim() === entry || l.trim() === workDir)) {
			appendFileSync(gi, `${current.endsWith("\n") || current === "" ? "" : "\n"}${entry}\n`, "utf8");
		}
	} catch {
		/* non-fatal */
	}
}
