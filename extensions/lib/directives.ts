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
import { join } from "node:path";
import type { SliceFlowConfig } from "./config.ts";
import {
	ATTACK_CHARTERS,
	HYPOTHESIS_ANGLES,
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
	prototypeBrief,
	prototypeJudgeBrief,
	researchBrief,
	reviewBrief,
	verifierBrief,
} from "./briefs.ts";
import { VERIFY_DIMENSIONS, nextSeqIn, pad3, priorMemoPaths, sliceArtifacts, slugify } from "./workspace.ts";
import type { Directive, Paths, State, VerifyDimension } from "./workspace.ts";

// --- DRY building blocks -----------------------------------------------------

/** Spread helper: include `model` only when configured (null inherits the session default). */
function withModel(model: string | null): { model?: string } {
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
				agent: "scout",
				task: step.task,
				label: "Intake check",
				phase: "Frame",
				reads: [step.briefPath],
				output: p.intake,
				...withModel(cfg.models.intake),
			},
		]),
	};
}

export function researchDirective(p: Paths, state: State, cfg: SliceFlowConfig, questions: string[]): Directive {
	let seq = nextSeqIn(p.frameResearch);
	const tasks = questions.map((q) => {
		const outPath = join(p.frameResearch, `${pad3(seq)}-${slugify(q)}.md`);
		seq += 1;
		const step = makeBriefStep(p, state, `research-${slugify(q, 4)}-brief`, researchBrief(state.feature, q, outPath));
		return {
			agent: "researcher",
			task: step.task,
			label: `Research: ${q.slice(0, 60)}`,
			reads: [step.briefPath],
			output: outPath,
			...withModel(cfg.models.research),
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
	const tasks = ATTACK_CHARTERS.slice(0, cfg.attackCount).map((charter) => {
		const outPath = join(p.frameAttacks, `${pad3(seq)}-${charter.id}.md`);
		seq += 1;
		const step = makeBriefStep(p, state, `attack-${charter.id}-brief`, attackBrief(p, state.feature, charter, outPath));
		return {
			agent: "oracle",
			task: step.task,
			label: `Attack: ${charter.id}`,
			reads: [step.briefPath, p.ledger, p.intake],
			output: outPath,
			...withModel(cfg.models.attack),
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
				agent: "scout",
				task: compileStep.task,
				label: "Compile frame from ledger",
				phase: "Frame",
				skill: "zinsser-framing",
				reads: compileReads,
				output: p.frame,
				...withModel(cfg.models.compile),
			},
			{
				agent: "oracle",
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
	const angles = HYPOTHESIS_ANGLES.slice(0, cfg.hypothesisCount);
	const parallel = angles.map((a) => {
		const step = makeBriefStep(p, state, `hypothesis-${a.id}-brief`, hypothesisBrief(p, a, notes));
		return {
			agent: "scout",
			task: step.task,
			label: `Hypothesis ${a.id}: ${a.angle}`,
			reads: [step.briefPath, p.frame],
			output: join(p.arch, `hypothesis-${a.id}.md`),
			...withModel(cfg.models.hypothesis),
		};
	});

	const hypoPaths = angles.map((a) => join(p.arch, `hypothesis-${a.id}.md`));
	const judgeStep = makeBriefStep(p, state, "architect-judge-brief", architectJudgeBrief(p, angles.length));

	return {
		kind: "architect",
		seq: state.seq,
		label: "Phase 2 — ARCHITECT",
		args: freshChain(p, state.seq, "architect", [
			{ parallel, concurrency: angles.length },
			{
				agent: "oracle",
				task: judgeStep.task,
				label: "Judge hypotheses",
				phase: "Architect",
				reads: [judgeStep.briefPath, p.frame, ...hypoPaths],
				output: p.architecture,
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
			agent: "worker",
			task: step.task,
			label: `Prototype ${n}`,
			reads: [step.briefPath, p.frame, p.architecture],
			skill: "ui-prototyping",
			output: false,
			...withModel(cfg.models.prototype),
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
				agent: "oracle",
				task: judgeStep.task,
				label: "Judge prototypes",
				phase: "Prototype",
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

	return {
		kind: "plan",
		seq: state.seq,
		label: "Phase 3 — PLAN",
		args: freshChain(p, state.seq, "plan", [
			{
				agent: "planner",
				task: step.task,
				label: "Write plan and slices",
				phase: "Plan",
				skill: skills,
				reads,
				output: p.plan,
				...withModel(cfg.models.plan),
			},
		]),
	};
}

/** The reviewer step appended to every build and fix-up chain. */
function reviewStep(p: Paths, state: State, cfg: SliceFlowConfig) {
	const a = sliceArtifacts(p, state);
	const step = makeBriefStep(p, state, `${a.sliceId}-review-r${state.fixupRound}-brief`, reviewBrief(a, state.fixupRound));
	return {
		agent: "reviewer",
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
				agent: "worker",
				task: step.task,
				label: `Build ${a.sliceId}`,
				phase: "Implement",
				skill: "slice-rules",
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
				agent: "worker",
				task: step.task,
				label: `Fix-up ${a.sliceId} r${state.fixupRound}`,
				phase: "Implement",
				skill: "slice-rules",
				reads: [step.briefPath, a.slicePath, a.memoPath, prevReview],
				output: false,
				...withModel(cfg.models.fixup),
			},
			reviewStep(p, state, cfg),
		]),
	};
}

function verifierTask(p: Paths, state: State, cfg: SliceFlowConfig, dim: VerifyDimension) {
	const step = makeBriefStep(p, state, `verify-${dim}-brief`, verifierBrief(p, dim, state.baselineCommit, cfg.workDir));
	return {
		agent: "reviewer",
		task: step.task,
		reads: [step.briefPath, p.frame, p.architecture, p.plan],
		skill: "verify-rubrics",
		output: join(p.verify, `${dim}.md`),
		...withModel(cfg.models.verify),
	};
}

export function verifyDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	return {
		kind: "verify",
		seq: state.seq,
		label: "Phase 5 — VERIFY (5 dimensions, parallel)",
		args: freshParallel(VERIFY_DIMENSIONS.map((dim) => verifierTask(p, state, cfg, dim))),
	};
}

export function loopDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const fixSteps = state.failedDimensions.map((dim) => {
		const step = makeBriefStep(p, state, `loop-${state.loopIteration}-fix-${dim}-brief`, loopFixBrief(p, dim, state.loopIteration, cfg.autoCommit));
		return {
			agent: "worker",
			task: step.task,
			label: `Fix ${dim} (loop ${state.loopIteration})`,
			phase: "Loop",
			skill: "slice-rules",
			reads: [step.briefPath, join(p.verify, `${dim}.md`), p.plan],
			output: false,
			...withModel(cfg.models.fixup),
		};
	});
	const reVerify = state.failedDimensions.map((dim) => ({
		...verifierTask(p, state, cfg, dim),
		label: `Re-verify ${dim}`,
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
