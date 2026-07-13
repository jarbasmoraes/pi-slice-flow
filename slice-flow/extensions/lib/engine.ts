/**
 * The workflow state machine: validates the artifacts of the step that just
 * finished, runs approval gates, advances the phase, and issues the next
 * directive. It depends only on the domain model (workspace), the directive
 * builders, and the narrow gate context — never on Pi's ExtensionAPI.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateName, SliceFlowConfig } from "./config.ts";
import { getTelemetry } from "./telemetry.ts";
import { BOARD_SECTIONS, PHASE_SECTION, getTodoist } from "./todoist.ts";
import {
	REFLECT_RUBRICS,
	archAttackDirective,
	architectDirective,
	architectJudgeDirective,
	attackDirective,
	buildDirective,
	compileDirective,
	fixupDirective,
	injectIsolationCwd,
	intakeDirective,
	logDirective,
	loopDirective,
	loopIterationCost,
	planDirective,
	prototypeDirective,
	prototypeJudgeDirective,
	reflectDirective,
	researchDirective,
	verifyDirective,
} from "./directives.ts";
import { computeTaskMetrics, gatherOverrideCases } from "./metrics.ts";
import type { OverrideCase } from "./metrics.ts";
import { codegraphPreamble } from "./codegraph.ts";
import type { CodegraphState } from "./codegraph.ts";
import { PAUSE_MSG, askCheckPackConfirm, askUiShape, gate } from "./gates.ts";
import type { GateContext } from "./gates.ts";
import { mergeResults, renderCheckReport, runChecks, runStackChecks } from "./checks.ts";
import type { CheckResult } from "./checks.ts";
import { buildManifest, loadManifest, manifestPath, stackPreamble, writeManifest } from "./detect-stack.ts";
import { loadProjectProfile } from "./init.ts";
import { resolveJudge } from "./judge-family.ts";
import {
	VERIFY_DIMENSIONS,
	createState,
	ensureReflectTree,
	ensureWorkTree,
	hypothesisPaths,
	archAttackMarkerOf,
	intakeMarkerOf,
	lintArchitecture,
	lintFrame,
	lintMemo,
	clearPrototypes,
	lintPrototype,
	planWinnerOf,
	promotePlanCandidate,
	prototypeRejectsAll,
	resetPlanArtifacts,
	lintSlices,
	listSliceFiles,
	listTasks,
	loadState,
	prototypeWinnerOf,
	logEvent,
	logGate,
	logRetry,
	nonEmpty,
	readVerifyVerdicts,
	reflectPaths,
	removeFiles,
	saveState,
	sliceArtifacts,
	taskVerdictSummary,
	verdictOf,
	winnerOf,
	workPaths,
} from "./workspace.ts";
import type { Directive, Paths, Phase, ReflectPaths, State } from "./workspace.ts";
import { createWorktree, repoRootOf, removeWorktree, validateWorktree } from "./worktree.ts";
import type { Exec, WorktreeInfo } from "./worktree.ts";

interface Env {
	ctx: GateContext;
	p: Paths;
	cfg: SliceFlowConfig;
	state: State;
	pending: Directive;
	exec?: Exec;
}

/**
 * Startup gateway: decide whether this run is isolated in a git worktree. Only
 * prompts when the project is a git repo (baseline non-null) AND a UI is present
 * (AC11: no prompt on a non-git project; none in unattended runs). On
 * confirmation it creates the worktree and returns it as isolation (AC1/AC2); a
 * declined prompt returns undefined so behavior is identical to pre-feature
 * (AC3). A creation failure is surfaced and returns undefined — a half-made
 * worktree is never recorded (risk #8).
 */
export async function setupWorktree(
	ctx: GateContext,
	exec: Exec,
	cfg: SliceFlowConfig,
	cwd: string,
	slug: string,
	baselineCommit: string | null,
): Promise<{ worktree: WorktreeInfo } | undefined> {
	if (baselineCommit === null || !ctx.hasUI) return undefined;
	const useWorktree = await ctx.ui.confirm(
		"Run in a worktree?",
		`Creates an isolated git worktree under ${cfg.workDir}/../worktrees/${slug}/ on branch slice-flow/${slug}, leaving your current checkout untouched.`,
	);
	if (!useWorktree) return undefined;
	try {
		const worktree = await createWorktree(exec, cwd, slug);
		return { worktree };
	} catch (err) {
		ctx.ui.notify(`Could not create worktree: ${err instanceof Error ? err.message : String(err)}. Continuing in the current checkout.`, "warning");
		return undefined;
	}
}

/**
 * Todoist integration entry point for a run's start: when Todoist is enabled
 * and a UI is present, ask whether to create a new tracking task (the slice
 * 001 push path) or adopt an existing one (the pull path, slice 007). The
 * push path always creates a task in its "Frame" section with
 * `sectionMode: "sections"`. The adopt path resolves + reads an existing task
 * and may seed the run's feature description from it — but because that text is
 * often third-party authored, it only becomes the seed after the operator
 * explicitly approves it (a trust boundary against indirect prompt injection);
 * on decline the task is still adopted but the seed is dropped. It then (slice 008)
 * reconciles the adopted task's project against the 7-section board
 * convention: some sections present ⇒ create only the missing ones and use
 * `sectionMode: "sections"`; none present ⇒ create nothing and fall back to
 * `sectionMode: "comment-only"` so an unconventional project is never
 * restructured. Returns null (and makes no Composio create call) with no UI,
 * when Todoist is disabled, when the client is a no-op, on a dismissed/blank
 * prompt, or on any failure — fail-soft end to end, mirroring setupWorktree.
 * Nothing is persisted here; the caller threads the result into startWorkflow.
 *
 * `mode` (the /feature-todo-* slash commands) pre-answers the create/adopt
 * question: "create" skips straight to the push path's project picker;
 * "pick" lists the projects, then the chosen project's active tasks, and
 * adopts the selected one (no free-text query, no create). Omitted = ask,
 * exactly as before. The returned `title` (adopt paths only) is the adopted
 * task's content, so a /feature-todo-start run can name itself after the task
 * even when the human declines the full text seed.
 */
export async function setupTodoistStart(
	ctx: GateContext,
	cfg: SliceFlowConfig,
	exec: Exec,
	featureTitle: string,
	mode?: "create" | "pick",
): Promise<{ taskId: string; project: string; sectionMode: "sections" | "comment-only"; seed?: string; title?: string } | null> {
	if (!ctx.hasUI || cfg.todoist?.enabled !== true) return null;
	try {
		const client = getTodoist(cfg, exec);
		if (!client.enabled) return null;

		// Adopt tail shared by the free-text query path and the pick path: read the
		// task, gate its pulled text behind an explicit human approval, and
		// reconcile the project's board sections before deciding sectionMode.
		const adopt = async (taskId: string, project: string): Promise<{ taskId: string; project: string; sectionMode: "sections" | "comment-only"; seed?: string; title?: string }> => {
			const info = await client.taskContext(taskId);
			const seed = [info.content, info.description, ...info.comments].map((s) => (s ?? "").trim()).filter(Boolean).join("\n\n");
			// Security trust boundary: an adopted task's content/description/comments
			// are frequently third-party/multi-writer authored (shared Todoist
			// projects, forwarded tasks). Left unchecked this text would flow verbatim
			// into `state.feature` and thus into the intake subagent's directive — an
			// indirect prompt-injection surface. Only let the pulled text seed the run
			// after the operator reviews and explicitly approves it; otherwise the task
			// is still adopted for board tracking but the run keeps its own first-party
			// description (the caller falls back to params.description).
			let approvedSeed: string | undefined;
			if (seed) {
				const useSeed = await ctx.ui.confirm(
					"Use the adopted Todoist task's text as this run's feature description?",
					`This text was pulled from Todoist and may have been written by others; it will be sent to the intake agent verbatim. Approve only if you trust it:\n\n${seed}`,
				);
				if (useSeed) approvedSeed = seed;
			}
			const existing = await client.listSections(project); // fail-soft ⇒ []
			const present = BOARD_SECTIONS.filter((s) => existing.includes(s));
			let sectionMode: "sections" | "comment-only";
			if (present.length === 0) {
				sectionMode = "comment-only"; // no convention present ⇒ don't restructure this project
			} else {
				sectionMode = "sections";
				for (const s of BOARD_SECTIONS) {
					// create only the missing ones
					if (!existing.includes(s)) await client.createSection(project, s);
				}
			}
			const adopted: { taskId: string; project: string; sectionMode: "sections" | "comment-only"; seed?: string; title?: string } = { taskId, project, sectionMode };
			if (approvedSeed) adopted.seed = approvedSeed;
			const title = (info.content ?? "").trim();
			if (title) adopted.title = title;
			return adopted;
		};

		if (mode === "pick") {
			// /feature-todo-start: pick a project, then one of its active tasks, and
			// adopt it. Every dismissed picker and every empty list falls through to
			// null — the run continues without Todoist, same as every other bail here.
			const projects = await client.listProjects();
			if (projects.length === 0) {
				ctx.ui.notify("No Todoist projects found. Continuing without Todoist.", "warning");
				return null;
			}
			const picked = await ctx.ui.select("Todoist project?", projects.map((pr) => pr.name));
			if (picked === undefined) return null;
			const chosen = projects.find((pr) => pr.name === picked);
			if (!chosen) return null;
			const tasks = await client.listTasks(chosen.name);
			if (tasks.length === 0) {
				ctx.ui.notify(`No active tasks in Todoist project "${chosen.name}". Continuing without Todoist.`, "warning");
				return null;
			}
			const pickedTask = await ctx.ui.select("Todoist task to start?", tasks.map((t) => t.content));
			if (pickedTask === undefined) return null;
			const task = tasks.find((t) => t.content === pickedTask);
			if (!task) return null;
			return adopt(task.id, chosen.id);
		}

		const choice =
			mode === "create"
				? "Create a new Todoist task"
				: await ctx.ui.select("Start this run from Todoist?", ["Create a new Todoist task", "Adopt an existing Todoist task"]);
		if (choice === undefined) return null;
		if (choice === "Adopt an existing Todoist task") {
			const query = await ctx.ui.input("Which Todoist task? (name or id)", "Task name or id to adopt, blank to skip Todoist");
			if (!query || !query.trim()) return null;
			const found = await client.findTask(query.trim());
			if (!found) {
				ctx.ui.notify(`Could not find a Todoist task matching "${query.trim()}". Continuing without Todoist.`, "warning");
				return null;
			}
			return adopt(found.taskId, found.project);
		}
		// Pick from EXISTING projects: Todoist project names are not unique and
		// cannot be used as ids, so we resolve to a real project id up front and
		// create the task in the resolved "Frame" section (name -> id in createTask).
		const projects = await client.listProjects();
		if (projects.length === 0) return null;
		const picked = await ctx.ui.select("Todoist project for this run?", projects.map((pr) => pr.name));
		if (picked === undefined) return null;
		const chosen = projects.find((pr) => pr.name === picked);
		if (!chosen) return null;
		const taskId = await client.createTask({ project: chosen.id, section: "Frame", content: featureTitle });
		if (!taskId) return null;
		return { taskId, project: chosen.id, sectionMode: "sections" };
	} catch {
		return null;
	}
}

