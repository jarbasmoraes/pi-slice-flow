/**
 * Builds the exact `subagent` tool arguments for every workflow step,
 * composing brief text (briefs.ts) with the pi-subagents call shapes:
 * chains for sequential phases, parallel groups/tasks for fan-outs.
 *
 * Invariants enforced here, once, for every spawned agent:
 * - context: "fresh" (a new Pi instance, no parent conversation history)
 * - clarify: false (slice-flow runs its own approval gates)
 * - the full task brief is written to logs/ and injected via `reads`, so the
 *   parent LLM relays a short pointer and can never mutate a prompt.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SliceFlowConfig } from "./config.ts";
import { modelWeight } from "./config.ts";
import {
	ARCH_ATTACK_CHARTERS,
	ATTACK_CHARTERS,
	HYPOTHESIS_ANGLES,
	archAttackBrief,
	archDispositionBrief,
	architectJudgeBrief,
	attackBrief,
	buildBrief,
	compileBrief,
	fixupBrief,
	frameJudgeBrief,
	hypothesisBrief,
	intakeBrief,
	loopFixBrief,
	planBrief,
	planJudgeBrief,
	prototypeBrief,
	prototypeJudgeBrief,
	reflectBrief,
	researchBrief,
	reviewBrief,
	verifierBrief,
} from "./briefs.ts";
import { VERIFY_DIMENSIONS, hypothesisPaths, logEvent, nextSeqIn, pad3, priorMemoPaths, sliceArtifacts, slugify } from "./workspace.ts";
import type { Directive, Paths, ReflectPaths, State, VerifyDimension } from "./workspace.ts";

// --- Worktree isolation --------------------------------------------------------

/**
 * Thread the active worktree cwd into every spawned agent. When the task has an
 * isolation worktree, walk the directive args and tag every object carrying an
 * `agent` string with `cwd: <worktree cwd>`, so builders, reviewers, the verify
 * fan-out, and any future directive run inside the worktree. A no-op (returns
 * the args unchanged) when no worktree is active. Mutates `args` in place.
 */
export function injectIsolationCwd(args: Record<string, unknown>, state: State): Record<string, unknown> {
	const wt = state.isolation?.worktree;
	if (!wt) return args;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (node && typeof node === "object") {
			const o = node as Record<string, unknown>;
			if (typeof o.agent === "string") o.cwd = wt.cwd;
			for (const v of Object.values(o)) walk(v);
		}
	};
	walk(args);
	return args;
}

// --- DRY building blocks -----------------------------------------------------

/** Resolve a phase's model spec to the model for parallel run `i`. A single
 * string applies to every run; a list round-robins across the fan-out so each
 * run can use a different model family; null inherits the agent/session
 * default. Non-fan-out callers omit `i` and get index 0. */
function modelAt(spec: string | string[] | null, i = 0): string | null {
	if (Array.isArray(spec)) return spec.length ? spec[i % spec.length] : null;
	return spec;
}

/** Spread helper: include `model` only when configured (null inherits the session default). */
function withModel(spec: string | string[] | null, i = 0): { model?: string } {
	const model = modelAt(spec, i);
	return model ? { model } : {};
}

/** The common envelope for every chain directive. */
function freshChain(p: Paths, seq: number, slug: string, steps: unknown[]): Record<string, unknown> {
	return {
		chain: steps,
		context: "fresh",
		clarify: false,
		chainDir: join(p.chains, `${pad3(seq)}-${slug}`),
	};
}

/** The common envelope for every top-level parallel directive. */
function freshParallel(tasks: unknown[]): Record<string, unknown> {
	return { tasks, concurrency: tasks.length, context: "fresh", clarify: false };
}

interface BriefStep {
	briefPath: string;
	task: string;
}

/** Write a full task brief to logs/ and return the short pointer task. */
function makeBriefStep(p: Paths, state: State, slug: string, briefText: string): BriefStep {
	state.seq += 1;
	const briefPath = join(p.logs, `${pad3(state.seq)}-${slug}.md`);
	writeFileSync(briefPath, briefText, "utf8");
	return {
		briefPath,
		task: `Your complete task brief is the injected file ${briefPath}. Execute it exactly. It overrides any conflicting default behavior.`,
	};
}

export function logDirective(p: Paths, directive: Directive): void {
	writeFileSync(
		join(p.logs, `${pad3(directive.seq)}-directive-${directive.kind}.json`),
		JSON.stringify({ ts: new Date().toISOString(), ...directive }, null, 2),
		"utf8",
	);
}

