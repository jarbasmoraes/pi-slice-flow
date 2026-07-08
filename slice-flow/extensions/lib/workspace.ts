/**
 * The workflow's domain model and its persistence: state, paths, and every
 * read/write of the .pi/task/<slug>/ tree. Each task lives in its own
 * slug-named folder under the container dir, so several can be active at once.
 * Nothing here knows about prompts, subagent call shapes, or Pi APIs — it only
 * answers "what is true on disk?".
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

/** The per-project profile authored by `slice-flow init` and stored in
 * `.slice-flow/PROJECT.md`. Each field is one parsed section; injected into the
 * relevant phase briefs so fresh-context agents inherit this repo's specifics
 * (see lib/init.ts for parse/load and briefs.ts `projectProfileClause`). */
export interface ProjectProfile {
	domain: string;
	invariants: string;
	conventions: string;
	libs: string;
	riskNotes: string;
	dod: string;
	raw: string;
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
	archRejudgeRetries: number; // bounded CHEAP re-judge rounds (lint fail / human "re-judge only")
	archReconsiderRetries: number; // bounded EXPENSIVE full re-runs (attack panel RECONSIDER) — separate budget so cheap re-judges can't starve it
	planRetries: number; // bounded auto-replan rounds when the slice lint/judge fails
	prototypeRetries: number; // bounded re-judge rounds when the prototype judgement lint fails
	archApproved: boolean; // gate approval persisted before the UI question (atomicity)
	archAttacked: boolean; // the attack panel ran on the current winner (run once before the gate)
	lastAttackedLedgerHash?: string; // sha256 of the ledger the frame attack panel last ran against (skip identical re-attacks)
	archWinner: string | null; // parsed "WINNER: hypothesis-<id>" marker
	pending: Directive | null;
	ui: "none" | "greenfield" | "existing" | null;
	slices: string[]; // slice file basenames, in order
	sliceIndex: number;
	fixupRound: number; // 0 = initial build; 1..maxFixupsPerSlice = fix-up rounds
	loopIteration: number;
	failedDimensions: VerifyDimension[];
	tokensSpent: number; // chars/4 of observed subagent tool I/O — a rough display
	// figure only (NOT model tokens; child usage is not exposed at the tool boundary).
	loopStartTokens: number;
	loopCost: number; // weighted opus-equivalent spawns accrued in the current loop (enforcement)
	realInputTokens: number; // real model input tokens summed from subagent usage (0 when unavailable)
	realOutputTokens: number; // real model output tokens summed from subagent usage
	realCost: number; // real USD cost summed from subagent usage (0 when unavailable, e.g. async mode)
	seq: number;
	codegraphReady: boolean; // a .codegraph/*.db index present at start; gates later codegraph skill injection
	/** Confirmed live risk axes from the check-pack manifest (empty when no
	 * confirmed profile). Drives the plan-judge coverage lens (phase 3). */
	liveAxes?: string[];
	/** Per-project profile from `.slice-flow/PROJECT.md` (`slice-flow init`),
	 * loaded at start and injected into the intake/architect/build/review briefs.
	 * Undefined when the project has no profile. */
	projectProfile?: ProjectProfile;
	/** Model families available as judges at start (always includes "claude";
	 * adds others whose CLI was probed on PATH). Drives cross-family judge
	 * routing. Undefined on tasks created before this field existed. */
	judgeFamilies?: string[];
	log: Array<LogEntry>;
	telemetry?: { traceId: string }; // Langfuse trace id for this run, stable across resume
	isolation?: { worktree?: WorktreeInfo; disposition?: string };
	/** The real Todoist task created at run start (push MVP, slice 001). Undefined
	 * when Todoist is disabled, no UI was present, or the create call failed. */
	todoist?: { taskId: string; project: string; sectionMode: "sections" | "comment-only"; attachedFrame?: boolean; attachedArch?: boolean };
}

/** A structured log entry. `event` is the human-readable string (kept verbatim
 * for every entry so any string reader stays valid); `kind`/`payload` are the
 * optional machine-readable fields metrics and telemetry key off. Entries
 * persisted before this field existed simply lack `kind`/`payload`. */
export interface LogEntry {
	ts: string;
	event: string;
	kind?: LogKind;
	payload?: unknown;
}