/**
 * Provision the per-project check-pack at workflow start: probe the stack, build
 * (or refresh) the `.slice-flow/checks/manifest.json` risk profile, and ask the
 * human to confirm it once. Detection is a heuristic and can be wrong, so a
 * security profile is NEVER auto-confirmed — confirmation requires an explicit
 * human "yes" (or a prior confirmation persisted in the manifest). Returns a
 * one-time startup line (or "" when nothing risk-bearing was detected, so quiet
 * repos stay quiet and no file is written). Mirrors `setupWorktree`: an engine
 * function the composition root calls with an interactive `ctx`.
 */
export async function provisionCheckPack(ctx: GateContext, cfg: SliceFlowConfig, cwd: string, detectedAt: string): Promise<string> {
	if (!cfg.checks.enabled) return "";
	const manifest = buildManifest(cwd, detectedAt);
	// Only the universal `secrets` axis and no stack checks → nothing project-
	// specific to confirm; don't litter the repo with a manifest.
	if (manifest.axes.length <= 1 && manifest.checks.length === 0) return "";
	const profile = stackPreamble(manifest.axes, manifest.checks);
	// Confirm once. A prior run's confirmation (preserved by buildManifest) is
	// honored without re-asking. askCheckPackConfirm never auto-confirms — only an
	// explicit human "yes" enables a (possibly-wrong) security profile.
	if (!manifest.confirmed) manifest.confirmed = await askCheckPackConfirm(ctx, profile);
	writeManifest(cwd, manifest);
	return manifest.confirmed ? profile : `${profile} (unconfirmed — checks stay quarantined until you confirm in ${manifestPath(cwd)})`;
}

/** Branch disposition choices offered on completion; the workflow records the
 * user's selection but never performs the merge/PR/push itself. */
const DISPOSITION_OPTIONS = [
	"Manual merge — leave the branch to inspect later",
	"Create a PR",
	"Merge to a local branch",
] as const;

/**
 * On a clean verification pass, dispose of the worktree: validate it, prompt to
 * remove it (refusing a default-remove when work is dirty or unmerged so nothing
 * is silently discarded), and record the user's branch disposition. Never runs
 * any merge/PR/push command — only the choice is persisted. No-op when no
 * worktree is recorded.
 */
export async function finalizeWorktree(env: Env, exec: Exec): Promise<void> {
	const { ctx, p, state } = env;
	const wt = state.isolation?.worktree;
	if (!wt) return;

	const { isClean, isUnmerged } = await validateWorktree(exec, wt.path, state.baselineCommit);
	const unsafe = !isClean || isUnmerged;

	let remove = false;
	if (ctx.hasUI) {
		remove = unsafe
			? await ctx.ui.confirm(
					"Remove the worktree? (NOT recommended)",
					`The worktree at ${wt.path} (branch ${wt.branch}) is dirty or unmerged — removing it discards uncommitted/unmerged work. Confirm explicitly only if you are sure.`,
				)
			: await ctx.ui.confirm(
					"Remove the worktree?",
					`The worktree at ${wt.path} (branch ${wt.branch}) is clean and merged. Remove it now?`,
				);
	}

	const choice = ctx.hasUI ? await ctx.ui.select("How should the feature branch be handled?", [...DISPOSITION_OPTIONS]) : undefined;
	const disposition = choice ?? "manual";
	state.isolation = { worktree: wt, disposition };

	if (remove) {
		try {
			await removeWorktree(exec, repoRootOf(wt), wt.path);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Could not remove worktree at ${wt.path}: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		}
	}
	saveState(p, state);
}

// --- Shared step plumbing ------------------------------------------------------

/** Persist a directive as the pending step and render it for the parent LLM. */
export function issue(p: Paths, state: State, directive: Directive, preamble = ""): string {
	injectIsolationCwd(directive.args, state);
	state.pending = directive;
	logDirective(p, directive);
	logEvent(state, `issued: ${directive.label}`);
	saveState(p, state);
	return [
		preamble,
		`## ${directive.label}`,
		"",
		"Invoke the `subagent` tool now with EXACTLY this input. Do not modify, reorder, summarize, or omit any field:",
		"",
		"```json",
		JSON.stringify(directive.args, null, 2),
		"```",
		"",
		`When the subagent run completes (success or failure), call slice_flow({"action":"next","slug":"${state.slug}"}). Do not do any of the work yourself.`,
		`Full prompt briefs for this step are on disk under ${p.logs}/.`,
	]
		.filter((s) => s !== "")
		.join("\n");
}

/**
 * The single chokepoint for every phase transition: sets `state.phase`, logs a
 * structured `"phase"`-kind line, and enqueues the Todoist board-sync body
 * (added in slices 004-006). A `sectionMode: "sections"` run moves + comments
 * only when the mapped section actually changes; a `sectionMode: "comment-only"`
 * run (slice 008, the pull-path fallback for a project with no board
 * convention) never moves — it enqueues a plain phase+reason comment on every
 * transition instead, so progress is still tracked without restructuring the
 * project. Performs no `await` and no `saveState` — callers remain
 * responsible for persistence, exactly as before slice 002's refactor.
 */
export function transitionPhase(state: State, next: Phase, reason: string, cfg: SliceFlowConfig): void {
	const from = state.phase;
	state.phase = next;
	logEvent(state, `phase ${from} -> ${next}: ${reason}`, "phase");
	const td = state.todoist;
	if (!td?.taskId) return;
	const client = getTodoist(cfg);
	if (!client.enabled) return;
	const fromSec = PHASE_SECTION[from];
	const toSec = PHASE_SECTION[next];
	if (td.sectionMode === "comment-only") {
		client.comment(td.taskId, `${next}: ${reason}`);
	} else if (toSec && toSec !== fromSec) {
		client.move(td.taskId, td.project, toSec);
		client.comment(td.taskId, `Moved to ${toSec}: ${reason}`);
	}
}