// --- Phase directives ----------------------------------------------------------

export function intakeDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const step = makeBriefStep(p, state, "intake-brief", intakeBrief(p, state.feature));
	return {
		kind: "intake",
		seq: state.seq,
		label: "Phase 1 — FRAME: intake check",
		expects: [p.intake],
		args: freshChain(p, state.seq, "intake", [
			{
				agent: cfg.agents.intake,
				task: step.task,
				label: "Intake check",
				phase: "Frame",
				reads: [step.briefPath],
				output: p.intake,
				...(state.codegraphReady ? { skill: "codegraph" } : {}),
				...withModel(cfg.models.intake),
			},
		]),
	};
}

export function researchDirective(p: Paths, state: State, cfg: SliceFlowConfig, questions: string[]): Directive {
	let seq = nextSeqIn(p.frameResearch);
	const tasks = questions.map((q, i) => {
		const outPath = join(p.frameResearch, `${pad3(seq)}-${slugify(q)}.md`);
		seq += 1;
		const step = makeBriefStep(p, state, `research-${slugify(q, 4)}-brief`, researchBrief(state.feature, q, outPath));
		return {
			agent: cfg.agents.research,
			task: step.task,
			label: `Research: ${q.slice(0, 60)}`,
			reads: [step.briefPath],
			output: outPath,
			...withModel(cfg.models.research, i),
		};
	});
	return {
		kind: "research",
		seq: state.seq,
		label: `Phase 1 — FRAME: research (${questions.length} question${questions.length === 1 ? "" : "s"})`,
		expects: tasks.map((t) => t.output),
		args: freshParallel(tasks),
	};
}

export function attackDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	let seq = nextSeqIn(p.frameAttacks);
	const tasks = ATTACK_CHARTERS.slice(0, cfg.attackCount).map((charter, i) => {
		const outPath = join(p.frameAttacks, `${pad3(seq)}-${charter.id}.md`);
		seq += 1;
		const step = makeBriefStep(p, state, `attack-${charter.id}-brief`, attackBrief(p, state.feature, charter, outPath));
		return {
			agent: cfg.agents.attack,
			task: step.task,
			label: `Attack: ${charter.id}`,
			reads: [step.briefPath, p.ledger, p.intake],
			output: outPath,
			...withModel(cfg.models.attack, i),
		};
	});
	return {
		kind: "attack",
		seq: state.seq,
		label: `Phase 1 — FRAME: adversarial attack (${tasks.length} charters)`,
		expects: tasks.map((t) => t.output),
		args: freshParallel(tasks),
	};
}

export function compileDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	const compileStep = makeBriefStep(p, state, "frame-compile-brief", compileBrief(p, state.feature, notes));
	const compileReads = [compileStep.briefPath, p.intake, p.ledger];
	if (notes) compileReads.push(p.frame, p.frameJudgement); // recompile: previous attempt + judge findings
	const judgeStep = makeBriefStep(p, state, "frame-judge-brief", frameJudgeBrief(p));
	return {
		kind: "frame-compile",
		seq: state.seq,
		label: `Phase 1 — FRAME: compile + fidelity judge${notes ? ` (retry ${state.compileRetries})` : ""}`,
		expects: [p.frame, p.frameJudgement],
		args: freshChain(p, state.seq, `frame-compile${notes ? `-r${state.compileRetries}` : ""}`, [
			{
				agent: cfg.agents.compile,
				task: compileStep.task,
				label: "Compile frame from ledger",
				phase: "Frame",
				skill: "zinsser-framing",
				reads: compileReads,
				output: p.frame,
				...withModel(cfg.models.compile),
			},
			{
				agent: cfg.agents.frameJudge,
				task: judgeStep.task,
				label: "Judge frame fidelity",
				phase: "Frame",
				// p.frame is (re)written by the compile step before this one launches.
				reads: [judgeStep.briefPath, p.ledger, p.frame],
				output: p.frameJudgement,
				...withModel(cfg.models.frameJudge),
			},
		]),
	};
}

