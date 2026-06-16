/**
 * The workflow's domain model and its persistence: state, paths, and every
 * read/write of the .pi/task/<slug>/ tree. Each task lives in its own
 * slug-named folder under the container dir, so several can be active at once.
 * Nothing here knows about prompts, subagent call shapes, or Pi APIs — it only
 * answers "what is true on disk?".
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKTREES_DIR } from "./worktree.ts";
import type { WorktreeInfo } from "./worktree.ts";

export const VERIFY_DIMENSIONS = ["code-quality", "simplicity", "security", "evals", "tests"] as const;
export type VerifyDimension = (typeof VERIFY_DIMENSIONS)[number];

export type Phase = "frame" | "architect" | "prototype" | "plan" | "implement" | "verify" | "loop" | "done" | "stopped";

/** Sub-states of the frame phase (Frame v2: intake -> explore -> compile -> gate). */
export type FrameStage = "intake" | "explore" | "compile" | "gate";

export interface Directive {
	kind: string; // intake | research | attack | frame-compile | architect | prototype | plan | build | fixup | verify | loop-fix
	seq: number;
	label: string;
	args: Record<string, unknown>; // exact subagent tool input
	expects?: string[]; // artifact files this directive must produce (validated on `next`)
}

export interface State {
	version: 1 | 2;
	feature: string;
	slug: string; // task folder name under the container dir (.pi/task/<slug>/)
	createdAt: string;
	updatedAt: string;
	baselineCommit: string | null;
	phase: Phase;
	frameStage: FrameStage;
	compileRetries: number;
	archRetries: number; // bounded re-judge rounds for the architecture document
	archApproved: boolean; // gate approval persisted before the UI question (atomicity)
	archWinner: string | null; // parsed "WINNER: hypothesis-<id>" marker
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
	isolation?: { worktree?: WorktreeInfo; disposition?: string };
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
	frameDir: string;
	intake: string;
	ledger: string;
	frameResearch: string;
	frameAttacks: string;
	frameJudgement: string;
	frame: string;
	architecture: string;
	plan: string;
	report: string;
}

/** Absolute path of the container that holds every task's slug folder. */
export function tasksContainer(cwd: string, workDir: string): string {
	return resolve(cwd, workDir);
}

export function workPaths(cwd: string, workDir: string, slug: string): Paths {
	const root = resolve(cwd, workDir, slug);
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
		frameDir: join(root, "frame"),
		intake: join(root, "frame", "00-intake.md"),
		ledger: join(root, "frame", "ledger.md"),
		frameResearch: join(root, "frame", "research"),
		frameAttacks: join(root, "frame", "attacks"),
		frameJudgement: join(root, "frame", "judgement.md"),
		frame: join(root, "01-frame.md"),
		architecture: join(root, "02-architecture.md"),
		plan: join(root, "03-plan.md"),
		report: join(root, "REPORT.md"),
	};
}

export function ensureWorkTree(p: Paths): void {
	for (const dir of [
		p.root,
		p.logs,
		p.calls,
		p.chains,
		p.arch,
		p.slices,
		p.memos,
		p.reviews,
		p.verify,
		p.prototypes,
		p.frameDir,
		p.frameResearch,
		p.frameAttacks,
	]) {
		mkdirSync(dir, { recursive: true });
	}
}

export function createState(
	feature: string,
	slug: string,
	baselineCommit: string | null,
	isolation?: { worktree?: WorktreeInfo },
): State {
	const now = new Date().toISOString();
	return {
		version: 2,
		feature,
		slug,
		createdAt: now,
		updatedAt: now,
		baselineCommit,
		phase: "frame",
		frameStage: "intake",
		compileRetries: 0,
		archRetries: 0,
		archApproved: false,
		archWinner: null,
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
		isolation,
	};
}

