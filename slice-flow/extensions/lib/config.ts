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

export interface SliceFlowConfig {
	/** Container dir (under cwd) that holds one slug-named folder per task. */
	workDir: string;
	hypothesisCount: number;
	prototypeCount: number;
	attackCount: number;
	maxCompileRetries: number;
	maxLoopIterations: number;
	maxFixupsPerSlice: number;
	loopTokenBudget: number;
	autoCommit: boolean;
	autoApprove: boolean;
	gitignoreWorkDir: boolean;
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
	maxLoopIterations: 5,
	maxFixupsPerSlice: 2,
	loopTokenBudget: 1_500_000,
	autoCommit: true,
	autoApprove: false,
	gitignoreWorkDir: true,
	models: {
		intake: "anthropic/claude-haiku-4-5",
		research: "anthropic/claude-haiku-4-5",
		attack: null,
		compile: null,
		frameJudge: "anthropic/claude-opus-4-8",
		hypothesis: "anthropic/claude-haiku-4-5",
		architectJudge: "anthropic/claude-opus-4-8",
		prototype: "anthropic/claude-haiku-4-5",
		prototypeJudge: "anthropic/claude-opus-4-8",
		plan: null,
		build: null,
		review: null,
		fixup: "anthropic/claude-haiku-4-5",
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
			models: { ...DEFAULT_CONFIG.models, ...(user.models ?? {}) },
		};
	} catch (err) {
		throw new Error(`slice-flow.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}