export function architectDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	// Clamp loudly instead of truncating silently: a throw here would detonate
	// after the user's frame approval was already consumed.
	if (cfg.hypothesisCount > HYPOTHESIS_ANGLES.length) {
		logEvent(state, `warning: hypothesisCount ${cfg.hypothesisCount} exceeds the ${HYPOTHESIS_ANGLES.length} available angles; clamped`);
	}
	const angles = HYPOTHESIS_ANGLES.slice(0, Math.max(1, Math.min(cfg.hypothesisCount, HYPOTHESIS_ANGLES.length)));
	const parallel = angles.map((a, i) => {
		const step = makeBriefStep(p, state, `hypothesis-${a.id}-brief`, hypothesisBrief(p, a, notes));
		return {
			agent: cfg.agents.hypothesis,
			task: step.task,
			label: `Hypothesis ${a.id}: ${a.angle}`,
			phase: "Architect",
			reads: [step.briefPath, p.frame],
			output: join(p.arch, `hypothesis-${a.id}.md`),
			outputMode: "file-only",
			...(state.codegraphReady ? { skill: "codegraph" } : {}),
			...withModel(cfg.models.hypothesis, i),
		};
	});

	const hypoPaths = angles.map((a) => join(p.arch, `hypothesis-${a.id}.md`));
	const judgeStep = makeBriefStep(p, state, "architect-judge-brief", architectJudgeBrief(p, angles.length, notes));

	return {
		kind: "architect",
		seq: state.seq,
		label: "Phase 2 — ARCHITECT",
		expects: [...hypoPaths, p.architecture],
		args: freshChain(p, state.seq, "architect", [
			// failFast: a dead hypothesis stops the chain before the judge spends.
			{ parallel, concurrency: angles.length, failFast: true },
			{
				agent: cfg.agents.architectJudge,
				task: judgeStep.task,
				label: "Judge hypotheses",
				phase: "Architect",
				reads: [judgeStep.briefPath, p.frame, ...hypoPaths],
				output: p.architecture,
				outputMode: "file-only",
				...withModel(cfg.models.architectJudge),
			},
		]),
	};
}

/** Re-judge only: one oracle run over the existing (frozen) hypothesis files.
 * Used for lint retries and selection-level gate revisions, so a malformed or
 * mis-judged document costs one strong-model run, not a full fan-out. */
export function architectJudgeDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	const hypos = hypothesisPaths(p);
	const judgeStep = makeBriefStep(p, state, "architect-rejudge-brief", architectJudgeBrief(p, hypos.length, notes));
	return {
		kind: "architect-judge",
		seq: state.seq,
		label: `Phase 2 — ARCHITECT: re-judge (round ${state.archRetries})`,
		expects: [p.architecture],
		args: freshChain(p, state.seq, `architect-rejudge-r${state.archRetries}`, [
			{
				agent: cfg.agents.architectJudge,
				task: judgeStep.task,
				label: "Re-judge hypotheses",
				phase: "Architect",
				reads: [judgeStep.briefPath, p.frame, ...hypos],
				output: p.architecture,
				outputMode: "file-only",
				...withModel(cfg.models.architectJudge),
			},
		]),
	};
}

/** The adversarial attack panel on the winning architecture: parallel
 * charter-bound attackers, then a synthesis step that dispositions every
 * objection and emits the ARCH-ATTACK marker. Runs once before the gate. */
export function archAttackDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	let seq = nextSeqIn(p.archAttacks);
	const tasks = ARCH_ATTACK_CHARTERS.slice(0, cfg.attackCount).map((charter, i) => {
		const outPath = join(p.archAttacks, `${pad3(seq)}-${charter.id}.md`);
		seq += 1;
		const step = makeBriefStep(p, state, `arch-attack-${charter.id}-brief`, archAttackBrief(p, charter.id, outPath));
		return {
			agent: cfg.agents.attack,
			task: step.task,
			label: `Arch attack: ${charter.id}`,
			phase: "Architect",
			skill: "architecture-attack",
			reads: [step.briefPath, p.frame, p.architecture],
			output: outPath,
			...withModel(cfg.models.attack, i),
		};
	});
	const attackPaths = tasks.map((t) => t.output);
	const dispoStep = makeBriefStep(p, state, "arch-disposition-brief", archDispositionBrief(p));
	return {
		kind: "arch-attack",
		seq: state.seq,
		label: "Phase 2 — ARCHITECT: attack panel + dispositions",
		expects: [...attackPaths, p.archDispositions],
		args: freshChain(p, state.seq, "arch-attack", [
			{ parallel: tasks, concurrency: tasks.length },
			{
				agent: cfg.agents.architectJudge,
				task: dispoStep.task,
				label: "Disposition attacks",
				phase: "Architect",
				skill: "architecture-attack",
				reads: [dispoStep.briefPath, p.frame, p.architecture, ...attackPaths],
				output: p.archDispositions,
				...withModel(cfg.models.architectJudge),
			},
		]),
	};
}