export function loadState(p: Paths): State | null {
	if (!existsSync(p.state)) return null;
	const s = JSON.parse(readFileSync(p.state, "utf8")) as State;
	// Tasks persist across package upgrades; default fields added after a task
	// was created so a pre-upgrade task resumes instead of crashing on undefined.
	s.frameStage = s.frameStage ?? "explore";
	s.compileRetries = s.compileRetries ?? 0;
	s.archRetries = s.archRetries ?? 0;
	s.archApproved = s.archApproved ?? false;
	s.archWinner = s.archWinner ?? null;
	return s;
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

// --- Multiple tasks: discovery, resolution, and slug allocation --------------

/** One task on disk: its slug folder name and the state it persisted. */
export interface TaskRef {
	slug: string;
	state: State;
}

/** Every task folder under the container that holds a readable state.json. */
export function listTasks(cwd: string, workDir: string): TaskRef[] {
	const root = tasksContainer(cwd, workDir);
	if (!existsSync(root)) return [];
	const out: TaskRef[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const stateFile = join(root, entry.name, "state.json");
		if (!existsSync(stateFile)) continue;
		try {
			out.push({ slug: entry.name, state: JSON.parse(readFileSync(stateFile, "utf8")) as State });
		} catch {
			/* a half-written or hand-edited state.json should not break discovery */
		}
	}
	return out;
}

export type TaskResolution =
	| { kind: "ok"; slug: string }
	| { kind: "none" }
	| { kind: "ambiguous"; active: string[] }
	| { kind: "missing"; slug: string };

/**
 * Decide which task an action targets. An explicit slug wins (and must exist).
 * Otherwise the single active task is used; a single dormant task is used when
 * none are active; two or more active tasks are ambiguous and need a slug.
 */
export function resolveActiveTask(cwd: string, workDir: string, slug?: string): TaskResolution {
	const tasks = listTasks(cwd, workDir);
	if (slug) return tasks.some((t) => t.slug === slug) ? { kind: "ok", slug } : { kind: "missing", slug };
	const active = tasks.filter((t) => isActive(t.state));
	if (active.length === 1) return { kind: "ok", slug: active[0].slug };
	if (active.length > 1) return { kind: "ambiguous", active: active.map((t) => t.slug) };
	if (tasks.length === 1) return { kind: "ok", slug: tasks[0].slug };
	return { kind: "none" };
}

/** A free slug folder for a new task: slugify the feature, suffix on collision. */
export function allocateSlug(cwd: string, workDir: string, feature: string): string {
	const root = tasksContainer(cwd, workDir);
	const base = slugify(feature);
	let slug = base;
	for (let n = 2; existsSync(join(root, slug)); n++) slug = `${base}-${n}`;
	return slug;
}

/** Best-effort: attribute a subagent call to a task by finding its root path
 * inside the call arguments (directive args always write under the task root). */
export function inferTaskSlug(cwd: string, workDir: string, input: unknown): string | null {
	const root = tasksContainer(cwd, workDir);
	const hay = JSON.stringify(input ?? "");
	for (const t of listTasks(cwd, workDir)) {
		if (hay.includes(join(root, t.slug))) return t.slug;
	}
	return null;
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

/** First `INTAKE: SUFFICIENT|QUESTIONS` marker in the intake file; null when absent. */
export function intakeMarkerOf(file: string): "SUFFICIENT" | "QUESTIONS" | null {
	if (!existsSync(file)) return null;
	const match = readFileSync(file, "utf8").match(/INTAKE:\s*(SUFFICIENT|QUESTIONS)/i);
	return match ? (match[1].toUpperCase() as "SUFFICIENT" | "QUESTIONS") : null;
}

// --- Frame lint: deterministic structure checks before any human or judge ----

export const FRAME_REQUIRED_SECTIONS = [
	"## Problem",
	"## What the code does today",
	"## Proposed solution",
	"## Why this solves the problem",
	"## Acceptance criteria",
	"## Out of scope",
	"## Open questions",
] as const;

/** Hedge and filler words banned by the zinsser-framing skill; keep both lists in sync. */
const FRAME_BANNED_WORDS = /\b(might|could|consider|perhaps|possibly|simply|basically|essentially|robust|seamless|leverage|leveraging|utilize)\b/i;

export interface FrameLint {
	ok: boolean;
	findings: string[];
}

/** Mechanical checks only — structure, banned words, testable-criteria presence.
 * Substance is judged by the fidelity judge and the human gate, never here. */
export function lintFrame(file: string): FrameLint {
	const findings: string[] = [];
	if (!nonEmpty(file)) return { ok: false, findings: [`${file} is missing or empty`] };
	const text = readFileSync(file, "utf8");
	const lines = text.split("\n");

	for (const section of FRAME_REQUIRED_SECTIONS) {
		if (!lines.some((l) => l.trim().toLowerCase().startsWith(section.toLowerCase()))) {
			findings.push(`missing required section "${section}"`);
		}
	}

	lines.forEach((line, i) => {
		const trimmed = line.trim();
		const isContent = trimmed.startsWith("-") || /^\d+\./.test(trimmed);
		const banned = isContent ? trimmed.match(FRAME_BANNED_WORDS) : null;
		if (banned) findings.push(`line ${i + 1}: banned hedge/filler word "${banned[1]}"`);
	});

	const criteriaSection = text.split(/^## /m).find((s) => s.toLowerCase().startsWith("acceptance criteria"));
	if (criteriaSection && !criteriaSection.split("\n").some((l) => /^\s*(\d+\.|-)\s+\S/.test(l))) {
		findings.push(`"## Acceptance criteria" has no checklist items`);
	}

	return { ok: findings.length === 0, findings };
}

// --- Architecture lint: deterministic structure checks on 02-architecture.md --

export const ARCH_REQUIRED_SECTIONS = ["## Winner", "## Scores", "## Why the losers lost", "## Risks carried forward"] as const;

/** Mechanical checks only — sections, Mermaid diagram, scores table. No banned
 * words: "could" and "might" are correct vocabulary in a Risks section.
 * Substance is judged by the human gate and re-checked downstream (plan gate,
 * slice reviews, verify phase), never here. */
export function lintArchitecture(file: string): FrameLint {
	const findings: string[] = [];
	if (!nonEmpty(file)) return { ok: false, findings: [`${file} is missing or empty`] };
	const text = readFileSync(file, "utf8");
	const lines = text.split("\n");
	for (const section of ARCH_REQUIRED_SECTIONS) {
		if (!lines.some((l) => l.trim().toLowerCase().startsWith(section.toLowerCase()))) {
			findings.push(`missing required section "${section}"`);
		}
	}
	if (!/```mermaid/.test(text)) findings.push("missing fenced ```mermaid diagram in the Winner section");
	if (!lines.some((l) => /^\s*\|.*\|\s*$/.test(l))) findings.push('"## Scores" has no markdown table');
	return { ok: findings.length === 0, findings };
}

/** First `WINNER: hypothesis-<id>` marker in the architecture doc; null when absent. */
export function winnerOf(file: string): string | null {
	if (!existsSync(file)) return null;
	const match = readFileSync(file, "utf8").match(/WINNER:\s*(hypothesis-\d+)/i);
	return match ? match[1].toLowerCase() : null;
}

/** Hypothesis files currently on disk for this task, in id order. */
export function hypothesisPaths(p: Paths): string[] {
	if (!existsSync(p.arch)) return [];
	return readdirSync(p.arch)
		.filter((f) => /^hypothesis-\d+\.md$/.test(f))
		.sort()
		.map((f) => join(p.arch, f));
}

/** Delete artifacts before a re-run so `expects` validation proves fresh work,
 * never last round's leftovers. Paths are task-scoped, so siblings are safe. */
export function removeFiles(files: string[]): void {
	for (const f of files) rmSync(f, { force: true });
}

/** Next 3-digit sequence number for NNN-*.md files in a directory. */
export function nextSeqIn(dir: string): number {
	if (!existsSync(dir)) return 1;
	const taken = readdirSync(dir)
		.map((f) => f.match(/^(\d{3})-/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => Number(m[1]));
	return taken.length === 0 ? 1 : Math.max(...taken) + 1;
}

/** Slug for naming artifact files after a free-text question/topic. */
export function slugify(text: string, maxWords = 6): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.split(/\s+/)
			.slice(0, maxWords)
			.join("-") || "untitled"
	);
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
	if (state.phase === "frame") {
		parts.push(`frame stage: ${state.frameStage}${state.frameStage === "compile" && state.compileRetries > 0 ? ` (retry ${state.compileRetries})` : ""}`);
	}
	if (state.phase === "architect" && (state.archWinner || state.archRetries > 0)) {
		parts.push(`architect: winner ${state.archWinner ?? "?"}${state.archRetries > 0 ? `, re-judge round ${state.archRetries}` : ""}`);
	}
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
		const entries = [`${workDir.replace(/\/$/, "")}/`, `${WORKTREES_DIR}/`];
		for (const entry of entries) {
			const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
			const bare = entry.replace(/\/$/, "");
			if (!current.split("\n").some((l) => l.trim() === entry || l.trim() === bare)) {
				appendFileSync(gi, `${current.endsWith("\n") || current === "" ? "" : "\n"}${entry}\n`, "utf8");
			}
		}
	} catch {
		/* non-fatal */
	}
}
