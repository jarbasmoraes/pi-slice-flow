/**
 * Configuration for the slice-flow workflow: defaults plus an optional
 * per-project `slice-flow.json` overlay. This module knows nothing about
 * state, prompts, or Pi — it only answers "what are the knobs?".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SliceFlowModels {
	intake: string | null;
	research: string | null;
	attack: string | null;
	compile: string | null;
	frameJudge: string | null;
	hypothesis: string | null;
	architectJudge: string | null;
	prototype: string | null;
	prototypeJudge: string | null;
	plan: string | null;
	build: string | null;
	review: string | null;
	fixup: string | null;
	verify: string | null;
}

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
	build: string;
	review: string;
	fixup: string;
	verify: string;
}

export interface SliceFlowConfig {
	/** Container dir (under cwd) that holds one slug-named folder per task. */
	workDir: string;
	hypothesisCount: number;
	prototypeCount: number;
	attackCount: number;
	maxCompileRetries: number;
	maxArchitectRetries: number;
	maxPlanRetries: number;
	maxLoopIterations: number;
	maxFixupsPerSlice: number;
	loopTokenBudget: number;
	/** Re-verify ALL dimensions on every loop iteration, not just the failed
	 * ones, so a fix that regresses a previously-passing dimension cannot reach
	 * `done` on a stale PASS verdict. Correctness over cost; default true. */
	reverifyAllInLoop: boolean;
	autoCommit: boolean;
	autoApprove: boolean;
	gitignoreWorkDir: boolean;
	agents: SliceFlowAgents;
	models: SliceFlowModels;
}

/** Defaults: cheap model for discovery and fix-ups, strong model for
 * architecture judging and verification, session default (null) for build. */
export const DEFAULT_CONFIG: SliceFlowConfig = {
	workDir: ".pi/task",
	hypothesisCount: 3,
	prototypeCount: 5,
	attackCount: 3,
	maxCompileRetries: 2,
	maxArchitectRetries: 2,
	maxPlanRetries: 2,
	maxLoopIterations: 5,
	maxFixupsPerSlice: 2,
	loopTokenBudget: 1_500_000,
	reverifyAllInLoop: true,
	autoCommit: true,
	autoApprove: false,
	gitignoreWorkDir: true,
	// Defaults name slice-flow's own dedicated agents, bundled in
	// slice-flow/agents/ and installed into .pi/agents/. There is no
	// generic-builtin fallback: every phase resolves to a slice-flow-<role> agent.
	agents: {
		intake: "slice-flow-scout",
		research: "slice-flow-researcher",
		attack: "slice-flow-oracle",
		compile: "slice-flow-scout",
		frameJudge: "slice-flow-oracle",
		hypothesis: "slice-flow-scout",
		architectJudge: "slice-flow-oracle",
		prototype: "slice-flow-builder",
		prototypeJudge: "slice-flow-oracle",
		plan: "slice-flow-planner",
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
		build: null,
		review: null,
		// Fix-ups resolve blocker/major findings — the riskiest edits in the
		// pipeline. null inherits the builder's strong session default rather
		// than forcing the cheapest tier onto correctness-critical work.
		fixup: null,
		verify: "anthropic/claude-opus-4-8",
	},
};

export function loadConfig(cwd: string): SliceFlowConfig {
	const file = join(cwd, "slice-flow.json");
	if (!existsSync(file)) return DEFAULT_CONFIG;
	try {
		const user = JSON.parse(readFileSync(file, "utf8"));
		return {
			...DEFAULT_CONFIG,
			...user,
			agents: { ...DEFAULT_CONFIG.agents, ...(user.agents ?? {}) },
			models: { ...DEFAULT_CONFIG.models, ...(user.models ?? {}) },
		};
	} catch (err) {
		throw new Error(`slice-flow.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}