export function prototypeDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const parallel = Array.from({ length: cfg.prototypeCount }, (_, i) => {
		const n = i + 1;
		const step = makeBriefStep(p, state, `prototype-${n}-brief`, prototypeBrief(p, n, cfg.prototypeCount));
		return {
			agent: cfg.agents.prototype,
			task: step.task,
			label: `Prototype ${n}`,
			reads: [step.briefPath, p.frame, p.architecture],
			skill: "ui-prototyping",
			output: false,
			...withModel(cfg.models.prototype, i),
		};
	});

	const judgeStep = makeBriefStep(p, state, "prototype-judge-brief", prototypeJudgeBrief(p, cfg.prototypeCount));

	return {
		kind: "prototype",
		seq: state.seq,
		label: "Phase 3a — UI PROTOTYPES",
		args: freshChain(p, state.seq, "prototype", [
			{ parallel, concurrency: cfg.prototypeCount },
			{
				agent: cfg.agents.prototypeJudge,
				task: judgeStep.task,
				label: "Judge prototypes",
				phase: "Prototype",
				skill: "prototype-rubric",
				reads: [judgeStep.briefPath, p.frame, p.architecture],
				output: join(p.prototypes, "JUDGEMENT.md"),
				...withModel(cfg.models.prototypeJudge),
			},
		]),
	};
}

/** Re-judge only: one judge run over the existing (frozen) prototype dirs. Used
 * for lint retries and gate-revision re-judges, so a malformed judgement costs
 * one strong-model run, not a full prototype fan-out. */
export function prototypeJudgeDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	const judgeStep = makeBriefStep(p, state, "prototype-rejudge-brief", prototypeJudgeBrief(p, cfg.prototypeCount, notes));
	return {
		kind: "prototype-judge",
		seq: state.seq,
		label: `Phase 3a — PROTOTYPE: re-judge (round ${state.prototypeRetries})`,
		expects: [join(p.prototypes, "JUDGEMENT.md")],
		args: freshChain(p, state.seq, `prototype-rejudge-r${state.prototypeRetries}`, [
			{
				agent: cfg.agents.prototypeJudge,
				task: judgeStep.task,
				label: "Re-judge prototypes",
				phase: "Prototype",
				skill: "prototype-rubric",
				reads: [judgeStep.briefPath, p.frame, p.architecture],
				output: join(p.prototypes, "JUDGEMENT.md"),
				...withModel(cfg.models.prototypeJudge),
			},
		]),
	};
}

export function planDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	const step = makeBriefStep(p, state, "plan-brief", planBrief(p, state.ui, notes));
	const reads = [step.briefPath, p.frame, p.architecture];
	if (state.ui === "greenfield") reads.push(join(p.prototypes, "JUDGEMENT.md"));
	const skills = ["slice-rules"];
	if (state.ui === "existing") skills.push("design-guidelines");

	const judgeStep = makeBriefStep(p, state, "plan-judge-brief", planJudgeBrief(p));
	return {
		kind: "plan",
		seq: state.seq,
		label: `Phase 3 — PLAN${notes ? ` (retry ${state.planRetries})` : ""}`,
		expects: [p.plan, p.planJudgement],
		args: freshChain(p, state.seq, `plan${notes ? `-r${state.planRetries}` : ""}`, [
			{
				agent: cfg.agents.plan,
				task: step.task,
				label: "Write plan and slices",
				phase: "Plan",
				skill: skills,
				reads,
				output: p.plan,
				...withModel(cfg.models.plan),
			},
			{
				agent: cfg.agents.planJudge,
				task: judgeStep.task,
				label: "Judge plan decomposition",
				phase: "Plan",
				skill: "plan-rubric",
				// The planner writes p.plan and the slices in the prior step; the
				// judge enumerates p.slices/ itself (see the brief).
				reads: [judgeStep.briefPath, p.frame, p.architecture, p.plan],
				output: p.planJudgement,
				...withModel(cfg.models.planJudge),
			},
		]),
	};
}