export function stopped(p: Paths, state: State, reason: string, cfg: SliceFlowConfig): string {
	transitionPhase(state, "stopped", reason, cfg);
	state.pending = null;
	logEvent(state, `stopped: ${reason}`);
	saveState(p, state);
	const td = state.todoist;
	if (td?.taskId) {
		const client = getTodoist(cfg);
		client.label(td.taskId, "stopped");
		client.comment(td.taskId, `Stopped: ${reason}`);
	}
	const wt = state.isolation?.worktree;
	const worktreeNote = wt
		? ` The worktree at ${wt.path} (branch ${wt.branch}) was left intact — inspect or remove it manually; nothing was auto-removed.`
		: "";
	return `Workflow STOPPED: ${reason}. State preserved at ${p.state}. Report (if any) at ${p.report}.${worktreeNote} Tell the user and end your turn.`;
}

/** Record a gate decision: the structured log entry (override-rate evidence)
 * AND a Langfuse score on the run's trace (1 when the human accepted the judged
 * artifact, 0 otherwise). Both fail-soft; telemetry no-ops when disabled. */
function recordGate(cfg: SliceFlowConfig, state: State, gate: string, decision: string): void {
	logGate(state, gate, decision);
	const traceId = state.telemetry?.traceId;
	if (traceId) {
		getTelemetry(cfg).score({
			id: `${state.slug}:gate:${gate}:${state.seq}`,
			traceId,
			name: `gate-${gate}`,
			value: decision === "approve" ? 1 : 0,
			comment: decision,
		});
	}
}

/** Re-issue the pending directive because its expected artifacts are missing. */
function reissue(env: Env, missing: string): string {
	return issue(env.p, env.state, env.pending, `${missing}. Re-running ${env.pending.label}.`);
}

/**
 * Run an approve/revise/abort gate for the pending step. Returns the final
 * response text when the gate ends the turn (pause, abort, or a revision
 * re-issue), or null when approved and the caller should advance the phase.
 */
async function runGate(env: Env, title: string, artifact: string, onRevise: (notes?: string) => Directive, gateId?: GateName, clean = true): Promise<string | null> {
	const g = await gate(env.ctx, env.cfg, title, artifact, gateId, clean);
	// Tag the decision with the gate id so T3 can pair judge verdicts against
	// human overrides per gate and tune each rubric over time.
	recordGate(env.cfg, env.state, gateId ?? env.pending.kind, g.decision);
	if (g.decision === "pause") return PAUSE_MSG(artifact, env.state.slug);
	if (g.decision === "abort") return stopped(env.p, env.state, `user aborted at ${env.pending.kind} gate`, env.cfg);
	if (g.decision === "revise") {
		logEvent(env.state, `${env.pending.kind} revision requested`);
		return issue(env.p, env.state, onRevise(g.notes), "User requested revisions.");
	}
	return null;
}

// --- Phase 1 (FRAME v2): intake -> explore -> compile -> validate -> gate --------

/** The instructions returned whenever the workflow is in the interactive
 * explore stage. Idempotent: calling `next` with nothing pending repeats it. */
function exploreMessage(p: Paths, slug: string, preamble = ""): string {
	const intakeNote =
		intakeMarkerOf(p.intake) === "QUESTIONS"
			? `The intake check found the description insufficient — open the conversation by asking the user the questions batch in ${p.intake}.`
			: `The intake assessment is at ${p.intake}; read it before you begin.`;
	return [
		preamble,
		"## Phase 1 — FRAME: exploration (interactive)",
		"",
		"You are now the FRAMING PARTNER, not a relay. Load the framing-partner skill and follow it for stance, ledger format, and convergence criteria.",
		"",
		`- ${intakeNote}`,
		`- Think WITH the user: surface assumptions, name the simpler alternative, ask before asserting. Do not rubber-stamp.`,
		`- Maintain the decision ledger at ${p.ledger} throughout: every decision, rejected alternative, open question, and research conclusion, as it happens.`,
		`- Need domain facts or prior art? Call slice_flow({"action":"research","slug":"${slug}","questions":["...", "..."]}) — fresh researcher agents with web access write sourced findings to ${p.frameResearch}/.`,
		`- Draft framing taking shape in the ledger? Call slice_flow({"action":"attack","slug":"${slug}"}) — fresh adversaries try to break it; review the surviving objections with the user.`,
		`- When the user agrees the framing is settled, call slice_flow({"action":"converge","slug":"${slug}"}) — a fresh compiler turns the ledger into ${p.frame}.`,
		"",
		"Unattended run (no user present to converse with)? Then self-explore: write the ledger from the description, the intake assessment, and the code; run one attack round; disposition every objection in the ledger; converge.",
		"",
		"Never write project code, and never write the frame document yourself.",
	]
		.filter((s) => s !== "")
		.join("\n");
}

/** Enter (or re-enter) the explore stage and persist that fact. */
function enterExplore(p: Paths, state: State, preamble = ""): string {
	state.frameStage = "explore";
	state.pending = null;
	saveState(p, state);
	return exploreMessage(p, state.slug, preamble);
}

function assertExplore(state: State, action: string): void {
	if (state.phase !== "frame" || state.frameStage !== "explore") {
		throw new Error(`Action "${action}" is only available during frame exploration (current: phase=${state.phase}, frame stage=${state.frameStage}).`);
	}
	if (state.pending) {
		throw new Error(`A step is already pending (${state.pending.label}). Run it, then call slice_flow({"action":"next","slug":"${state.slug}"}) before "${action}".`);
	}
}

export function startResearch(p: Paths, cfg: SliceFlowConfig, state: State, questions: string[]): string {
	assertExplore(state, "research");
	logEvent(state, `research requested: ${questions.length} question(s)`);
	return issue(p, state, researchDirective(p, state, cfg, questions));
}

export function startAttack(p: Paths, cfg: SliceFlowConfig, state: State): string {
	assertExplore(state, "attack");
	if (!nonEmpty(p.ledger)) {
		throw new Error(`The decision ledger ${p.ledger} is empty — there is no framing to attack yet. Record the draft framing first.`);
	}
	// Skip re-spawning the attack panel when the ledger is byte-identical to the
	// last attacked content: the adversaries would produce the same objections at
	// the cost of attackCount strong-model runs. A ledger edit changes the hash,
	// so this never blocks a genuinely new attack.
	const hash = createHash("sha256").update(readFileSync(p.ledger, "utf8")).digest("hex");
	if (state.lastAttackedLedgerHash === hash) {
		return `The decision ledger is unchanged since the last attack panel ran, so there is nothing new to attack. Edit the ledger — resolve an objection, add a decision, or record new scope — then run attack again, or move on with converge.`;
	}
	state.lastAttackedLedgerHash = hash;
	logEvent(state, "attack panel requested");
	return issue(p, state, attackDirective(p, state, cfg));
}

export function converge(p: Paths, cfg: SliceFlowConfig, state: State): string {
	assertExplore(state, "converge");
	if (!nonEmpty(p.ledger)) {
		throw new Error(`The decision ledger ${p.ledger} is empty. Write it per the framing-partner skill before converging — the compiler builds the frame from the ledger alone.`);
	}
	state.frameStage = "compile";
	state.compileRetries = 0;
	logEvent(state, "explore converged -> compile");
	return issue(p, state, compileDirective(p, state, cfg), "Exploration converged. Compiling the frame from the ledger.");
}

/** Artifacts a research/attack fan-out promised but did not deliver. */
function missingExpected(env: Env): string[] {
	return (env.pending.expects ?? []).filter((f) => !nonEmpty(f));
}

async function onIntake(env: Env): Promise<string> {
	const { p, state } = env;
	if (!nonEmpty(p.intake)) return reissue(env, `The intake assessment ${p.intake} was not produced`);
	logEvent(state, `intake: ${intakeMarkerOf(p.intake) ?? "no marker"}`);
	return enterExplore(p, state, "Intake check complete.");
}

async function onResearch(env: Env): Promise<string> {
	const { p, state, pending } = env;
	const missing = missingExpected(env);
	if (missing.length > 0) return reissue(env, `Research output missing: ${missing.join(", ")}`);
	const files = pending.expects ?? [];
	logEvent(state, `research complete: ${files.length} file(s)`);
	return enterExplore(
		p,
		state,
		[
			"Research complete. Findings:",
			...files.map((f) => `- ${f}`),
			"",
			"Read each file now, give the user a faithful summary of the findings WITH their sources, record the agreed conclusions in the ledger, then continue exploring.",
		].join("\n"),
	);
}

async function onAttack(env: Env): Promise<string> {
	const { p, state, pending } = env;
	const missing = missingExpected(env);
	if (missing.length > 0) return reissue(env, `Attack report missing: ${missing.join(", ")}`);
	const files = pending.expects ?? [];
	logEvent(state, `attack complete: ${files.length} report(s)`);
	return enterExplore(
		p,
		state,
		[
			"Adversarial attack complete. Reports:",
			...files.map((f) => `- ${f}`),
			"",
			"Read each report now and walk the user through the objections. For each: resolve it, accept it as a scope change, or reject it with a reason — and record the outcome in the ledger. Then continue exploring.",
		].join("\n"),
	);
}

