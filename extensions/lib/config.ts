/**
 * Configuration for the slice-flow workflow: defaults plus an optional
 * per-project `slice-flow.json` overlay. This module knows nothing about
 * state, prompts, or Pi — it only answers "what are the knobs?".
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
	 * lowercase substrings of the resolved model id ("opus"/"sonnet"/"haiku",
	 * plus the "gpt-5.x"/"qwen"/"gemma" families this config actually fans out
	 * across); `default` applies to unknown or session-default (null) models.
	 * More-specific keys (e.g. "gpt-5.4-mini") must be inserted BEFORE their
	 * prefix ("gpt-5.4") since matching returns the first substring hit in key
	 * order. Values roughly track relative $/token across tiers. */
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
	/** Deterministic check-pack: external-oracle gates run with NO model in the
	 * loop, so they catch blind spots that sit outside the model's correlated
	 * error space (tests, SAST, secret/dep scanners). `enabled` turns the whole
	 * gate off; `mode` is "warn" (surface findings at the verify gate but never
	 * block — quarantine-first default) or "block" (a finding stops the run).
	 * `oracles` names the Tier-A universal oracles to run; unknown ids are
	 * skipped, and any oracle whose tool is absent from PATH is a graceful skip,
	 * never a failure. `generate` allows Tier-C bespoke checks to be authored for a
	 * live, uncovered axis; an authored check is admitted ONLY after it goes RED on
	 * a planted-violation fixture and GREEN on the clean tree (`validateCheck`),
	 * else it is quarantined as a warning. `maxGenRetries` bounds the author→
	 * validate retry loop. */
	checks: { enabled: boolean; mode: "warn" | "block"; oracles: string[]; generate: boolean; maxGenRetries: number };
	/** Staleness thresholds for the per-project profile (`.slice-flow/PROJECT.md`,
	 * `slice-flow init`). When a captured profile is older than EITHER bound, the
	 * `/feature` start banner nudges the user to refresh it with `/feature-init`.
	 * Pure visibility — the profile is never auto-edited. `staleAfterCommits` is
	 * best-effort (skipped on a non-git repo). */
	profile: { staleAfterDays: number; staleAfterCommits: number };
	/** Self-preference mitigation for the model judges. slice-flow is
	 * Claude-judging-Claude, and Claude over-rates its own family's output;
	 * `"cross"` (default) routes a judge to a *different* available model family
	 * than the builders where one exists (probed at start), and falls back to the
	 * configured judge + a logged caveat + comparative position-swap when only the
	 * host family is present. `"same"` disables rerouting (judges keep their
	 * configured models). */
	judgeFamily: "cross" | "same";
	/** Push MVP for the Todoist integration: when `enabled`, an interactive run
	 * start creates a real Todoist task via the Composio CLI (see lib/todoist.ts).
	 * Off by default — no surprise external calls. `debug` logs create failures. */
	todoist: { enabled: boolean; debug?: boolean };
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
	// Anthropic tiers first, then the hosted gpt-5.x families (mini variants
	// before their prefix so substring matching resolves them correctly), then
	// local ollama models (qwen*/gemma*) whose marginal $/token is ~free.
	modelWeights: {
		opus: 1,
		"gpt-5.5": 0.5,
		sonnet: 0.25,
		"gpt-5.4-mini": 0.06,
		"gpt-5.4": 0.3,
		"gpt-5.3": 0.05,
		haiku: 0.08,
		qwen: 0.02,
		gemma: 0.02,
		default: 0.5,
	},
	reverifyAllInLoop: true,
	autoCommit: true,
	autoApprove: false,
	gitignoreWorkDir: true,
	// Every gate starts human-in-the-loop; trust is handed over one gate at a
	// time. `frame` stays human permanently (it is never auto-approved here).
	autonomy: { frame: "human", architect: "human", prototype: "human", plan: "human", verify: "human" },
	telemetry: { enabled: false, flushOnPause: true, debug: false },
	// Check-pack on by default but in "warn" mode: findings surface at the verify
	// gate without blocking, so adopting the feature never breaks an existing run.
	// A project opts into "block" via slice-flow.json once it trusts the oracles.
	// All three Tier-A oracles are requested; whichever tools aren't installed are
	// skipped with a nudge rather than failing.
	checks: { enabled: true, mode: "warn", oracles: ["secrets", "sast", "deps"], generate: true, maxGenRetries: 2 },
	// A profile drifts as the code moves; nudge to refresh after ~45 days or ~75
	// commits since it was captured (whichever comes first). Tune per project.
	profile: { staleAfterDays: 45, staleAfterCommits: 75 },
	// Route judges to a different model family than the builders when one is
	// available (probed at start), to dodge Claude's confirmed self-preference
	// bias; degrades to the configured judge + caveat + position-swap otherwise.
	judgeFamily: "cross",
	// Off by default; a project opts in via slice-flow.json once Composio/Todoist
	// are set up. See lib/todoist.ts for the fail-soft client.
	todoist: { enabled: false },
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

/** Parse one slice-flow.json overlay. Returns null when the file is absent;
 * throws a clear, path-qualified error when it exists but is malformed. */
function readOverlay(file: string): Record<string, unknown> | null {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Layer one overlay onto a base config. The nested maps (autonomy/telemetry/
 * agents/models) merge key-by-key so an overlay can tune a single phase without
 * restating the whole object; every other top-level key replaces wholesale. */
function mergeConfig(base: SliceFlowConfig, overlay: Record<string, unknown>): SliceFlowConfig {
	return {
		...base,
		...overlay,
		autonomy: { ...base.autonomy, ...((overlay.autonomy as Partial<Record<GateName, AutonomyMode>>) ?? {}) },
		telemetry: { ...base.telemetry, ...((overlay.telemetry as Partial<SliceFlowConfig["telemetry"]>) ?? {}) },
		checks: { ...base.checks, ...((overlay.checks as Partial<SliceFlowConfig["checks"]>) ?? {}) },
		todoist: { ...base.todoist, ...((overlay.todoist as Partial<SliceFlowConfig["todoist"]>) ?? {}) },
		profile: { ...base.profile, ...((overlay.profile as Partial<SliceFlowConfig["profile"]>) ?? {}) },
		agents: { ...base.agents, ...((overlay.agents as Partial<SliceFlowAgents>) ?? {}) },
		models: { ...base.models, ...((overlay.models as Partial<SliceFlowModels>) ?? {}) },
	};
}

/**
 * Resolve the effective config by layering, lowest precedence first:
 *   DEFAULT_CONFIG  <  ~/.pi/slice-flow.json (global)  <  <cwd>/slice-flow.json (project)
 *
 * The global file makes one config the default across every project; a project
 * may still override individual keys by dropping its own slice-flow.json.
 * `homeDir` is injectable so tests can point the global lookup at a temp dir.
 */
export function loadConfig(cwd: string, homeDir: string = homedir()): SliceFlowConfig {
	const globalOverlay = readOverlay(join(homeDir, ".pi", "slice-flow.json"));
	const projectOverlay = readOverlay(join(cwd, "slice-flow.json"));
	let cfg = DEFAULT_CONFIG;
	if (globalOverlay) cfg = mergeConfig(cfg, globalOverlay);
	if (projectOverlay) cfg = mergeConfig(cfg, projectOverlay);
	return cfg;
}
