/**
 * Configuration for the slice-flow workflow: defaults plus an optional
 * per-project `slice-flow.json` overlay. This module knows nothing about
 * state, prompts, or Pi — it only answers "what are the knobs?".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A phase's model spec: a single model applied to every run; OR a list that
 * round-robins across a fan-out's parallel runs (so adversaries, hypotheses,
 * prototypes, and verifiers can each run on a different model family); OR null
 * to inherit the agent/session default. Non-fan-out phases use index 0 of a
 * list. */
export type ModelSpec = string | string[] | null;

export interface SliceFlowModels {
	intake: ModelSpec;
	research: ModelSpec;
	attack: ModelSpec;
	compile: ModelSpec;
	frameJudge: ModelSpec;
	hypothesis: ModelSpec;
	architectJudge: ModelSpec;
	prototype: ModelSpec;
	prototypeJudge: ModelSpec;
	plan: ModelSpec;
	planJudge: ModelSpec;
	build: ModelSpec;
	review: ModelSpec;
	fixup: ModelSpec;
	verify: ModelSpec;
	/** Model for the loop's regression-check verifiers — the dimensions that were
	 * already PASSing and are only re-run to catch a fix that regressed them.
	 * A cheaper tier than `verify` is appropriate here since the failed dimensions
	 * (the ones under active repair) keep the strong `verify` model. */
	verifyRegression: ModelSpec;
}

/** The human-approval gates, in pipeline order. `frame` is pinned to a human
 * (intent is created there, not verified) and is never auto-approved by the
 * autonomy map. The rest walk to `auto` one at a time as trust is earned. */
export type GateName = "frame" | "architect" | "prototype" | "plan" | "verify";
export type AutonomyMode = "human" | "auto";

/** Which subagent runs each phase. Same keys as SliceFlowModels so a phase's
 * agent and model are tuned side by side. Values are agent names resolved by
 * the pi-subagents runtime (builtin, user-scope, or project-scope .pi/agents). */
export interface SliceFlowAgents {
	intake: string;
	research: string;
	attack: string;
	compile: string;
	frameJudge: string;
	hypothesis: string;
	architectJudge: string;
	prototype: string;
	prototypeJudge: string;
	plan: string;
	planJudge: string;
	build: string;
	review: string;
	fixup: string;
	verify: string;
}

export interface SliceFlowConfig {
	/** Container dir (under cwd) that holds one slug-named folder per task. */
	workDir: string;
	hypothesisCount: number;
	/** Competing plan decompositions judged comparatively (mirrors hypothesisCount
	 * for the architect). >1 fans out N independent planners into plan-<n>/
	 * candidate dirs and promotes the selected winner; 1 is the single-planner
	 * legacy path. */
	planCount: number;
	prototypeCount: number;
	attackCount: number;
	maxCompileRetries: number;
	/** Budget for CHEAP architecture re-judges (lint failure or a human "re-judge
	 * only" revision) — separate from the reconsider budget so a run of cheap
	 * re-judges can never exhaust the expensive adversary re-run path. */
	maxArchRejudge: number;
	/** Budget for EXPENSIVE architecture full re-runs (attack panel RECONSIDER:
	 * regenerate all hypotheses with the attack findings). */
	maxArchReconsider: number;
	maxPlanRetries: number;
	maxPrototypeRetries: number;
	maxLoopIterations: number;
	maxFixupsPerSlice: number;
	/** Phase-6 loop cost ceiling, denominated in "opus-equivalent spawns" — the
	 * deterministic quantity slice-flow actually controls. Each loop iteration
	 * adds (one fixer per failed dim + one verifier per re-verified dim), each
	 * weighted by its model tier via `modelWeights`. This is NOT a token meter:
	 * child token usage is not exposed at the `subagent` tool boundary, so the
	 * budget counts the work commissioned, not the tokens it consumes. */
	loopCostBudget: number;
	/** Per-model-family weights used to accrue loop cost. Keys are matched as
	 * lowercase substrings of the resolved model id ("opus"/"sonnet"/"haiku");
	 * `default` applies to unknown or session-default (null) models. Values
	 * roughly track relative $/token across tiers. */
	modelWeights: Record<string, number>;
	/** Re-verify ALL dimensions on every loop iteration, not just the failed
	 * ones, so a fix that regresses a previously-passing dimension cannot reach
	 * `done` on a stale PASS verdict. Correctness over cost; default true. */
	reverifyAllInLoop: boolean;
	autoCommit: boolean;
	/** Global fallback: when no UI is present, approve gates instead of pausing.
	 * Distinct from `autonomy`, which is a per-gate trust policy that skips the
	 * human even when a UI is present. `frame` is never auto-approved by the
	 * autonomy map regardless. */
	autoApprove: boolean;
	gitignoreWorkDir: boolean;
	/** Per-gate trust policy. "human" asks (today's default everywhere); "auto"
	 * trusts the phase's own judges/verifiers and advances without asking, even
	 * with a UI present. The path to a zero-touch engineer is flipping these to
	 * "auto" one gate at a time as the override data earns it. */
	autonomy: Record<GateName, AutonomyMode>;
	/** Langfuse tracing. Off by default (no surprise network calls; matches the
	 * conservative autonomy posture). When `enabled`, the telemetry layer also
	 * requires LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL in the
	 * environment, else it stays a no-op. `flushOnPause` ships buffered events
	 * before a gate pause ends the turn; `debug` logs flush failures. */
	telemetry: { enabled: boolean; flushOnPause: boolean; debug: boolean };
	agents: SliceFlowAgents;
	models: SliceFlowModels;
}