async function onFrameCompiled(env: Env): Promise<string> {
	const { ctx, p, cfg, state } = env;
	if (!nonEmpty(p.frame)) return reissue(env, `The frame document ${p.frame} was not produced`);
	const judgeVerdict = verdictOf(p.frameJudgement);
	if (judgeVerdict === null) return reissue(env, `Fidelity judge verdict missing or malformed in ${p.frameJudgement}`);
	const lint = lintFrame(p.frame);

	if (!lint.ok || judgeVerdict === "FAIL") {
		if (state.compileRetries < cfg.maxCompileRetries) {
			state.compileRetries += 1;
			const notes = [
				...lint.findings.map((f) => `lint: ${f}`),
				...(judgeVerdict === "FAIL" ? [`fidelity judge FAILED — full findings in ${p.frameJudgement}`] : []),
			].join("\n");
			logRetry(state, "recompile", `frame validation failed (lint ${lint.ok ? "ok" : "fail"}, judge ${judgeVerdict}) -> recompile ${state.compileRetries}`);
			return issue(
				p,
				state,
				compileDirective(p, state, cfg, notes),
				`Frame failed validation. Recompiling (retry ${state.compileRetries}/${cfg.maxCompileRetries}).`,
			);
		}
		logEvent(state, "frame validation still failing after max recompiles -> surfacing to gate");
	}

	state.frameStage = "gate";
	saveState(p, state);
	const warn =
		!lint.ok || judgeVerdict === "FAIL"
			? ` WARNING: validation still failing after ${cfg.maxCompileRetries} recompiles (lint: ${lint.ok ? "ok" : lint.findings.length + " findings"}, judge: ${judgeVerdict}; see ${p.frameJudgement}).`
			: "";
	const g = await gate(ctx, cfg, `Phase 1 (FRAME) complete — approve the frame?${warn}`, p.frame, "frame", lint.ok && judgeVerdict !== "FAIL");
	recordGate(cfg, state, "frame", g.decision);
	if (g.decision === "pause") return PAUSE_MSG(p.frame, state.slug);
	if (g.decision === "abort") return stopped(p, state, "user aborted at frame gate", cfg);
	if (g.decision === "revise") {
		appendFileSync(p.ledger, `\n## Gate feedback (${new Date().toISOString()})\n\n${g.notes ?? ""}\n`, "utf8");
		logEvent(state, "frame gate: changes requested -> back to explore", "phase");
		return enterExplore(
			p,
			state,
			"The user requested changes at the frame gate. Their feedback was appended to the ledger — work through it with the user, update the ledger, then converge again.",
		);
	}
	transitionPhase(state, "architect", "frame approved", cfg);
	const td = state.todoist;
	if (td?.taskId && !td.attachedFrame) {
		const client = getTodoist(cfg);
		client.attach(td.taskId, p.ledger);
		client.attach(td.taskId, p.frame);
		td.attachedFrame = true;
	}
	return issue(p, state, architectDirective(p, state, cfg), `Frame approved (${p.frame}).`);
}

// --- Phase handlers (2-6) ----------------------------------------------------------

/** Handles both the full architect chain and the judge-only re-run. */
async function onArchitect(env: Env): Promise<string> {
	const { ctx, p, cfg, state, pending } = env;

	// 1. Expected artifacts must exist and be fresh: delete leftovers before a
	// re-issue so this check can never pass on last round's files.
	const missing = missingExpected(env);
	if (missing.length > 0) {
		removeFiles(pending.expects ?? []);
		return reissue(env, `Architect output missing: ${missing.join(", ")}`);
	}

	// 2. Deterministic lint + WINNER marker; failures buy a judge-only retry
	// over the frozen hypotheses (one strong-model run, not a full fan-out).
	const lint = lintArchitecture(p.architecture);
	const winner = winnerOf(p.architecture);
	const valid = lint.ok && winner !== null;
	if (!valid && !state.archApproved) {
		if (state.archRejudgeRetries < cfg.maxArchRejudge) {
			state.archRejudgeRetries += 1;
			const notes = [
				...lint.findings.map((f) => `lint: ${f}`),
				...(winner === null ? [`missing first line "WINNER: hypothesis-<id>"`] : []),
			].join("\n");
			logRetry(state, "re-judge", `architecture lint failed -> re-judge ${state.archRejudgeRetries}/${cfg.maxArchRejudge}`);
			removeFiles([p.architecture]);
			return issue(
				p,
				state,
				architectJudgeDirective(p, state, cfg, notes),
				`Architecture failed lint. Re-judging over existing hypotheses (retry ${state.archRejudgeRetries}/${cfg.maxArchRejudge}).`,
			);
		}
		logEvent(state, "architecture lint still failing after max re-judges -> surfacing to gate");
	}

	// 3. Attack the winning design before the gate (once). The judge picked a
	// winner by comparison; the attack panel tries to break it head-on — the
	// flaw a comparative judge cannot see because every hypothesis shared it.
	if (!state.archApproved && !state.archAttacked) {
		// Clear any prior round's attack reports + dispositions so the panel (and
		// the disposition step, which enumerates the dir) never reads stale
		// objections aimed at a superseded winner.
		const stale = existsSync(p.archAttacks) ? readdirSync(p.archAttacks).map((f) => join(p.archAttacks, f)) : [];
		removeFiles([...stale, p.archDispositions]);
		logEvent(state, "architecture drafted -> attack panel");
		return issue(p, state, archAttackDirective(p, state, cfg), "Architecture drafted. Attacking the winning design before the gate.");
	}
	return architectGateAndAdvance(env);
}

/** The gate + UI-shape + advance tail of phase 2, shared by onArchitect (after
 * the attack panel ran) and onArchAttacked. Recomputes lint/winner so it can be
 * entered from either path. */
async function architectGateAndAdvance(env: Env): Promise<string> {
	const { ctx, p, cfg, state } = env;
	const lint = lintArchitecture(p.architecture);
	const winner = winnerOf(p.architecture);
	const valid = lint.ok && winner !== null;
	const marker = archAttackMarkerOf(p.archDispositions);

	// Gate, with approval persisted BEFORE the UI question so a dismissed dialog
	// never forces a second approval of the same document.
	if (!state.archApproved) {
		const warn =
			(!valid ? ` WARNING: lint still failing after ${cfg.maxArchRejudge} re-judges (${lint.findings.length} findings${winner === null ? ", no WINNER marker" : ""}).` : "") +
			(marker === "RECONSIDER" ? ` WARNING: attack panel says RECONSIDER (see ${p.archDispositions}).` : "");
		const g = await gate(ctx, cfg, `Phase 2 (ARCHITECT) complete — approve the architecture?${warn}`, `${p.architecture} + ${p.archDispositions}`, "architect", valid && marker !== "RECONSIDER");
		recordGate(cfg, state, "architect", g.decision);
		if (g.decision === "pause") return PAUSE_MSG(p.architecture, state.slug);
		if (g.decision === "abort") return stopped(p, state, "user aborted at architect gate", cfg);
		if (g.decision === "revise") {
			state.archRejudgeRetries = 0;
			state.archReconsiderRetries = 0;
			state.archAttacked = false; // re-attack the revised winner
			logEvent(state, "architect revision requested");
			// Route the revision to what actually needs to change: the judge's
			// selection/synthesis (cheap) or the hypothesis designs (full re-run).
			const scope = ctx.hasUI
				? await ctx.ui.select("What should the revision change?", [
						"The selection or synthesis — re-judge the existing 3 hypotheses",
						"The designs themselves — regenerate hypotheses and re-judge",
					])
				: undefined;
			if (scope === undefined) return PAUSE_MSG(p.architecture, state.slug);
			if (scope.startsWith("The selection")) {
				state.archRejudgeRetries += 1;
				removeFiles([p.architecture]);
				return issue(p, state, architectJudgeDirective(p, state, cfg, g.notes), "User requested revisions (re-judge only).");
			}
			removeFiles([...hypothesisPaths(p), p.architecture]);
			return issue(p, state, architectDirective(p, state, cfg, g.notes), "User requested revisions (full re-run).");
		}
		state.archApproved = true;
		state.archWinner = winner;
		logEvent(state, `architecture approved (winner: ${winner ?? "unmarked"})`);
		saveState(p, state);
	}

	// UI shape decides whether phase 3 starts with prototypes.
	if (state.ui === null) {
		const shape = await askUiShape(ctx, cfg);
		if (shape === null) return PAUSE_MSG("the UI question (interactive session required)", state.slug);
		state.ui = shape;
	}
	logEvent(state, `ui=${state.ui}`);
	if (state.ui === "greenfield") {
		transitionPhase(state, "prototype", "architecture approved; greenfield prototyping", cfg);
		attachArchDoc(state, p, cfg);
		return issue(p, state, prototypeDirective(p, state, cfg), "Architecture approved. Greenfield UI: prototyping first.");
	}
	transitionPhase(state, "plan", "architecture approved", cfg);
	attachArchDoc(state, p, cfg);
	return issue(p, state, planDirective(p, state, cfg), "Architecture approved.");
}

