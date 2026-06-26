/**
 * The workflow state machine: validates the artifacts of the step that just
 * finished, runs approval gates, advances the phase, and issues the next
 * directive. It depends only on the domain model (workspace), the directive
 * builders, and the narrow gate context — never on Pi's ExtensionAPI.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateName, SliceFlowConfig } from "./config.ts";
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
import { PAUSE_MSG, askUiShape, gate } from "./gates.ts";
import type { GateContext } from "./gates.ts";
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
	lintPrototype,
	lintSlices,
	listSliceFiles,
	listTasks,
	loadState,
	prototypeWinnerOf,
	logEvent,
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
import type { Directive, Paths, ReflectPaths, State } from "./workspace.ts";
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

export function stopped(p: Paths, state: State, reason: string): string {
	state.phase = "stopped";
	state.pending = null;
	logEvent(state, `stopped: ${reason}`);
	saveState(p, state);
	const wt = state.isolation?.worktree;
	const worktreeNote = wt
		? ` The worktree at ${wt.path} (branch ${wt.branch}) was left intact — inspect or remove it manually; nothing was auto-removed.`
		: "";
	return `Workflow STOPPED: ${reason}. State preserved at ${p.state}. Report (if any) at ${p.report}.${worktreeNote} Tell the user and end your turn.`;
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
	logEvent(env.state, `gate ${gateId ?? env.pending.kind}: ${g.decision}`);
	if (g.decision === "pause") return PAUSE_MSG(artifact, env.state.slug);
	if (g.decision === "abort") return stopped(env.p, env.state, `user aborted at ${env.pending.kind} gate`);
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
			logEvent(state, `frame validation failed (lint ${lint.ok ? "ok" : "fail"}, judge ${judgeVerdict}) -> recompile ${state.compileRetries}`);
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
	logEvent(state, `gate frame: ${g.decision}`);
	if (g.decision === "pause") return PAUSE_MSG(p.frame, state.slug);
	if (g.decision === "abort") return stopped(p, state, "user aborted at frame gate");
	if (g.decision === "revise") {
		appendFileSync(p.ledger, `\n## Gate feedback (${new Date().toISOString()})\n\n${g.notes ?? ""}\n`, "utf8");
		logEvent(state, "frame gate: changes requested -> back to explore");
		return enterExplore(
			p,
			state,
			"The user requested changes at the frame gate. Their feedback was appended to the ledger — work through it with the user, update the ledger, then converge again.",
		);
	}
	state.phase = "architect";
	logEvent(state, "frame approved");
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
		if (state.archRetries < cfg.maxArchitectRetries) {
			state.archRetries += 1;
			const notes = [
				...lint.findings.map((f) => `lint: ${f}`),
				...(winner === null ? [`missing first line "WINNER: hypothesis-<id>"`] : []),
			].join("\n");
			logEvent(state, `architecture lint failed -> re-judge ${state.archRetries}/${cfg.maxArchitectRetries}`);
			removeFiles([p.architecture]);
			return issue(
				p,
				state,
				architectJudgeDirective(p, state, cfg, notes),
				`Architecture failed lint. Re-judging over existing hypotheses (retry ${state.archRetries}/${cfg.maxArchitectRetries}).`,
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
			(!valid ? ` WARNING: lint still failing after ${cfg.maxArchitectRetries} re-judges (${lint.findings.length} findings${winner === null ? ", no WINNER marker" : ""}).` : "") +
			(marker === "RECONSIDER" ? ` WARNING: attack panel says RECONSIDER (see ${p.archDispositions}).` : "");
		const g = await gate(ctx, cfg, `Phase 2 (ARCHITECT) complete — approve the architecture?${warn}`, `${p.architecture} + ${p.archDispositions}`, "architect", valid && marker !== "RECONSIDER");
		logEvent(state, `gate architect: ${g.decision}`);
		if (g.decision === "pause") return PAUSE_MSG(p.architecture, state.slug);
		if (g.decision === "abort") return stopped(p, state, "user aborted at architect gate");
		if (g.decision === "revise") {
			state.archRetries = 0;
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
				state.archRetries += 1;
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
		state.phase = "prototype";
		return issue(p, state, prototypeDirective(p, state, cfg), "Architecture approved. Greenfield UI: prototyping first.");
	}
	state.phase = "plan";
	return issue(p, state, planDirective(p, state, cfg), "Architecture approved.");
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

	if (marker === "RECONSIDER" && state.archRetries < cfg.maxArchitectRetries) {
		state.archRetries += 1;
		state.archAttacked = false; // re-attack the regenerated winner
		// Full re-run, not a re-judge: the attack panel exists to catch a flaw the
		// hypotheses SHARE, and re-selecting among the same three cannot answer
		// that. Regenerate the hypotheses with the attack findings as notes.
		removeFiles([...hypothesisPaths(p), p.architecture]);
		logEvent(state, `arch attack RECONSIDER -> full re-run (regenerate hypotheses) ${state.archRetries}/${cfg.maxArchitectRetries}`);
		return issue(
			p,
			state,
			architectDirective(p, state, cfg, `The attack panel returned RECONSIDER — full findings in ${p.archDispositions}. Regenerate the hypotheses to answer these objections.`),
			`Attack panel flagged RECONSIDER. Regenerating hypotheses (retry ${state.archRetries}/${cfg.maxArchitectRetries}).`,
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

	// Lint the judgement (parseable WINNER naming a real proto dir with a README);
	// a malformed judgement buys a bounded judge-only re-run over the frozen
	// prototypes before a human sees it.
	const lint = lintPrototype(p);
	if (!lint.ok && state.prototypeRetries < cfg.maxPrototypeRetries) {
		state.prototypeRetries += 1;
		const notes = lint.findings.map((f) => `lint: ${f}`).join("\n");
		logEvent(state, `prototype lint failed -> re-judge ${state.prototypeRetries}/${cfg.maxPrototypeRetries}`);
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
	state.phase = "plan";
	logEvent(state, `prototype winner approved (${prototypeWinnerOf(judgement) ?? "?"})`);
	return issue(p, state, planDirective(p, state, cfg), `Prototype winner recorded in ${judgement}.`);
}

async function onPlan(env: Env): Promise<string> {
	const { ctx, p, cfg, state } = env;
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
		logEvent(state, `plan validation failed (lint ${lint.ok ? "ok" : "fail"}, judge ${judgeVerdict}) -> replan ${state.planRetries}/${cfg.maxPlanRetries}`);
		// Clear the rejected slice files first so a replan that writes fewer or
		// renamed slices cannot leave orphans that pass the next lint and get
		// built from a discarded plan (the invariant onArchitect also upholds).
		removeFiles(listSliceFiles(p).map((f) => join(p.slices, f)));
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
			removeFiles(listSliceFiles(p).map((f) => join(p.slices, f))); // discard the rejected slices before re-planning
			return planDirective(p, state, cfg, notes);
		},
		"plan",
		valid,
	);
	if (gated !== null) return gated;
	state.slices = sliceFiles;
	state.sliceIndex = 0;
	state.fixupRound = 0;
	state.phase = "implement";
	logEvent(state, `plan approved with ${sliceFiles.length} slices`);
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
			logEvent(state, `${a.sliceId} review FAIL -> fix-up round ${state.fixupRound}`);
			return issue(p, state, fixupDirective(p, state, cfg), `Review of ${a.sliceId} FAILED (${a.reviewPath}). Spawning scoped fix-up.`);
		}
		if (!ctx.hasUI) return stopped(p, state, `${a.sliceId} still failing review after ${cfg.maxFixupsPerSlice} fix-ups`);
		const choice = await ctx.ui.select(
			`${a.sliceId} still FAILS review after ${cfg.maxFixupsPerSlice} fix-up rounds. (See ${a.reviewPath})`,
			["Run one more fix-up round", "Accept the slice anyway and continue", "Abort workflow"],
		);
		if (choice === undefined) return PAUSE_MSG(a.reviewPath, state.slug);
		if (choice === "Abort workflow") return stopped(p, state, `user aborted: ${a.sliceId} failing review`);
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
	state.phase = "verify";
	logEvent(state, "all slices complete -> verify");
	return issue(p, state, verifyDirective(p, state, cfg), "All slices complete. Running independent verification.");
}

/** Shared by `verify` and `loop-fix`: read verdicts, finish or keep looping. */
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
		// Completion gate: the 5 refute verifiers are the mechanism; this gate is a
		// removable overlay. autonomy.verify="auto" (or autoApprove) advances
		// headless; "human" asks before declaring the feature done.
		// All 5 dimensions passed, so the artifact is clean by definition (clean=true).
		const g = await gate(env.ctx, cfg, "Verification clean on all 5 dimensions — accept and finish?", `${p.verify}/`, "verify");
		logEvent(state, `gate verify: ${g.decision}`);
		if (g.decision === "pause") return PAUSE_MSG(`${p.verify}/`, state.slug);
		if (g.decision === "abort") return stopped(p, state, "user aborted at verify completion gate");
		if (g.decision === "revise") {
			// All dimensions pass, so there is no failed dimension to loop on. Record
			// the feedback and stop deterministically rather than spinning an empty
			// loop — the human re-runs /feature or opens a follow-up task.
			if (g.notes) appendFileSync(join(p.verify, "_gate-feedback.md"), `\n## Completion gate feedback (${new Date().toISOString()})\n\n${g.notes}\n`, "utf8");
			return stopped(p, state, `human requested changes at the verify completion gate; feedback recorded in ${p.verify}/_gate-feedback.md`);
		} else {
			state.phase = "done";
			state.pending = null;
			logEvent(state, "clean verification pass");
			saveState(p, state);
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
			`- Observed agent I/O across spawned agents (chars/4, not model tokens): ~${state.tokensSpent}`,
			"",
				"Summarize the feature work for the user and end your turn.",
			].join("\n");
		}
	}

	if (state.phase !== "loop") {
		state.phase = "loop";
		state.loopIteration = 0;
		state.loopStartTokens = state.tokensSpent;
		state.loopCost = 0;
	}
	state.failedDimensions = failed;
	if (state.loopIteration >= cfg.maxLoopIterations) {
		writeBreachReport(p, state, cfg, `max loop iterations (${cfg.maxLoopIterations}) reached`);
		return stopped(p, state, `loop limit reached with FAIL on: ${failed.join(", ")}. Report written to ${p.report}`);
	}
	// Account for the iteration about to be issued before spawning it: the fixer
	// and verifier counts and models are fully known here, so the weighted spawn
	// cost is deterministic — stop *before* overspending, not after.
	const iterationCost = loopIterationCost(state, cfg);
	if (state.loopCost + iterationCost > cfg.loopCostBudget) {
		const projected = state.loopCost + iterationCost;
		writeBreachReport(p, state, cfg, `loop cost budget exceeded (~${projected.toFixed(1)} > ${cfg.loopCostBudget} opus-equivalent spawns)`);
		return stopped(p, state, `loop cost budget exceeded with FAIL on: ${failed.join(", ")}. Report written to ${p.report}`);
	}
	state.loopCost += iterationCost;
	state.loopIteration += 1;
	logEvent(state, `loop iteration ${state.loopIteration}: FAIL on ${failed.join(", ")}`);
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
): string {
	syncBundledAgents(cwd);
	preflightAgents(cwd, cfg);
	ensureWorkTree(p);
	const state = createState(feature, slug, baselineCommit, isolation);
	state.codegraphReady = codegraphState === "ready";
	logEvent(state, `started: ${state.feature}`);
	const cgLine = codegraphPreamble(codegraphState);
	return issue(
		p,
		state,
		intakeDirective(p, state, cfg),
		`slice-flow started. Task slug: ${slug} (folder ${p.root}). Pass "slug":"${slug}" on every follow-up slice_flow call. Baseline commit: ${baselineCommit ?? "(not a git repo)"}.` +
			(cgLine ? `\n${cgLine}` : ""),
	);
}

export async function nextStep(ctx: GateContext, p: Paths, cfg: SliceFlowConfig, state: State, exec?: Exec): Promise<string> {
	if (state.phase === "done") return `Workflow already complete. Final docs are under ${p.root}/.`;
	if (state.phase === "stopped") return `Workflow is stopped. Start fresh with /feature after clearing ${p.root}, or inspect ${p.report}.`;
	const pending = state.pending;
	// The explore stage is interactive and has no pending directive; `next` just
	// repeats the partner instructions (e.g. after /feature-resume).
	if (!pending && state.phase === "frame" && state.frameStage === "explore") return exploreMessage(p, state.slug);
	if (!pending) return stopped(p, state, "internal error: no pending directive");
	const handler = HANDLERS[pending.kind];
	if (!handler) return stopped(p, state, `unknown pending directive kind "${pending.kind}"`);
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
		`- Observed agent I/O (chars/4, not model tokens): ~${state.tokensSpent - state.loopStartTokens}`,
		`- Remaining FAIL dimensions: ${state.failedDimensions.join(", ")}`,
		``,
		...sections,
	].join("\n");
	writeFileSync(p.report, report, "utf8");
}