/** The reviewer step appended to every build and fix-up chain. */
function reviewStep(p: Paths, state: State, cfg: SliceFlowConfig) {
	const a = sliceArtifacts(p, state);
	const step = makeBriefStep(p, state, `${a.sliceId}-review-r${state.fixupRound}-brief`, reviewBrief(a, state.fixupRound));
	return {
		agent: cfg.agents.review,
		task: step.task,
		label: `Review ${a.sliceId}${state.fixupRound > 0 ? ` (r${state.fixupRound})` : ""}`,
		phase: "Implement",
		// memoPath does not exist yet at compose time; the builder step writes it
		// before this reviewer step launches within the same chain.
		reads: [step.briefPath, a.slicePath, a.memoPath],
		output: a.reviewPath,
		...withModel(cfg.models.review),
	};
}

export function buildDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const a = sliceArtifacts(p, state);
	const step = makeBriefStep(p, state, `${a.sliceId}-build-brief`, buildBrief(p, a, cfg.autoCommit));
	return {
		kind: "build",
		seq: state.seq,
		label: `Phase 4 — BUILD ${a.sliceId} (${state.sliceIndex + 1}/${state.slices.length})`,
		args: freshChain(p, state.seq, a.sliceId, [
			{
				agent: cfg.agents.build,
				task: step.task,
				label: `Build ${a.sliceId}`,
				phase: "Implement",
				skill: state.codegraphReady ? ["codegraph", "slice-rules"] : "slice-rules",
				reads: [step.briefPath, a.slicePath, ...priorMemoPaths(p, state)],
				output: false,
				...withModel(cfg.models.build),
			},
			reviewStep(p, state, cfg),
		]),
	};
}

export function fixupDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const a = sliceArtifacts(p, state);
	const prevReview = join(p.reviews, `${a.sliceId}-r${state.fixupRound - 1}.md`);
	const step = makeBriefStep(p, state, `${a.sliceId}-fixup-r${state.fixupRound}-brief`, fixupBrief(a, state.fixupRound, cfg.autoCommit));
	return {
		kind: "fixup",
		seq: state.seq,
		label: `Phase 4 — FIX-UP ${a.sliceId} (round ${state.fixupRound})`,
		args: freshChain(p, state.seq, `${a.sliceId}-fixup-r${state.fixupRound}`, [
			{
				agent: cfg.agents.fixup,
				task: step.task,
				label: `Fix-up ${a.sliceId} r${state.fixupRound}`,
				phase: "Implement",
				skill: state.codegraphReady ? ["codegraph", "slice-rules"] : "slice-rules",
				reads: [step.briefPath, a.slicePath, a.memoPath, prevReview],
				output: false,
				...withModel(cfg.models.fixup),
			},
			reviewStep(p, state, cfg),
		]),
	};
}

function verifierTask(p: Paths, state: State, cfg: SliceFlowConfig, dim: VerifyDimension, i = 0) {
	const step = makeBriefStep(p, state, `verify-${dim}-brief`, verifierBrief(p, dim, state.baselineCommit, cfg.workDir));
	return {
		agent: cfg.agents.verify,
		task: step.task,
		reads: [step.briefPath, p.frame, p.architecture, p.plan],
		skill: "verify-rubrics",
		output: join(p.verify, `${dim}.md`),
		...withModel(cfg.models.verify, i),
	};
}

export function verifyDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	return {
		kind: "verify",
		seq: state.seq,
		label: "Phase 5 — VERIFY (5 dimensions, parallel)",
		args: freshParallel(VERIFY_DIMENSIONS.map((dim, i) => verifierTask(p, state, cfg, dim, i))),
	};
}

// --- Self-improvement: rubric reflection (T3b) -------------------------------

/** Absolute path to the package's bundled `skills/` directory. This module
 * lives at <pkg>/extensions/lib/directives.ts, so skills is two levels up. */
const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

/** The gates whose judge follows a tunable rubric skill, mapped to that skill.
 * `frame` is omitted: it is human-pinned (never auto-trusted) and its fidelity
 * judge tunes nothing. These are the judges `reflect` can propose edits for. */
export const REFLECT_RUBRICS: Record<string, string> = {
	architect: "architecture-attack",
	prototype: "prototype-rubric",
	plan: "plan-rubric",
	verify: "verify-rubrics",
};

/** Absolute path to a rubric skill's SKILL.md, the file a reflection proposes
 * diffs against (and the file it is forbidden to edit). */
export function rubricPathOf(skill: string, skillsDir: string = BUNDLED_SKILLS_DIR): string {
	return join(skillsDir, skill, "SKILL.md");
}