/** Attach 02-architecture.md once, guarded by `attachedArch`, on either
 * architect-phase exit (greenfield -> prototype, or -> plan). Independent of
 * the section-move skip: the greenfield exit doesn't change section, but the
 * doc must still attach. */
function attachArchDoc(state: State, p: Paths, cfg: SliceFlowConfig): void {
	const td = state.todoist;
	if (td?.taskId && !td.attachedArch) {
		getTodoist(cfg).attach(td.taskId, p.architecture);
		td.attachedArch = true;
	}
}

/** The attack panel completed: validate its output, route a RECONSIDER through
 * a bounded full re-run (regenerate the hypotheses with the attack findings),
 * then gate. */
async function onArchAttacked(env: Env): Promise<string> {
	const { p, cfg, state } = env;
	const missing = missingExpected(env);
	if (missing.length > 0) return reissue(env, `Attack panel output missing: ${missing.join(", ")}`);
	const marker = archAttackMarkerOf(p.archDispositions);
	if (marker === null) return reissue(env, `Attack disposition marker missing/malformed in ${p.archDispositions}`);

	if (marker === "RECONSIDER" && state.archReconsiderRetries < cfg.maxArchReconsider) {
		state.archReconsiderRetries += 1;
		state.archAttacked = false; // re-attack the regenerated winner
		// Full re-run, not a re-judge: the attack panel exists to catch a flaw the
		// hypotheses SHARE, and re-selecting among the same three cannot answer
		// that. Regenerate the hypotheses with the attack findings as notes.
		removeFiles([...hypothesisPaths(p), p.architecture]);
		logRetry(state, "reconsider", `arch attack RECONSIDER -> full re-run (regenerate hypotheses) ${state.archReconsiderRetries}/${cfg.maxArchReconsider}`);
		return issue(
			p,
			state,
			architectDirective(p, state, cfg, `The attack panel returned RECONSIDER — full findings in ${p.archDispositions}. Regenerate the hypotheses to answer these objections.`),
			`Attack panel flagged RECONSIDER. Regenerating hypotheses (retry ${state.archReconsiderRetries}/${cfg.maxArchReconsider}).`,
		);
	}
	state.archAttacked = true;
	logEvent(state, marker === "RECONSIDER" ? "arch attack still RECONSIDER after max re-judges -> surfacing to gate" : "arch attack HOLDS");
	saveState(p, state);
	return architectGateAndAdvance(env);
}

async function onPrototype(env: Env): Promise<string> {
	const { p, cfg, state } = env;
	const judgement = join(p.prototypes, "JUDGEMENT.md");
	if (!nonEmpty(judgement)) return reissue(env, "Prototype judgement missing");

	// Reject-all floor: the judge may declare the whole slate inadequate
	// (`WINNER: NONE-ACCEPTABLE`). Mirror the architecture RECONSIDER path — a
	// bounded full REGENERATE of the prototypes, never an auto-adopted weak
	// winner. Only after the budget is spent does it surface to the human gate.
	if (prototypeRejectsAll(judgement)) {
		if (state.prototypeRetries < cfg.maxPrototypeRetries) {
			state.prototypeRetries += 1;
			logRetry(state, "reconsider", `prototype judge: NONE-ACCEPTABLE -> regenerate prototypes ${state.prototypeRetries}/${cfg.maxPrototypeRetries}`);
			clearPrototypes(p);
			removeFiles([judgement]);
			return issue(p, state, prototypeDirective(p, state, cfg), `Prototype judge found none acceptable. Regenerating ${cfg.prototypeCount} prototypes (retry ${state.prototypeRetries}/${cfg.maxPrototypeRetries}).`);
		}
		logEvent(state, "prototype NONE-ACCEPTABLE after max regenerations -> surfacing to gate", "phase");
	}

	// Lint the judgement (parseable WINNER naming a real proto dir with a README);
	// a malformed judgement buys a bounded judge-only re-run over the frozen
	// prototypes before a human sees it.
	const lint = lintPrototype(p);
	if (!lint.ok && state.prototypeRetries < cfg.maxPrototypeRetries) {
		state.prototypeRetries += 1;
		const notes = lint.findings.map((f) => `lint: ${f}`).join("\n");
		logRetry(state, "re-judge", `prototype lint failed -> re-judge ${state.prototypeRetries}/${cfg.maxPrototypeRetries}`);
		return issue(p, state, prototypeJudgeDirective(p, state, cfg, notes), `Prototype judgement failed lint. Re-judging (retry ${state.prototypeRetries}/${cfg.maxPrototypeRetries}).`);
	}
	if (!lint.ok) logEvent(state, "prototype lint still failing after max re-judges -> surfacing to gate");

	// Human gate on the winning UI direction — a removable overlay (autonomy
	// .prototype) over the refute-stance judge. A revise re-judges with notes.
	const warn = lint.ok ? "" : ` WARNING: prototype judgement lint failing (${lint.findings.join("; ")}).`;
	const gated = await runGate(
		env,
		`Phase 3a (PROTOTYPE) — approve the winning UI direction?${warn}`,
		judgement,
		(notes) => {
			state.prototypeRetries = 0; // a human revise reopens the bounded re-judge budget
			return prototypeJudgeDirective(p, state, cfg, notes);
		},
		"prototype",
		lint.ok,
	);
	if (gated !== null) return gated;
	transitionPhase(state, "plan", "prototype winner approved", cfg);
	return issue(p, state, planDirective(p, state, cfg), `Prototype winner recorded in ${judgement}.`);
}

async function onPlan(env: Env): Promise<string> {
	const { ctx, p, cfg, state } = env;
	const divergent = (cfg.planCount ?? 1) > 1;

	// Divergence: promote the selected candidate into the canonical plan/slices
	// the lint/verdict/gate (and every builder) read, BEFORE those checks. The
	// guard (`!nonEmpty(p.plan)`) makes this idempotent and skips the single-plan
	// path entirely.
	if (divergent && nonEmpty(p.planJudgement) && !nonEmpty(p.plan)) {
		const winner = planWinnerOf(p.planJudgement);
		if (winner === null) return reissue(env, `Plan selector verdict is missing its "WINNER: plan-<n>" marker in ${p.planJudgement}`);
		if (!promotePlanCandidate(p, winner)) return reissue(env, `Selected ${winner} is missing its plan.md or slice files under ${p.root}`);
		logEvent(state, `plan candidate selected: ${winner}`, "phase");
	}

	const sliceFiles = listSliceFiles(p);
	if (!nonEmpty(p.plan) || sliceFiles.length === 0) {
		return reissue(env, `Plan or slice files missing (found ${sliceFiles.length} slices in ${p.slices})`);
	}

	// Deterministic slice lint (numbering, sections, forward deps) and the
	// adversarial plan judge (coverage, scope inflation, MVP, arch fidelity)
	// together gate the plan, buying a bounded auto-replan before any human sees
	// it — mirrors the frame recompile loop.
	const lint = lintSlices(p);
	const judgeVerdict = verdictOf(p.planJudgement);
	if (judgeVerdict === null) return reissue(env, `Plan judge verdict missing or malformed in ${p.planJudgement}`);
	const valid = lint.ok && judgeVerdict === "PASS";
	if (!valid && state.planRetries < cfg.maxPlanRetries) {
		state.planRetries += 1;
		const notes = [
			...lint.findings.map((f) => `lint: ${f}`),
			...(judgeVerdict === "FAIL" ? [`plan judge FAILED — full findings in ${p.planJudgement}`] : []),
		].join("\n");
		logRetry(state, "replan", `plan validation failed (lint ${lint.ok ? "ok" : "fail"}, judge ${judgeVerdict}) -> replan ${state.planRetries}/${cfg.maxPlanRetries}`);
		// Clear the rejected slice files first so a replan that writes fewer or
		// renamed slices cannot leave orphans that pass the next lint and get
		// built from a discarded plan (the invariant onArchitect also upholds).
		// In divergence mode this also drops the canonical plan + selector
		// judgement + candidate dirs so the next round re-promotes cleanly.
		resetPlanArtifacts(p, divergent);
		return issue(p, state, planDirective(p, state, cfg, notes), `Plan failed validation. Replanning (retry ${state.planRetries}/${cfg.maxPlanRetries}).`);
	}
	if (!valid) logEvent(state, "plan validation still failing after max replans -> surfacing to gate");
	if (ctx.hasUI) ctx.ui.notify(`Slices: ${sliceFiles.join(", ")}`, "info");
	const lintWarn = valid ? "" : ` WARNING: plan validation still failing after ${cfg.maxPlanRetries} replans (lint: ${lint.ok ? "ok" : lint.findings.length + " findings"}, judge: ${judgeVerdict}; see ${p.planJudgement}).`;
	const gated = await runGate(
		env,
		`Phase 3 (PLAN) complete — approve the ${sliceFiles.length} slices?${lintWarn}`,
		`${p.plan} and ${p.slices}/`,
		(notes) => {
			state.planRetries = 0; // a human revise reopens the bounded lint-replan budget
			resetPlanArtifacts(p, divergent); // discard the rejected plan/slices before re-planning
			return planDirective(p, state, cfg, notes);
		},
		"plan",
		valid,
	);
	if (gated !== null) return gated;
	state.slices = sliceFiles;
	state.sliceIndex = 0;
	state.fixupRound = 0;
	transitionPhase(state, "implement", "plan approved", cfg);
	return issue(p, state, buildDirective(p, state, cfg), `Plan approved: ${sliceFiles.length} slices.`);
}

