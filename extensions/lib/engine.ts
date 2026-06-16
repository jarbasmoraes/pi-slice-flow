/**
 * The workflow state machine: validates the artifacts of the step that just
 * finished, runs approval gates, advances the phase, and issues the next
 * directive. It depends only on the domain model (workspace), the directive
 * builders, and the narrow gate context — never on Pi's ExtensionAPI.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SliceFlowConfig } from "./config.ts";
import {
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
	planDirective,
	prototypeDirective,
	researchDirective,
	verifyDirective,
} from "./directives.ts";
import { PAUSE_MSG, askUiShape, gate } from "./gates.ts";
import type { GateContext } from "./gates.ts";
import {
	VERIFY_DIMENSIONS,
	createState,
	ensureWorkTree,
	hypothesisPaths,
	intakeMarkerOf,
	lintArchitecture,
	lintFrame,
	listSliceFiles,
	logEvent,
	nonEmpty,
	readVerifyVerdicts,
	removeFiles,
	saveState,
	sliceArtifacts,
	verdictOf,
	winnerOf,
} from "./workspace.ts";
import type { Directive, Paths, State } from "./workspace.ts";
import type { WorktreeInfo } from "./worktree.ts";

interface Env {
	ctx: GateContext;
	p: Paths;
	cfg: SliceFlowConfig;
	state: State;
	pending: Directive;
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
	return `Workflow STOPPED: ${reason}. State preserved at ${p.state}. Report (if any) at ${p.report}. Tell the user and end your turn.`;
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
async function runGate(env: Env, title: string, artifact: string, onRevise: (notes?: string) => Directive): Promise<string | null> {
	const g = await gate(env.ctx, env.cfg, title, artifact);
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
	const g = await gate(ctx, cfg, `Phase 1 (FRAME) complete — approve the frame?${warn}`, p.frame);
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

	// 3. Gate, with approval persisted BEFORE the UI question so a dismissed
	// dialog never forces a second approval of the same document.
	if (!state.archApproved) {
		const warn = !valid
			? ` WARNING: lint still failing after ${cfg.maxArchitectRetries} re-judges (${lint.findings.length} findings${winner === null ? ", no WINNER marker" : ""}).`
			: "";
		const g = await gate(ctx, cfg, `Phase 2 (ARCHITECT) complete — approve the architecture?${warn}`, p.architecture);
		if (g.decision === "pause") return PAUSE_MSG(p.architecture, state.slug);
		if (g.decision === "abort") return stopped(p, state, "user aborted at architect gate");
		if (g.decision === "revise") {
			state.archRetries = 0;
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

	// 4. UI shape decides whether phase 3 starts with prototypes.
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

async function onPrototype(env: Env): Promise<string> {
	const { p, cfg, state } = env;
	const judgement = join(p.prototypes, "JUDGEMENT.md");
	if (!nonEmpty(judgement)) return reissue(env, "Prototype judgement missing");
	state.phase = "plan";
	logEvent(state, "prototypes judged");
	return issue(p, state, planDirective(p, state, cfg), `Prototype winner recorded in ${judgement}.`);
}

async function onPlan(env: Env): Promise<string> {
	const { ctx, p, cfg, state } = env;
	const sliceFiles = listSliceFiles(p);
	if (!nonEmpty(p.plan) || sliceFiles.length === 0) {
		return reissue(env, `Plan or slice files missing (found ${sliceFiles.length} slices in ${p.slices})`);
	}
	if (ctx.hasUI) ctx.ui.notify(`Slices: ${sliceFiles.join(", ")}`, "info");
	const gated = await runGate(
		env,
		`Phase 3 (PLAN) complete — approve the ${sliceFiles.length} slices?`,
		`${p.plan} and ${p.slices}/`,
		(notes) => planDirective(p, state, cfg, notes),
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
		state.phase = "done";
		state.pending = null;
		logEvent(state, "clean verification pass");
		saveState(p, state);
		return [
			"## Workflow COMPLETE — clean verification pass on all 5 dimensions.",
			"",
			`- Frame: ${p.frame}`,
			`- Architecture: ${p.architecture}`,
			`- Plan: ${p.plan} (${state.slices.length} slices)`,
			`- Verification: ${p.verify}/`,
			`- Estimated tokens spent across spawned agents: ~${state.tokensSpent}`,
			"",
			"Summarize the feature work for the user and end your turn.",
		].join("\n");
	}

	if (state.phase !== "loop") {
		state.phase = "loop";
		state.loopIteration = 0;
		state.loopStartTokens = state.tokensSpent;
	}
	state.failedDimensions = failed;
	const loopTokens = state.tokensSpent - state.loopStartTokens;
	if (state.loopIteration >= cfg.maxLoopIterations) {
		writeBreachReport(p, state, cfg, `max loop iterations (${cfg.maxLoopIterations}) reached`);
		return stopped(p, state, `loop limit reached with FAIL on: ${failed.join(", ")}. Report written to ${p.report}`);
	}
	if (loopTokens > cfg.loopTokenBudget) {
		writeBreachReport(p, state, cfg, `loop token budget exceeded (~${loopTokens} > ${cfg.loopTokenBudget})`);
		return stopped(p, state, `token budget exceeded with FAIL on: ${failed.join(", ")}. Report written to ${p.report}`);
	}
	state.loopIteration += 1;
	logEvent(state, `loop iteration ${state.loopIteration}: FAIL on ${failed.join(", ")}`);
	return issue(
		p,
		state,
		loopDirective(p, state, cfg),
		`Verification FAILED on: ${failed.join(", ")}. Loop iteration ${state.loopIteration}/${cfg.maxLoopIterations} (loop tokens ~${loopTokens}/${cfg.loopTokenBudget}).`,
	);
}

const HANDLERS: Record<string, (env: Env) => Promise<string>> = {
	intake: onIntake,
	research: onResearch,
	attack: onAttack,
	"frame-compile": onFrameCompiled,
	architect: onArchitect,
	"architect-judge": onArchitect,
	prototype: onPrototype,
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

export function startWorkflow(
	p: Paths,
	cfg: SliceFlowConfig,
	feature: string,
	slug: string,
	baselineCommit: string | null,
	cwd: string,
	isolation?: { worktree?: WorktreeInfo },
): string {
	syncBundledAgents(cwd);
	preflightAgents(cwd, cfg);
	ensureWorkTree(p);
	const state = createState(feature, slug, baselineCommit, isolation);
	logEvent(state, `started: ${state.feature}`);
	return issue(
		p,
		state,
		intakeDirective(p, state, cfg),
		`slice-flow started. Task slug: ${slug} (folder ${p.root}). Pass "slug":"${slug}" on every follow-up slice_flow call. Baseline commit: ${baselineCommit ?? "(not a git repo)"}.`,
	);
}

export async function nextStep(ctx: GateContext, p: Paths, cfg: SliceFlowConfig, state: State): Promise<string> {
	if (state.phase === "done") return `Workflow already complete. Final docs are under ${p.root}/.`;
	if (state.phase === "stopped") return `Workflow is stopped. Start fresh with /feature after clearing ${p.root}, or inspect ${p.report}.`;
	const pending = state.pending;
	// The explore stage is interactive and has no pending directive; `next` just
	// repeats the partner instructions (e.g. after /feature-resume).
	if (!pending && state.phase === "frame" && state.frameStage === "explore") return exploreMessage(p, state.slug);
	if (!pending) return stopped(p, state, "internal error: no pending directive");
	const handler = HANDLERS[pending.kind];
	if (!handler) return stopped(p, state, `unknown pending directive kind "${pending.kind}"`);
	return handler({ ctx, p, cfg, state, pending });
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
		`- Estimated loop tokens spent: ${state.tokensSpent - state.loopStartTokens} (budget ${cfg.loopTokenBudget})`,
		`- Remaining FAIL dimensions: ${state.failedDimensions.join(", ")}`,
		``,
		...sections,
	].join("\n");
	writeFileSync(p.report, report, "utf8");
}