/** Defaults: cheap model for discovery and fix-ups, strong model for
 * architecture judging and verification, session default (null) for build. */
export const DEFAULT_CONFIG: SliceFlowConfig = {
	workDir: ".pi/task",
	hypothesisCount: 3,
	planCount: 2,
	prototypeCount: 3,
	attackCount: 3,
	maxCompileRetries: 2,
	maxArchRejudge: 2,
	maxArchReconsider: 2,
	maxPlanRetries: 2,
	maxPrototypeRetries: 2,
	maxLoopIterations: 5,
	maxFixupsPerSlice: 2,
	// Deterministic spawn-cost ceiling for phase 6 (not a token meter). With
	// reverifyAllInLoop=true a worst-case iteration is ~5 verifiers + up to 5
	// fixers at the strong (opus) tier ≈ 10 opus-equivalent spawns, so 30 leaves
	// room for ~3 such iterations before stopping. maxLoopIterations is the other
	// (count-based) cap; whichever binds first wins.
	loopCostBudget: 30,
	modelWeights: { opus: 1, sonnet: 0.25, haiku: 0.08, default: 0.5 },
	reverifyAllInLoop: true,
	autoCommit: true,
	autoApprove: false,
	gitignoreWorkDir: true,
	// Every gate starts human-in-the-loop; trust is handed over one gate at a
	// time. `frame` stays human permanently (it is never auto-approved here).
	autonomy: { frame: "human", architect: "human", prototype: "human", plan: "human", verify: "human" },
	telemetry: { enabled: false, flushOnPause: true, debug: false },
	// Defaults name slice-flow's own dedicated agents, bundled in
	// slice-flow/agents/ and installed into .pi/agents/. There is no
	// generic-builtin fallback: every phase resolves to a slice-flow-<role> agent.
	agents: {
		intake: "slice-flow-scout",
		research: "slice-flow-researcher",
		// The oracle archetype is split in two: an adversary that attacks, and a
		// judge that weighs and decides. Maximizing breakage and deciding cleanly
		// are different instincts, and the split gives each its own tunable identity.
		attack: "slice-flow-oracle-adversary",
		compile: "slice-flow-scout",
		frameJudge: "slice-flow-oracle-judge",
		hypothesis: "slice-flow-scout",
		architectJudge: "slice-flow-oracle-judge",
		prototype: "slice-flow-builder",
		prototypeJudge: "slice-flow-oracle-judge",
		plan: "slice-flow-planner",
		planJudge: "slice-flow-oracle-judge",
		build: "slice-flow-builder",
		review: "slice-flow-reviewer",
		fixup: "slice-flow-builder",
		verify: "slice-flow-reviewer",
	},
	models: {
		intake: "anthropic/claude-haiku-4-5",
		research: "anthropic/claude-haiku-4-5",
		attack: null,
		compile: null,
		frameJudge: "anthropic/claude-opus-4-8",
		// Architecture hypotheses are high-leverage (every slice inherits their
		// seams) and the generating agent (scout) is haiku-pinned, so a strong
		// model is named explicitly rather than inherited. Only 3 runs per phase.
		hypothesis: "anthropic/claude-opus-4-8",
		architectJudge: "anthropic/claude-opus-4-8",
		prototype: "anthropic/claude-haiku-4-5",
		prototypeJudge: "anthropic/claude-opus-4-8",
		plan: null,
		planJudge: "anthropic/claude-opus-4-8",
		build: null,
		review: null,
		// Fix-ups resolve blocker/major findings — the riskiest edits in the
		// pipeline. null inherits the builder's strong session default rather
		// than forcing the cheapest tier onto correctness-critical work.
		fixup: null,
		verify: "anthropic/claude-opus-4-8",
		// Regression-check dims (already passing, re-run only to catch a regressed
		// fix) run a cheaper tier; the failed dims under repair keep `verify` opus.
		verifyRegression: "anthropic/claude-sonnet-4-6",
	},
};

/** Weight one spawned agent's cost by its resolved model family. A null/undefined
 * model (session default) or an unrecognized id falls back to `weights.default`.
 * Pure and side-effect free so the engine and directives can agree on cost. */
export function modelWeight(model: string | null | undefined, weights: Record<string, number>): number {
	const fallback = weights.default ?? 0.5;
	if (!model) return fallback;
	const id = model.toLowerCase();
	for (const [family, w] of Object.entries(weights)) {
		if (family !== "default" && id.includes(family)) return w;
	}
	return fallback;
}

export function loadConfig(cwd: string): SliceFlowConfig {
	const file = join(cwd, "slice-flow.json");
	if (!existsSync(file)) return DEFAULT_CONFIG;
	try {
		const user = JSON.parse(readFileSync(file, "utf8"));
		return {
			...DEFAULT_CONFIG,
			...user,
			autonomy: { ...DEFAULT_CONFIG.autonomy, ...(user.autonomy ?? {}) },
			telemetry: { ...DEFAULT_CONFIG.telemetry, ...(user.telemetry ?? {}) },
			agents: { ...DEFAULT_CONFIG.agents, ...(user.agents ?? {}) },
			models: { ...DEFAULT_CONFIG.models, ...(user.models ?? {}) },
		};
	} catch (err) {
		throw new Error(`slice-flow.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}