/** Shared by `build` and `fixup`: judge the review verdict, then advance. */
async function onSliceReviewed(env: Env): Promise<string> {
	const { ctx, p, cfg, state } = env;
	const a = sliceArtifacts(p, state);
	if (!nonEmpty(a.memoPath)) return reissue(env, `Memo ${a.memoPath} missing — the builder did not complete its contract`);

	// Deterministic memo-format lint, logged as a signal only. The memo is
	// load-bearing for later builders, but re-running the whole build to fix a
	// heading is disproportionate (it risks duplicate commits and duplicate
	// fix-up sections), so a malformed memo is surfaced to the event log and the
	// reviewer (reviewer-solid already blocks a memo that lies) rather than
	// triggering a rebuild.
	const memoLint = lintMemo(a.memoPath, cfg.autoCommit);
	if (!memoLint.ok) logEvent(state, `${a.sliceId} memo format lint: ${memoLint.findings.join("; ")}`);
	const verdict = verdictOf(a.reviewPath);
	if (verdict === null) return reissue(env, `Review verdict missing or malformed in ${a.reviewPath}`);

	if (verdict === "FAIL") {
		if (state.fixupRound < cfg.maxFixupsPerSlice) {
			state.fixupRound += 1;
			logRetry(state, "fixup", `${a.sliceId} review FAIL -> fix-up round ${state.fixupRound}`);
			return issue(p, state, fixupDirective(p, state, cfg), `Review of ${a.sliceId} FAILED (${a.reviewPath}). Spawning scoped fix-up.`);
		}
		if (!ctx.hasUI) return stopped(p, state, `${a.sliceId} still failing review after ${cfg.maxFixupsPerSlice} fix-ups`, cfg);
		const choice = await ctx.ui.select(
			`${a.sliceId} still FAILS review after ${cfg.maxFixupsPerSlice} fix-up rounds. (See ${a.reviewPath})`,
			["Run one more fix-up round", "Accept the slice anyway and continue", "Abort workflow"],
		);
		if (choice === undefined) return PAUSE_MSG(a.reviewPath, state.slug);
		if (choice === "Abort workflow") return stopped(p, state, `user aborted: ${a.sliceId} failing review`, cfg);
		if (choice === "Run one more fix-up round") {
			state.fixupRound += 1;
			return issue(p, state, fixupDirective(p, state, cfg), "User requested another fix-up round.");
		}
		logEvent(state, `${a.sliceId} accepted by user despite FAIL`);
	} else {
		logEvent(state, `${a.sliceId} review PASS (round ${state.fixupRound})`);
	}

	// Advance to the next slice or to verification.
	state.sliceIndex += 1;
	state.fixupRound = 0;
	if (state.sliceIndex < state.slices.length) {
		return issue(p, state, buildDirective(p, state, cfg), `${a.sliceId} complete.`);
	}
	transitionPhase(state, "verify", "all slices complete", cfg);
	return issue(p, state, verifyDirective(p, state, cfg), "All slices complete. Running independent verification.");
}

/** Shared by `verify` and `loop-fix`: read verdicts, finish or keep looping. */
/**
 * Run the deterministic check-pack (Tier-A universal oracles) over the audited
 * tree and persist verify/check-pack.md as provenance. These run with NO model
 * in the loop, so they catch blind spots a same-family verifier panel shares.
 * Returns null when checks are disabled or no Exec is available — both are
 * graceful no-ops that never block, mirroring the worktree `if (env.exec)` guard.
 */
async function runCheckPack(env: Env): Promise<CheckResult | null> {
	const { p, cfg, state, exec } = env;
	if (!cfg.checks.enabled) return null;
	mkdirSync(p.verify, { recursive: true });
	// Audit the worktree when isolated, else the project root the engine runs in.
	const cwd = state.isolation?.worktree?.cwd ?? process.cwd();
	// Tier-A universal oracles need a command runner; without one they are a
	// graceful skip (mirroring the worktree `if (env.exec)` guard).
	const oracleResult: CheckResult = exec
		? await runChecks(exec, cwd, cfg.checks.oracles)
		: { ok: true, findings: [], skipped: ["all oracles (no command runner in this run)"] };
	// Tier-B stack checks are pure fs scanners — they run with or without an Exec.
	// Only a human-confirmed profile may enforce: an unconfirmed manifest is
	// surfaced as a skip so a detection mistake never gates silently.
	const manifest = loadManifest(cwd);
	const stackResult: CheckResult = manifest?.confirmed
		? await runStackChecks(cwd, manifest.checks)
		: { ok: true, findings: [], skipped: manifest ? ["stack checks (risk profile not yet confirmed — see .slice-flow/checks/manifest.json)"] : [] };
	const result = mergeResults(oracleResult, stackResult);
	writeFileSync(join(p.verify, "check-pack.md"), renderCheckReport(result), "utf8");
	if (result.skipped.length) logEvent(state, `check-pack skipped: ${result.skipped.join(", ")}`);
	if (!result.ok) logEvent(state, `check-pack FAIL: ${result.findings.length} finding(s)`);
	return result;
}