export type LogKind = "gate" | "retry" | "directive" | "verdict" | "note" | "phase" | "lifecycle";

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
	archAttacks: string;
	archDispositions: string;
	plan: string;
	planJudgement: string;
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
		archAttacks: join(root, "arch", "attacks"),
		archDispositions: join(root, "02-architecture-attacks.md"),
		plan: join(root, "03-plan.md"),
		planJudgement: join(root, "03-plan-judgement.md"),
		report: join(root, "REPORT.md"),
	};
}

/** Cross-run reflect workspace: lives beside the task folders under the
 * container dir, holds the compiled override cases, the spawned reflection
 * agent's brief, and the human-reviewable rubric proposals. It carries no
 * state.json, so listTasks never mistakes it for a task. */
export interface ReflectPaths {
	root: string;
	logs: string;
	chains: string;
	casesOf: (judge: string) => string;
	proposalsOf: (judge: string) => string;
}

export function reflectPaths(cwd: string, workDir: string): ReflectPaths {
	const root = join(tasksContainer(cwd, workDir), "reflect");
	return {
		root,
		logs: join(root, "logs"),
		chains: join(root, "chains"),
		casesOf: (judge) => join(root, `${judge}-cases.md`),
		proposalsOf: (judge) => join(root, `${judge}-proposals.md`),
	};
}

export function ensureReflectTree(r: ReflectPaths): void {
	for (const dir of [r.root, r.logs, r.chains]) mkdirSync(dir, { recursive: true });
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
		p.archAttacks,
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
		archRejudgeRetries: 0,
		archReconsiderRetries: 0,
		planRetries: 0,
		prototypeRetries: 0,
		archApproved: false,
		archAttacked: false,
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
		loopCost: 0,
		realInputTokens: 0,
		realOutputTokens: 0,
		realCost: 0,
		seq: 0,
		codegraphReady: false,
		liveAxes: [],
		judgeFamilies: ["claude"],
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
	// archRetries was split into rejudge/reconsider budgets; migrate the old field.
	const legacyArch = (s as { archRetries?: number }).archRetries;
	s.archRejudgeRetries = s.archRejudgeRetries ?? legacyArch ?? 0;
	s.archReconsiderRetries = s.archReconsiderRetries ?? 0;
	s.loopCost = s.loopCost ?? 0;
	s.realInputTokens = s.realInputTokens ?? 0;
	s.realOutputTokens = s.realOutputTokens ?? 0;
	s.realCost = s.realCost ?? 0;
	s.planRetries = s.planRetries ?? 0;
	s.prototypeRetries = s.prototypeRetries ?? 0;
	s.archApproved = s.archApproved ?? false;
	s.archAttacked = s.archAttacked ?? false;
	s.archWinner = s.archWinner ?? null;
	s.codegraphReady = s.codegraphReady ?? false;
	s.liveAxes = s.liveAxes ?? [];
	s.judgeFamilies = s.judgeFamilies ?? ["claude"];
	return s;
}

export function saveState(p: Paths, state: State): void {
	state.updatedAt = new Date().toISOString();
	writeFileSync(p.state, JSON.stringify(state, null, 2), "utf8");
}

export function logEvent(state: State, event: string, kind?: LogKind, payload?: unknown): void {
	const entry: LogEntry = { ts: new Date().toISOString(), event };
	if (kind) entry.kind = kind;
	if (payload !== undefined) entry.payload = payload;
	state.log.push(entry);
}

/** The single producer of a gate-decision log line. Every gate writes through
 * here so the canonical `gate <id>: <decision>` string exists in exactly one
 * place and carries a structured `{ gate, decision }` payload — no consumer
 * needs to regex free text, and a reworded human string cannot silently drop a
 * decision from the override-rate that decides an `auto` flip. */
export function logGate(state: State, gate: string, decision: string): void {
	logEvent(state, `gate ${gate}: ${decision}`, "gate", { gate, decision });
}

/** Log a bounded-retry round with a structured kind, so metrics counts off the
 * payload rather than phrase-matching the human string. */
export function logRetry(state: State, retryKind: string, event: string): void {
	logEvent(state, event, "retry", { retryKind });
}

/** Append a diagnostics line (unattributed subagent calls, swallowed hook
 * errors) to a debug log beside the task folders. Never throws — diagnostics
 * must not perturb the workflow. */
