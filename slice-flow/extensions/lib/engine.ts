/**
 * The workflow state machine: validates the artifacts of the step that just
 * finished, runs approval gates, advances the phase, and issues the next
 * directive. It depends only on the domain model (workspace), the directive
 * builders, and the narrow gate context — never on Pi's ExtensionAPI.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SliceFlowConfig } from "./config.ts";
import {
	architectDirective,
	buildDirective,
	fixupDirective,
	frameDirective,
	logDirective,
	loopDirective,
	planDirective,
	prototypeDirective,
	verifyDirective,
} from "./directives.ts";
import { PAUSE_MSG, askUiShape, gate } from "./gates.ts";
import type { GateContext } from "./gates.ts";
import {
	VERIFY_DIMENSIONS,
	createState,
	ensureWorkTree,
	listSliceFiles,
	logEvent,
	nonEmpty,
	readVerifyVerdicts,
	saveState,
	sliceArtifacts,
	verdictOf,
} from "./workspace.ts";
import type { Directive, Paths, State } from "./workspace.ts";

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
		`When the subagent run completes (success or failure), call slice_flow({"action":"next"}). Do not do any of the work yourself.`,
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
	if (g.decision === "pause") return PAUSE_MSG(artifact);
	if (g.decision === "abort") return stopped(env.p, env.state, `user aborted at ${env.pending.kind} gate`);
	if (g.decision === "revise") {
		logEvent(env.state, `${env.pending.kind} revision requested`);
		return issue(env.p, env.state, onRevise(g.notes), "User requested revisions.");
	}
	return null;
}

// --- Phase handlers --------------------------------------------------------------

async function onFrame(env: Env): Promise<string> {
	const { p, cfg, state } = env;
	if (!nonEmpty(p.frame)) return reissue(env, `The frame document ${p.frame} was not produced`);
	const gated = await runGate(env, "Phase 1 (FRAME) complete — approve the frame?", p.frame, (notes) => frameDirective(p, state, cfg, notes));
	if (gated !== null) return gated;
	state.phase = "architect";
	logEvent(state, "frame approved");
	return issue(p, state, architectDirective(p, state, cfg), `Frame approved (${p.frame}).`);
}

async function onArchitect(env: Env): Promise<string> {
	const { ctx, p, cfg, state } = env;
	if (!nonEmpty(p.architecture)) return reissue(env, `The architecture document ${p.architecture} was not produced`);
	const gated = await runGate(env, "Phase 2 (ARCHITECT) complete — approve the architecture?", p.architecture, (notes) =>
		architectDirective(p, state, cfg, notes),
	);
	if (gated !== null) return gated;
	// UI shape decides whether phase 3 starts with prototypes.
	if (state.ui === null) {
		const shape = await askUiShape(ctx, cfg);
		if (shape === null) return PAUSE_MSG("the UI question (interactive session required)");
		state.ui = shape;
	}
	logEvent(state, `architecture approved; ui=${state.ui}`);
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
		if (choice === undefined) return PAUSE_MSG(a.reviewPath);
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
	frame: onFrame,
	architect: onArchitect,
	prototype: onPrototype,
	plan: onPlan,
	build: onSliceReviewed,
	fixup: onSliceReviewed,
	verify: onVerified,
	"loop-fix": onVerified,
};

// --- Public entry points -----------------------------------------------------------

export function startWorkflow(p: Paths, cfg: SliceFlowConfig, feature: string, baselineCommit: string | null): string {
	ensureWorkTree(p);
	const state = createState(feature, baselineCommit);
	logEvent(state, `started: ${state.feature}`);
	return issue(
		p,
		state,
		frameDirective(p, state, cfg),
		`slice-flow started. State: ${p.state}. Baseline commit: ${baselineCommit ?? "(not a git repo)"}.`,
	);
}

export async function nextStep(ctx: GateContext, p: Paths, cfg: SliceFlowConfig, state: State): Promise<string> {
	if (state.phase === "done") return `Workflow already complete. Final docs are under ${p.root}/.`;
	if (state.phase === "stopped") return `Workflow is stopped. Start fresh with /feature after clearing ${p.root}, or inspect ${p.report}.`;
	const pending = state.pending;
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