async function onVerified(env: Env): Promise<string> {
	const { p, cfg, state, pending } = env;
	const verdicts = readVerifyVerdicts(p);
	const missing = VERIFY_DIMENSIONS.filter((d) => verdicts[d] === null);
	if (pending.kind === "verify" && missing.length > 0) {
		return reissue(env, `Verifier output missing/malformed for: ${missing.join(", ")}`);
	}
	// After a loop iteration, missing verdicts count as failures.
	const failed = VERIFY_DIMENSIONS.filter((d) => verdicts[d] !== "PASS");
	if (failed.length === 0) {
		// Deterministic check-pack runs at the moment the model verifiers would
		// declare the feature done — the highest-leverage point to catch a blind
		// spot they jointly missed. In "block" mode a finding stops the run; in
		// "warn" mode (default) it rides along on the completion gate as a notice.
		const check = await runCheckPack(env);
		if (check && !check.ok && cfg.checks.mode === "block") {
			return stopped(p, state, `check-pack FAILED (block mode): ${check.findings.join("; ")}. See ${join(p.verify, "check-pack.md")}`, cfg);
		}
		const checkWarn = check && !check.ok ? ` — note: check-pack found ${check.findings.length} issue(s) (warn mode; see ${join(p.verify, "check-pack.md")})` : "";
		// Completion gate: the 5 refute verifiers are the mechanism; this gate is a
		// removable overlay. autonomy.verify="auto" (or autoApprove) advances
		// headless; "human" asks before declaring the feature done. A warn-mode
		// check-pack finding marks the artifact not-clean so the human still sees it.
		const g = await gate(env.ctx, cfg, `Verification clean on all 5 dimensions — accept and finish?${checkWarn}`, `${p.verify}/`, "verify", checkWarn === "");
		recordGate(cfg, state, "verify", g.decision);
		if (g.decision === "pause") return PAUSE_MSG(`${p.verify}/`, state.slug);
		if (g.decision === "abort") return stopped(p, state, "user aborted at verify completion gate", cfg);
		if (g.decision === "revise") {
			// All dimensions pass, so there is no failed dimension to loop on. Record
			// the feedback and stop deterministically rather than spinning an empty
			// loop — the human re-runs /feature or opens a follow-up task.
			if (g.notes) appendFileSync(join(p.verify, "_gate-feedback.md"), `\n## Completion gate feedback (${new Date().toISOString()})\n\n${g.notes}\n`, "utf8");
			return stopped(p, state, `human requested changes at the verify completion gate; feedback recorded in ${p.verify}/_gate-feedback.md`, cfg);
		} else {
			transitionPhase(state, "done", "clean verification pass", cfg);
			state.pending = null;
			saveState(p, state);
		const td = state.todoist;
		if (td?.taskId) getTodoist(cfg).close(td.taskId);
		// Dispose of the worktree (validate, prompt removal, record disposition)
		// before telling the user the workflow is complete. Guarded so the
		// many existing no-exec callers and worktree-less tasks are unaffected.
		if (env.exec) await finalizeWorktree(env, env.exec);
		return [
			"## Workflow COMPLETE — clean verification pass on all 5 dimensions.",
			"",
			`- Frame: ${p.frame}`,
			`- Architecture: ${p.architecture}`,
			`- Plan: ${p.plan} (${state.slices.length} slices)`,
			`- Verification: ${p.verify}/`,
			state.realCost > 0
				? `- Real cost across spawned agents: $${state.realCost.toFixed(4)} (${state.realInputTokens + state.realOutputTokens} tokens)`
				: `- Observed agent I/O (chars/4, not model tokens): ~${state.tokensSpent}`,
			"",
				"Summarize the feature work for the user and end your turn.",
			].join("\n");
		}
	}

	if (state.phase !== "loop") {
		transitionPhase(state, "loop", state.failedDimensions.join(", ") || "verification failed", cfg);
		state.loopIteration = 0;
		state.loopStartTokens = state.tokensSpent;
		state.loopCost = 0;
	}
	state.failedDimensions = failed;
	if (state.loopIteration >= cfg.maxLoopIterations) {
		writeBreachReport(p, state, cfg, `max loop iterations (${cfg.maxLoopIterations}) reached`);
		return stopped(p, state, `loop limit reached with FAIL on: ${failed.join(", ")}. Report written to ${p.report}`, cfg);
	}
	// Account for the iteration about to be issued before spawning it: the fixer
	// and verifier counts and models are fully known here, so the weighted spawn
	// cost is deterministic — stop *before* overspending, not after.
	const iterationCost = loopIterationCost(state, cfg);
	if (state.loopCost + iterationCost > cfg.loopCostBudget) {
		const projected = state.loopCost + iterationCost;
		writeBreachReport(p, state, cfg, `loop cost budget exceeded (~${projected.toFixed(1)} > ${cfg.loopCostBudget} opus-equivalent spawns)`);
		return stopped(p, state, `loop cost budget exceeded with FAIL on: ${failed.join(", ")}. Report written to ${p.report}`, cfg);
	}
	state.loopCost += iterationCost;
	state.loopIteration += 1;
	logRetry(state, "loop", `loop iteration ${state.loopIteration}: FAIL on ${failed.join(", ")}`);
	// Clear the verdict files for every dimension the upcoming loop will
	// re-verify, so a verifier that crashes or returns nothing leaves the file
	// absent (read as a failure that keeps looping) instead of leaving a stale
	// PASS that could let onVerified declare `done` on pre-fix evidence.
	const reVerifyDims = cfg.reverifyAllInLoop ? VERIFY_DIMENSIONS : failed;
	removeFiles(reVerifyDims.map((dim) => join(p.verify, `${dim}.md`)));
	return issue(
		p,
		state,
		loopDirective(p, state, cfg),
		`Verification FAILED on: ${failed.join(", ")}. Loop iteration ${state.loopIteration}/${cfg.maxLoopIterations} (loop cost ~${state.loopCost.toFixed(1)}/${cfg.loopCostBudget} spawns).`,
	);
}

const HANDLERS: Record<string, (env: Env) => Promise<string>> = {
	intake: onIntake,
	research: onResearch,
	attack: onAttack,
	"frame-compile": onFrameCompiled,
	architect: onArchitect,
	"architect-judge": onArchitect,
	"arch-attack": onArchAttacked,
	prototype: onPrototype,
	"prototype-judge": onPrototype,
	plan: onPlan,
	build: onSliceReviewed,
	fixup: onSliceReviewed,
	verify: onVerified,
	"loop-fix": onVerified,
};

// --- Public entry points -----------------------------------------------------------

/** Absolute path to the package's bundled `agents/` directory. This module
 * lives at <pkg>/extensions/lib/engine.ts, so the bundle is two levels up. */
const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

/** Provision slice-flow's six dedicated agents into the project's discovered
 * directory (<cwd>/.pi/agents/). pi's package manager has no "agents" resource
 * type, so the bundled `agents/` directory is NOT auto-installed on `pi install`;
 * this is the real install path. Runs on every workflow start, copying any
 * bundled `*.md` agent that is missing from the target (existing copies are left
 * untouched so a user's customizations survive). Returns the file names newly
 * provisioned; a no-op returning [] when the bundle itself is unavailable
 * (a genuinely broken install, which the preflight then reports). */
export function syncBundledAgents(cwd: string, bundleDir: string = BUNDLED_AGENTS_DIR): string[] {
	if (!existsSync(bundleDir)) return [];
	const targetDir = join(cwd, ".pi", "agents");
	mkdirSync(targetDir, { recursive: true });
	const provisioned: string[] = [];
	for (const file of readdirSync(bundleDir)) {
		if (!file.endsWith(".md")) continue;
		const dest = join(targetDir, file);
		if (existsSync(dest)) continue;
		copyFileSync(join(bundleDir, file), dest);
		provisioned.push(file);
	}
	return provisioned;
}

/** Hard-fail before any phase if a required agent file is absent from the
 * project's discovered agent directory (.pi/agents/), naming each missing one. */
export function preflightAgents(cwd: string, cfg: SliceFlowConfig): void {
	const agentsDir = join(cwd, ".pi", "agents");
	const required = [...new Set(Object.values(cfg.agents))];
	const missing = required.filter((name) => !existsSync(join(agentsDir, `${name}.md`)));
	if (missing.length > 0) {
		throw new Error(
			`slice-flow preflight failed: required agent(s) not found in ${agentsDir}: ` +
				`${missing.join(", ")}. They are bundled in slice-flow/agents/ and must be ` +
				`installed into .pi/agents/ — re-run the package install/sync.`,
		);
	}
}

// --- Self-improvement: reflect on judge rubrics from override cases (T3b) -----

/** The on-disk artifacts a given gate's judge produced, so the reflection agent
 * can read the actual documents the human overrode (not just the counts). */
function gateArtifacts(p: Paths, gate: string): string[] {
	switch (gate) {
		case "architect":
			return [p.architecture, p.archDispositions];
		case "prototype":
			return [join(p.prototypes, "JUDGEMENT.md")];
		case "plan":
			return [p.plan, p.planJudgement];
		case "verify":
			return [`${p.verify}/`];
		default:
			return [];
	}
}

/** Compile the override cases for one judge into a human- and agent-readable
 * markdown file: per overriding task, the gate decision counts, the override
 * rate, and pointers to the artifacts the judge produced so the reflection
 * agent can inspect what the human disagreed with. Pure formatting over the
 * gathered cases plus per-task paths. */