/**
 * One reflection run: a fresh oracle-judge reads the rubric skill and the
 * compiled override cases for `judge`, then writes proposed rubric edits to
 * reflect/<judge>-proposals.md for human review. Reuses the existing
 * oracle-judge agent with context:"fresh" and the briefs-as-files pattern; the
 * rubric skill is injected and also read so the agent can emit a precise diff.
 * It applies nothing — the brief forbids editing the skill or any source file.
 */
export function reflectDirective(r: ReflectPaths, cfg: SliceFlowConfig, judge: string, seq: number): Directive {
	const skill = REFLECT_RUBRICS[judge];
	if (!skill) throw new Error(`Unknown reflect judge "${judge}". Known: ${Object.keys(REFLECT_RUBRICS).join(", ")}.`);
	const rubricPath = rubricPathOf(skill);
	const casesPath = r.casesOf(judge);
	const proposalsPath = r.proposalsOf(judge);
	const briefPath = join(r.logs, `${pad3(seq)}-reflect-${judge}-brief.md`);
	writeFileSync(briefPath, reflectBrief(judge, rubricPath, casesPath), "utf8");
	return {
		kind: "reflect",
		seq,
		label: `Reflect on the ${judge} rubric`,
		expects: [proposalsPath],
		args: {
			chain: [
				{
					// oracle-judge: every *Judge agent resolves to slice-flow-oracle-judge.
					agent: cfg.agents.planJudge,
					task: `Your complete task brief is the injected file ${briefPath}. Execute it exactly. It overrides any conflicting default behavior.`,
					label: `Reflect: ${judge} rubric`,
					phase: "Reflect",
					skill,
					reads: [briefPath, casesPath, rubricPath],
					output: proposalsPath,
					...withModel(cfg.models.planJudge),
				},
			],
			context: "fresh",
			clarify: false,
			chainDir: join(r.chains, `${pad3(seq)}-reflect-${judge}`),
		},
	};
}

/** The weighted spawn cost of the loop iteration `loopDirective` is about to
 * issue, in opus-equivalent spawns. Resolves each spawn's model exactly as the
 * directive does (fixers at `models.fixup` index 0; verifiers at `models.verify`
 * round-robin) so enforcement can never drift from what is actually spawned. */
export function loopIterationCost(state: State, cfg: SliceFlowConfig): number {
	const fixCost = state.failedDimensions.length * modelWeight(modelAt(cfg.models.fixup), cfg.modelWeights);
	const reVerifyCount = cfg.reverifyAllInLoop ? VERIFY_DIMENSIONS.length : state.failedDimensions.length;
	let verifyCost = 0;
	for (let i = 0; i < reVerifyCount; i++) {
		verifyCost += modelWeight(modelAt(cfg.models.verify, i), cfg.modelWeights);
	}
	return fixCost + verifyCost;
}

export function loopDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const fixSteps = state.failedDimensions.map((dim) => {
		const step = makeBriefStep(p, state, `loop-${state.loopIteration}-fix-${dim}-brief`, loopFixBrief(p, dim, state.loopIteration, cfg.autoCommit));
		return {
			agent: cfg.agents.fixup,
			task: step.task,
			label: `Fix ${dim} (loop ${state.loopIteration})`,
			phase: "Loop",
			skill: "slice-rules",
			reads: [step.briefPath, join(p.verify, `${dim}.md`), p.plan],
			output: false,
			...withModel(cfg.models.fixup),
		};
	});
	// Re-verify ALL dimensions (not just the failed ones) so a fix that
	// regresses a previously-passing dimension cannot reach `done` on a stale
	// PASS verdict left on disk from before the fix ran. Each verifier rewrites
	// its own verify/<dim>.md, so onVerified always reads fresh evidence.
	// reverifyAllInLoop=false restores the cheaper failed-only behavior.
	const reVerifyDims = cfg.reverifyAllInLoop ? VERIFY_DIMENSIONS : state.failedDimensions;
	const reVerify = reVerifyDims.map((dim, i) => ({
		...verifierTask(p, state, cfg, dim, i),
		label: state.failedDimensions.includes(dim) ? `Re-verify ${dim}` : `Regression-check ${dim}`,
	}));
	return {
		kind: "loop-fix",
		seq: state.seq,
		label: `Phase 6 — LOOP iteration ${state.loopIteration} (${state.failedDimensions.join(", ")})`,
		args: freshChain(p, state.seq, `loop-${state.loopIteration}`, [
			...fixSteps,
			{ parallel: reVerify, concurrency: reVerify.length },
		]),
	};
}