export function appendTelemetryDebug(cwd: string, workDir: string, entry: Record<string, unknown>): void {
	try {
		const dir = tasksContainer(cwd, workDir);
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, ".telemetry-debug.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		/* diagnostics are best-effort */
	}
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

/** Render a Date as `yyyy-mm-dd_HHmmss` in local time, each field zero-padded. */
function formatTaskStamp(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
		`_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
	);
}

/** A free slug folder for a new task: timestamp-prefixed slugified feature, advancing on collision. */
export function allocateSlug(cwd: string, workDir: string, feature: string, now: Date = new Date()): string {
	const root = tasksContainer(cwd, workDir);
	const base = slugify(feature);
	let stamp = new Date(now.getTime());
	let slug = `${formatTaskStamp(stamp)}_${base}`;
	while (existsSync(join(root, slug))) {
		stamp = new Date(stamp.getTime() + 1000);
		slug = `${formatTaskStamp(stamp)}_${base}`;
	}
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

export const ARCH_REQUIRED_SECTIONS = [
	"## Winner",
	"## Goals & Non-Goals",
	"## Architecture Overview",
	"## Components",
	"## Data Models & Schema Changes",
	"## Error Handling",
	"## Alternatives Considered",
	"## Risks & Mitigations",
	"## Requirement Traceability",
	"## Scores",
] as const;

/** True when the body of the `## ` section named `headingText` (without the
 * `## ` prefix) contains a markdown table row. Heading-scoped: `split(/^## /m)`
 * drops the prefix and a `### ` subheading is not matched by `^## `, so a
 * subsection's rows stay inside their parent body. */
function sectionHasTable(text: string, headingText: string): boolean {
	const needle = headingText.toLowerCase();
	const body = text.split(/^## /m).find((s) => s.toLowerCase().startsWith(needle));
	if (body === undefined) return false;
	return body.split("\n").some((l) => /^\s*\|.*\|\s*$/.test(l));
}

/** Mechanical checks only — required sections, two Mermaid diagrams, and a
 * heading-scoped table under Scores and Requirement Traceability. No banned
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
	const mermaidCount = (text.match(/```mermaid/g) ?? []).length;
	if (mermaidCount < 2) findings.push(`expected >=2 fenced \`\`\`mermaid diagrams, found ${mermaidCount}`);
	if (!sectionHasTable(text, "Scores")) findings.push('"## Scores" has no markdown table');
	if (!sectionHasTable(text, "Requirement Traceability"))
		findings.push('"## Requirement Traceability" has no markdown table');
	return { ok: findings.length === 0, findings };
}

/** First `WINNER: hypothesis-<id>` marker in the architecture doc; null when absent. */
export function winnerOf(file: string): string | null {
	if (!existsSync(file)) return null;
	const match = readFileSync(file, "utf8").match(/WINNER:\s*(hypothesis-\d+)/i);
	return match ? match[1].toLowerCase() : null;
}

/** First `ARCH-ATTACK: HOLDS|RECONSIDER` marker in the attack dispositions; null when absent. */
export function archAttackMarkerOf(file: string): "HOLDS" | "RECONSIDER" | null {
	if (!existsSync(file)) return null;
	const m = readFileSync(file, "utf8").match(/ARCH-ATTACK:\s*(HOLDS|RECONSIDER)/i);
	return m ? (m[1].toUpperCase() as "HOLDS" | "RECONSIDER") : null;
}

/** First `WINNER: proto-<n>` marker in the prototype judgement; null when absent. */
export function prototypeWinnerOf(file: string): string | null {
	if (!existsSync(file)) return null;
	const m = readFileSync(file, "utf8").match(/WINNER:\s*(proto-\d+)/i);
	return m ? m[1].toLowerCase() : null;
}

/** True when the prototype judge declared the whole slate inadequate — its first
 * line is `WINNER: NONE-ACCEPTABLE` instead of naming a prototype. This is the
 * reject-all floor: a weak slate triggers a bounded regenerate, never an
 * auto-adopted winner. Checked on the first line only so prose can't trip it. */
export function prototypeRejectsAll(file: string): boolean {
	if (!existsSync(file)) return false;
	const first = readFileSync(file, "utf8").split(/\r?\n/, 1)[0] ?? "";
	return /WINNER:\s*NONE-ACCEPTABLE/i.test(first);
}

/** Remove the proto-<n> directories so a regenerate starts from a clean slate. */
export function clearPrototypes(p: Paths): void {
	try {
		for (const entry of readdirSync(p.prototypes)) {
			if (/^proto-\d+$/.test(entry)) rmSync(join(p.prototypes, entry), { recursive: true, force: true });
		}
	} catch {
		/* best-effort */
	}
}

/** Lint the prototype judgement: a parseable WINNER marker that names a real
 * prototype directory carrying a README. Mechanical only — the taste call is
 * the judge's and the human gate's. */
export function lintPrototype(p: Paths): FrameLint {
	const judgement = join(p.prototypes, "JUDGEMENT.md");
	const winner = prototypeWinnerOf(judgement);
	if (winner === null) return { ok: false, findings: [`missing first line "WINNER: proto-<n>" in ${judgement}`] };
	const findings: string[] = [];
	const dir = join(p.prototypes, winner);
	if (!existsSync(dir)) findings.push(`winner ${winner} names a directory that does not exist`);
	else if (!existsSync(join(dir, "README.md"))) findings.push(`winner ${winner} has no README.md`);
	return { ok: findings.length === 0, findings };
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

/** The judge verdict files on disk for one task, keyed for the metrics core
 * (frame, plan, verify:<dim>). Kept here — not in the pure metrics module — so
 * the analysis layer stays IO-free and testable. */
export function taskVerdictSummary(p: Paths): Record<string, "PASS" | "FAIL" | null> {
	const out: Record<string, "PASS" | "FAIL" | null> = {
		frame: verdictOf(p.frameJudgement),
		plan: verdictOf(p.planJudgement),
	};
	const verify = readVerifyVerdicts(p);
	for (const dim of VERIFY_DIMENSIONS) out[`verify:${dim}`] = verify[dim];
	return out;
}

export function listSliceFiles(p: Paths): string[] {
	if (!existsSync(p.slices)) return [];
	return readdirSync(p.slices).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort();
}

// --- Plan divergence: competing candidate decompositions (planCount > 1) ------

/** Directory holding one plan candidate (its plan.md + slices/). */
export function planCandidateDir(p: Paths, n: number): string {
	return join(p.root, `plan-${n}`);
}

/** First `WINNER: plan-<n>` marker in the plan selector's judgement; null when absent. */
export function planWinnerOf(file: string): string | null {
	if (!existsSync(file)) return null;
	const m = readFileSync(file, "utf8").match(/WINNER:\s*(plan-\d+)/i);
	return m ? m[1].toLowerCase() : null;
}

/** Copy the winning candidate's plan.md and slice files into the canonical
 * p.plan / p.slices locations the rest of the workflow reads. Returns false when
 * the candidate's artifacts are missing (caller re-issues). */
export function promotePlanCandidate(p: Paths, winner: string): boolean {
	const dir = join(p.root, winner);
	const planSrc = join(dir, "plan.md");
	const sliceSrc = join(dir, "slices");
	if (!existsSync(planSrc) || !existsSync(sliceSrc)) return false;
	copyFileSync(planSrc, p.plan);
	mkdirSync(p.slices, { recursive: true });
	const slices = readdirSync(sliceSrc).filter((f) => /^\d{3}-.*\.md$/.test(f));
	if (slices.length === 0) return false;
	for (const f of slices) copyFileSync(join(sliceSrc, f), join(p.slices, f));
	return true;
}

/** Remove all plan-<n> candidate dirs (between divergence rounds). */
export function clearPlanCandidates(p: Paths): void {
	try {
		for (const entry of readdirSync(p.root)) {
			if (/^plan-\d+$/.test(entry)) rmSync(join(p.root, entry), { recursive: true, force: true });
		}
	} catch {
		/* best-effort */
	}
}

/** Clear the plan artifacts before a replan/revise. In divergence mode this also
 * drops the canonical plan + selector judgement + candidate dirs, so the next
 * round regenerates and re-promotes cleanly rather than reusing a stale winner. */
export function resetPlanArtifacts(p: Paths, divergent: boolean): void {
	removeFiles(listSliceFiles(p).map((f) => join(p.slices, f)));
	if (divergent) {
		removeFiles([p.plan, p.planJudgement]);
		clearPlanCandidates(p);
	}
}

// --- Slice lint: deterministic structure + ordering checks on the plan output -

export const SLICE_REQUIRED_SECTIONS = [
	"## Objective",
	"## Depends on",
	"## Scope",
	"## Out of scope",
	"## Acceptance criteria",
	"## Hints",
] as const;

/** Body of a `## Section` heading until the next `## ` (or end of file).
 * Fenced code blocks are transparent: a `## ` line inside ``` ... ``` (a Python
 * comment, a shell heading, a markdown example) does not end the section, so a
 * slice whose Scope/Hints contain code is parsed correctly. */
function sectionBody(text: string, heading: string): string | null {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(heading.toLowerCase()));
	if (start === -1) return null;
	const rest: string[] = [];
	let inFence = false;
	for (let i = start + 1; i < lines.length; i++) {
		const t = lines[i].trim();
		if (/^```/.test(t)) inFence = !inFence;
		if (!inFence && /^##\s/.test(t)) break;
		rest.push(lines[i]);
	}
	return rest.join("\n");
}

/** True when a section body has at least one `-` or `N.` checklist item. */
function hasChecklistItem(body: string | null): boolean {
	return body !== null && body.split("\n").some((l) => /^\s*(\d+\.|-)\s+\S/.test(l));
}

/**
 * Mechanical checks only on the planner's output: contiguous numbering, the
 * required slice sections, populated Scope/Acceptance, slice 001 standing
 * alone, and — the load-bearing one — no forward dependency (a slice may only
 * depend on lower-numbered slices). Substance (does the decomposition serve
 * the frame?) is left to the human gate and the future plan judge.
 */
export function lintSlices(p: Paths): FrameLint {
	const findings: string[] = [];
	const files = listSliceFiles(p);
	if (files.length === 0) return { ok: false, findings: [`no slice files found in ${p.slices}`] };

	const nums = files.map((f) => Number(f.slice(0, 3)));
	for (let i = 0; i < nums.length; i++) {
		if (nums[i] !== i + 1) {
			findings.push(`slice numbering is not contiguous from 001: expected ${pad3(i + 1)}, found ${pad3(nums[i])} (${files[i]})`);
			break;
		}
	}

	files.forEach((file, idx) => {
		const num = nums[idx];
		const text = readFileSync(join(p.slices, file), "utf8");
		for (const section of SLICE_REQUIRED_SECTIONS) {
			if (sectionBody(text, section) === null) findings.push(`${file}: missing required section "${section}"`);
		}
		if (!hasChecklistItem(sectionBody(text, "## Scope"))) findings.push(`${file}: "## Scope" has no items`);
		if (!hasChecklistItem(sectionBody(text, "## Acceptance criteria"))) findings.push(`${file}: "## Acceptance criteria" has no items`);

		const deps = sectionBody(text, "## Depends on");
		if (deps !== null && !/\bnone\b/i.test(deps)) {
			// Slice ids are zero-padded 3-digit (NNN-<slug>), so match only that
			// form. Bare prose cardinals ("see issue 42", "the 3 helpers", "v3")
			// are not slice references and must not trip a false forward-dep that
			// would burn the replan budget on a valid plan.
			const depNums = [...deps.matchAll(/\b(\d{3})\b/g)].map((m) => Number(m[1]));
			if (num === 1 && depNums.length > 0) {
				findings.push(`${file}: slice 001 must depend on "none" (found ${depNums.map(pad3).join(", ")})`);
			}
			for (const d of depNums) {
				if (d >= num) findings.push(`${file}: forward dependency — depends on ${pad3(d)} which is not a prior slice`);
			}
		}
	});

	return { ok: findings.length === 0, findings };
}

// --- Memo lint: the post-build memo is load-bearing for every later builder ---

export const MEMO_REQUIRED_SECTIONS = [
	"## What exists now",
	"## Changed files",
	"## Commit",
	"## Tests",
	"## Deviations",
	"## Notes for later slices",
] as const;

/** Mechanical format check on a builder/fix-up memo: required sections, a
 * populated changed-files list, and (when auto_commit) a commit hash. A lying
 * memo is the reviewer's job; a malformed one is caught here for free. */
export function lintMemo(file: string, autoCommit: boolean): FrameLint {
	const findings: string[] = [];
	if (!nonEmpty(file)) return { ok: false, findings: [`${file} is missing or empty`] };
	const text = readFileSync(file, "utf8");
	for (const section of MEMO_REQUIRED_SECTIONS) {
		if (sectionBody(text, section) === null) findings.push(`missing required section "${section}"`);
	}
	const changed = sectionBody(text, "## Changed files");
	if (!hasChecklistItem(changed)) findings.push(`"## Changed files" has no entries`);
	if (autoCommit) {
		const commit = sectionBody(text, "## Commit");
		if (commit === null || !/[0-9a-f]{7,40}/i.test(commit)) findings.push(`"## Commit" has no commit hash (auto_commit is enabled)`);
	}
	return { ok: findings.length === 0, findings };
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

/** Accumulate a chars/4 figure from the `subagent` tool I/O slice-flow can see
 * at the tool boundary. This is a coarse display number, NOT model-token usage:
 * a child agent's real token spend (system prompt, reads, reasoning) never crosses
 * back through the tool result, so this undercounts by roughly 1-2 orders of
 * magnitude. Loop enforcement uses `state.loopCost` (weighted spawns), not this. */
export interface SubagentUsage {
	input: number;
	output: number;
	cost: number;
}

/** Sum real per-agent token usage + cost from a `subagent` tool result's
 * `details`. pi-subagents returns `details.results: [{ usage: { input, output,
 * cost, ... } }]` for foreground runs; an async receipt has an empty `results`
 * (usage arrives later, out of band), so this returns null and the caller falls
 * back to the chars/4 estimate. */
export function sumUsage(details: unknown): SubagentUsage | null {
	if (!details || typeof details !== "object") return null;
	const results = (details as { results?: unknown }).results;
	if (!Array.isArray(results) || results.length === 0) return null;
	let input = 0;
	let output = 0;
	let cost = 0;
	let seen = false;
	for (const r of results) {
		const u = (r as { usage?: { input?: number; output?: number; cost?: number } })?.usage;
		if (!u) continue;
		seen = true;
		input += u.input ?? 0;
		output += u.output ?? 0;
		cost += u.cost ?? 0;
	}
	return seen ? { input, output, cost } : null;
}

export function observeSubagentResult(
	p: Paths,
	state: State,
	input: unknown,
	content: Array<{ type: string; text?: string }>,
	details?: unknown,
): void {
	const text = (content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
	// Persist the returned text for full inspectability (mirrors observeSubagentCall).
	try {
		mkdirSync(p.calls, { recursive: true });
		const file = join(p.calls, `${new Date().toISOString().replace(/[:.]/g, "-")}-subagent-result.json`);
		writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), text }, null, 2), "utf8");
	} catch {
		/* best-effort persistence */
	}
	// Capture a self-reported VERDICT/WINNER even before the engine reads the
	// on-disk artifact, so the judgement trail is in state.log.
	const verdict = text.match(/VERDICT:\s*(PASS|FAIL)/i);
	const winner = text.match(/WINNER:\s*(\S+)/i);
	if (verdict) logEvent(state, `subagent verdict: ${verdict[1].toUpperCase()}`, "verdict", { verdict: verdict[1].toUpperCase() });
	else if (winner) logEvent(state, `subagent winner: ${winner[1]}`, "verdict", { winner: winner[1] });
	// Real token usage when pi-subagents exposes it (foreground); else fall back.
	const usage = sumUsage(details);
	if (usage) {
		state.realInputTokens += usage.input;
		state.realOutputTokens += usage.output;
		state.realCost += usage.cost;
	} else if (details && typeof details === "object" && "asyncId" in (details as object)) {
		logEvent(state, "usage unavailable: async subagent mode (chars/4 fallback)", "note");
	}
	// chars/4 of observed tool I/O — a coarse display fallback (see field comment).
	const inputChars = JSON.stringify(input ?? {}).length;
	state.tokensSpent += Math.ceil((inputChars + text.length) / 4);
	saveState(p, state);
}

// --- Misc --------------------------------------------------------------------

export function statusSummary(p: Paths, state: State): string {
	const parts = [`slice-flow: ${state.feature}`, `phase: ${state.phase}`];
	if (state.phase === "frame") {
		parts.push(`frame stage: ${state.frameStage}${state.frameStage === "compile" && state.compileRetries > 0 ? ` (retry ${state.compileRetries})` : ""}`);
	}
	if (state.phase === "architect" && (state.archWinner || state.archRejudgeRetries > 0)) {
		parts.push(`architect: winner ${state.archWinner ?? "?"}${state.archRejudgeRetries > 0 ? `, re-judge round ${state.archRejudgeRetries}` : ""}`);
	}
	if (state.phase === "implement" && state.slices.length > 0) {
		parts.push(`slice: ${state.slices[state.sliceIndex] ?? "?"} (${state.sliceIndex + 1}/${state.slices.length}, fix-up round ${state.fixupRound})`);
	}
	if (state.phase === "loop") {
		parts.push(`loop: iteration ${state.loopIteration}, cost ~${state.loopCost.toFixed(1)} spawns, failing: ${state.failedDimensions.join(", ")}`);
	}
	if (state.pending) parts.push(`awaiting: ${state.pending.label}`);
	if (state.realCost > 0) parts.push(`cost: $${state.realCost.toFixed(4)} (${state.realInputTokens + state.realOutputTokens} tok)`);
	parts.push(`io est: ${state.tokensSpent} chars/4`, `state: ${p.state}`);
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