function renderCasesFile(cwd: string, cfg: SliceFlowConfig, gate: string, cases: OverrideCase[]): string {
	const lines = [`# Override cases — ${gate} gate`, ""];
	if (cases.length === 0) {
		lines.push(`No human-override cases recorded for the ${gate} gate across the tasks under ${cfg.workDir}/.`);
		lines.push("");
		lines.push("There is no disagreement signal to learn from yet; no rubric edits should be proposed.");
		return lines.join("\n");
	}
	lines.push(`${cases.length} task(s) where a human did not accept the judged artifact as-is. For each, read the listed artifacts and compare the judge's verdict against the human's decision.`);
	lines.push("");
	for (const c of cases) {
		const p = workPaths(cwd, cfg.workDir, c.slug);
		lines.push(`## ${c.slug}`);
		lines.push("");
		lines.push(`- decisions: approve=${c.approve}, revise=${c.revise}, abort=${c.abort}, pause=${c.pause}`);
		lines.push(`- override rate: ${(c.overrideRate * 100).toFixed(0)}%`);
		lines.push(`- artifacts the judge produced:`);
		for (const a of gateArtifacts(p, gate)) lines.push(`  - ${a}`);
		const overrideEvents = overrideLogLines(cwd, cfg, c.slug, gate).map((e) => `  - ${e}`);
		if (overrideEvents.length > 0) {
			lines.push(`- relevant log events:`);
			lines.push(...overrideEvents);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** Log lines for a task that bear on the given gate's override decision. */
function overrideLogLines(cwd: string, cfg: SliceFlowConfig, slug: string, gate: string): string[] {
	const p = workPaths(cwd, cfg.workDir, slug);
	const state = loadState(p);
	if (!state) return [];
	return state.log
		.map((e) => e.event)
		.filter((e) => e.includes(`gate ${gate}:`) || e.startsWith(`${gate} revision`) || (gate === "frame" && e.startsWith("frame gate:")));
}

/**
 * Cross-run self-improvement entry point: for the requested judge (or all
 * judges with a tunable rubric), mine the human-override cases from every task
 * via the T3a metrics, write them to reflect/<judge>-cases.md, and return the
 * subagent directives that spawn a fresh oracle-judge to propose rubric edits
 * into reflect/<judge>-proposals.md. Read-only over task state; it writes only
 * under the reflect workdir and proposes diffs — it edits no skill or source.
 */
export function startReflect(cwd: string, cfg: SliceFlowConfig, judge?: string): string {
	const judges = judge ? [judge] : Object.keys(REFLECT_RUBRICS);
	for (const j of judges) {
		if (!REFLECT_RUBRICS[j]) throw new Error(`Unknown reflect judge "${j}". Known: ${Object.keys(REFLECT_RUBRICS).join(", ")}.`);
	}
	const r: ReflectPaths = reflectPaths(cwd, cfg.workDir);
	ensureReflectTree(r);
	const tasks = listTasks(cwd, cfg.workDir);
	const metrics = tasks.map((t) => computeTaskMetrics(t.state, taskVerdictSummary(workPaths(cwd, cfg.workDir, t.slug))));

	const directives: Directive[] = [];
	const empty: string[] = [];
	let seq = 1;
	for (const j of judges) {
		const cases = gatherOverrideCases(metrics, j);
		writeFileSync(r.casesOf(j), renderCasesFile(cwd, cfg, j, cases), "utf8");
		if (cases.length === 0) {
			empty.push(j);
			continue;
		}
		const d = reflectDirective(r, cfg, j, seq);
		seq += 1;
		logDirectiveTo(r, d);
		directives.push(d);
	}

	if (directives.length === 0) {
		return [
			`No human-override cases were found for: ${judges.join(", ")}.`,
			`Compiled (empty) case files are under ${r.root}/. There is no disagreement signal to learn from yet, so no reflection was spawned.`,
			"A gate earns a rubric proposal only once a human has overridden its judge at least once. Tell the user and end your turn.",
		].join("\n");
	}

	const blocks = directives.map((d) =>
		[
			`### ${d.label}`,
			"",
			"Invoke the `subagent` tool with EXACTLY this input (do not modify any field):",
			"",
			"```json",
			JSON.stringify(d.args, null, 2),
			"```",
			`Proposals will be written to ${(d.expects ?? [])[0]} for human review.`,
		].join("\n"),
	);

	return [
		`## Reflection — proposing rubric edits from override cases`,
		"",
		`Override cases compiled under ${r.root}/. Run the ${directives.length} reflection agent(s) below.` +
			(empty.length ? ` (No override cases for: ${empty.join(", ")} — skipped.)` : ""),
		"",
		...blocks,
		"",
		"These agents PROPOSE rubric edits only; nothing is applied automatically. When they finish, read each proposals file and relay the suggested diffs to the user for review and manual application. Then end your turn.",
	].join("\n");
}

/** Log a reflect directive under the reflect workdir for inspectability
 * (mirrors logDirective, which is task-scoped). */
function logDirectiveTo(r: ReflectPaths, directive: Directive): void {
	writeFileSync(
		join(r.logs, `${String(directive.seq).padStart(3, "0")}-directive-${directive.kind}-${directive.label.replace(/[^a-z0-9]+/gi, "-")}.json`),
		JSON.stringify({ ts: new Date().toISOString(), ...directive }, null, 2),
		"utf8",
	);
}

export function startWorkflow(
	p: Paths,
	cfg: SliceFlowConfig,
	feature: string,
	slug: string,
	baselineCommit: string | null,
	cwd: string,
	codegraphState: CodegraphState = "silent",
	isolation?: { worktree?: WorktreeInfo },
	judgeFamilies: string[] = ["claude"],
	todoist?: { taskId: string; project: string; sectionMode: "sections" | "comment-only" },
): string {
	syncBundledAgents(cwd);
	preflightAgents(cwd, cfg);
	ensureWorkTree(p);
	const state = createState(feature, slug, baselineCommit, isolation);
	if (todoist) state.todoist = { ...todoist, attachedFrame: false, attachedArch: false };
	state.codegraphReady = codegraphState === "ready";
	// Surface the confirmed check-pack risk profile to the plan judge (phase 3):
	// a confirmed manifest's live axes become the coverage lens; an unconfirmed or
	// absent profile leaves liveAxes empty (the judge runs exactly as before).
	const auditCwd = isolation?.worktree?.cwd ?? cwd;
	const manifest = loadManifest(auditCwd);
	state.liveAxes = manifest?.confirmed ? manifest.axes : [];
	// Per-project profile (.slice-flow/PROJECT.md from `slice-flow init`). Read
	// from the main checkout, not the worktree: the profile may be authored but
	// not yet committed, so a HEAD-branched worktree would not contain it. Feeds
	// the intake/architect/build/review briefs (briefs.ts projectProfileClause).
	const profile = loadProjectProfile(cwd);
	if (profile) state.projectProfile = profile;
	state.judgeFamilies = judgeFamilies;
	state.telemetry = { traceId: randomUUID() };
	logEvent(state, `started: ${state.feature}`, "lifecycle");
	getTelemetry(cfg).trace({ id: state.telemetry.traceId, name: feature, sessionId: slug, metadata: { phase: state.phase, slug } });
	const cgLine = codegraphPreamble(codegraphState);
	// One-time self-preference caveat, logged for provenance (not surfaced in the
	// start banner: in the common Claude-only case it would fire on every run).
	// When cross-family judging is wanted but only the host family is present,
	// record that the bias is mitigated by position-swap alone.
	const at0 = (s: SliceFlowConfig["models"]["verify"]) => (Array.isArray(s) ? (s[0] ?? null) : s);
	const judgeCaveat = resolveJudge(at0(cfg.models.verify), at0(cfg.models.build), new Set(judgeFamilies), cfg.judgeFamily ?? "cross").caveat;
	if (judgeCaveat) logEvent(state, `judge family: ${judgeCaveat}`);
	return issue(
		p,
		state,
		intakeDirective(p, state, cfg),
		`slice-flow started. Task slug: ${slug} (folder ${p.root}). Pass "slug":"${slug}" on every follow-up slice_flow call. Baseline commit: ${baselineCommit ?? "(not a git repo)"}.` +
			(cgLine ? `\n${cgLine}` : ""),
	);
}

export async function nextStep(ctx: GateContext, p: Paths, cfg: SliceFlowConfig, state: State, exec?: Exec): Promise<string> {
	getTodoist(cfg, exec);
	if (state.phase === "done") return `Workflow already complete. Final docs are under ${p.root}/.`;
	if (state.phase === "stopped") return `Workflow is stopped. Start fresh with /feature after clearing ${p.root}, or inspect ${p.report}.`;
	const pending = state.pending;
	// The explore stage is interactive and has no pending directive; `next` just
	// repeats the partner instructions (e.g. after /feature-resume).
	if (!pending && state.phase === "frame" && state.frameStage === "explore") return exploreMessage(p, state.slug);
	if (!pending) return stopped(p, state, "internal error: no pending directive", cfg);
	const handler = HANDLERS[pending.kind];
	if (!handler) return stopped(p, state, `unknown pending directive kind "${pending.kind}"`, cfg);
	return handler({ ctx, p, cfg, state, pending, exec });
}

function writeBreachReport(p: Paths, state: State, cfg: SliceFlowConfig, reason: string): void {
	const sections = state.failedDimensions.map((dim) => {
		const file = join(p.verify, `${dim}.md`);
		const body = existsSync(file) ? readFileSync(file, "utf8") : "(verifier output missing)";
		return `## ${dim}\n\nSource: ${file}\n\n${body}`;
	});
	const report = [
		`# slice-flow verification report — stopped before clean pass`,
		``,
		`- Feature: ${state.feature}`,
		`- Reason: ${reason}`,
		`- Loop iterations used: ${state.loopIteration} (max ${cfg.maxLoopIterations})`,
		`- Loop spawn cost: ~${state.loopCost.toFixed(1)} opus-equivalent spawns (budget ${cfg.loopCostBudget})`,
		state.realCost > 0
			? `- Real cost so far: $${state.realCost.toFixed(4)} (${state.realInputTokens + state.realOutputTokens} tokens)`
			: `- Observed agent I/O (chars/4, not model tokens): ~${state.tokensSpent - state.loopStartTokens}`,
		`- Remaining FAIL dimensions: ${state.failedDimensions.join(", ")}`,
		``,
		...sections,
	].join("\n");
	writeFileSync(p.report, report, "utf8");
}
