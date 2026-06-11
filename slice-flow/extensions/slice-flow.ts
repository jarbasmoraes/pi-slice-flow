/**
 * slice-flow — six-phase feature development workflow orchestrator.
 *
 * Thin by design: this extension only manages state, approval gates, logging,
 * and directive sequencing. All judgment lives in skills (zinsser-framing,
 * slice-rules, reviewer-solid, verify-rubrics) and all agent spawning is
 * delegated to the pi-subagents extension: the parent agent is handed exact
 * `subagent` tool arguments (chains for sequential phases, parallel tasks for
 * fan-outs) and invokes them verbatim.
 *
 * Every spawned agent runs with context: "fresh" — a new Pi instance with no
 * parent conversation history. Full task briefs are written to
 * ./feature-work/logs/ and injected into children via `reads`, so every
 * prompt is inspectable on disk and never retyped by the parent LLM.
 *
 * All state persists to ./feature-work/state.json; no phase depends on
 * conversation memory, so the workflow survives restarts and /reload.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VERIFY_DIMENSIONS = ["code-quality", "simplicity", "security", "evals", "tests"] as const;
type VerifyDimension = (typeof VERIFY_DIMENSIONS)[number];

const HYPOTHESIS_ANGLES = [
	{ id: 1, angle: "minimal-change", brief: "Optimize for the smallest possible diff and maximum reuse of code that already exists." },
	{ id: 2, angle: "pattern-aligned", brief: "Optimize for the most faithful fit with the architecture patterns already established in this repository." },
	{ id: 3, angle: "evolvable", brief: "Optimize for reversibility and ease of future extension, even at the cost of a slightly larger initial change." },
];

interface SliceFlowConfig {
	workDir: string;
	hypothesisCount: number;
	prototypeCount: number;
	maxLoopIterations: number;
	maxFixupsPerSlice: number;
	loopTokenBudget: number;
	autoCommit: boolean;
	autoApprove: boolean;
	gitignoreWorkDir: boolean;
	models: {
		frame: string | null;
		hypothesis: string | null;
		architectJudge: string | null;
		prototype: string | null;
		prototypeJudge: string | null;
		plan: string | null;
		build: string | null;
		review: string | null;
		fixup: string | null;
		verify: string | null;
	};
}

/** Defaults: cheap model for discovery and fix-ups, strong model for
 * architecture judging and verification, session default (null) for build. */
const DEFAULT_CONFIG: SliceFlowConfig = {
	workDir: "feature-work",
	hypothesisCount: 3,
	prototypeCount: 5,
	maxLoopIterations: 5,
	maxFixupsPerSlice: 2,
	loopTokenBudget: 1_500_000,
	autoCommit: true,
	autoApprove: false,
	gitignoreWorkDir: true,
	models: {
		frame: "anthropic/claude-haiku-4-5",
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

function loadConfig(cwd: string): SliceFlowConfig {
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Phase = "frame" | "architect" | "prototype" | "plan" | "implement" | "verify" | "loop" | "done" | "stopped";

interface Directive {
	kind: string; // frame | architect | prototype | plan | build | fixup | verify | loop-fix
	seq: number;
	label: string;
	args: Record<string, unknown>; // exact subagent tool input
}

interface State {
	version: 1;
	feature: string;
	createdAt: string;
	updatedAt: string;
	baselineCommit: string | null;
	phase: Phase;
	pending: Directive | null;
	ui: "none" | "greenfield" | "existing" | null;
	slices: string[]; // slice file basenames, in order
	sliceIndex: number;
	fixupRound: number; // 0 = initial build; 1..maxFixupsPerSlice = fix-up rounds
	loopIteration: number;
	failedDimensions: VerifyDimension[];
	tokensSpent: number; // best-effort estimate across all subagent runs
	loopStartTokens: number;
	seq: number;
	log: Array<{ ts: string; event: string }>;
}

interface Paths {
	root: string;
	state: string;
	logs: string;
	calls: string;
	chains: string;
	arch: string;
	slices: string;
	memos: string;
	reviews: string;
	verify: string;
	prototypes: string;
	frame: string;
	architecture: string;
	plan: string;
	report: string;
}

function workPaths(cwd: string, cfg: SliceFlowConfig): Paths {
	const root = resolve(cwd, cfg.workDir);
	return {
		root,
		state: join(root, "state.json"),
		logs: join(root, "logs"),
		calls: join(root, "logs", "calls"),
		chains: join(root, "chains"),
		arch: join(root, "arch"),
		slices: join(root, "slices"),
		memos: join(root, "memos"),
		reviews: join(root, "reviews"),
		verify: join(root, "verify"),
		prototypes: join(root, "prototypes"),
		frame: join(root, "01-frame.md"),
		architecture: join(root, "02-architecture.md"),
		plan: join(root, "03-plan.md"),
		report: join(root, "REPORT.md"),
	};
}

function loadState(p: Paths): State | null {
	if (!existsSync(p.state)) return null;
	return JSON.parse(readFileSync(p.state, "utf8")) as State;
}

function saveState(p: Paths, state: State): void {
	state.updatedAt = new Date().toISOString();
	writeFileSync(p.state, JSON.stringify(state, null, 2), "utf8");
}

function logEvent(state: State, event: string): void {
	state.log.push({ ts: new Date().toISOString(), event });
}

function nonEmpty(file: string): boolean {
	try {
		return existsSync(file) && readFileSync(file, "utf8").trim().length > 0;
	} catch {
		return false;
	}
}

/** First `VERDICT: PASS|FAIL` found in a file; null when absent/missing. */
function verdictOf(file: string): "PASS" | "FAIL" | null {
	if (!existsSync(file)) return null;
	const match = readFileSync(file, "utf8").match(/VERDICT:\s*(PASS|FAIL)/i);
	return match ? (match[1].toUpperCase() as "PASS" | "FAIL") : null;
}

function pad3(n: number): string {
	return String(n).padStart(3, "0");
}

// ---------------------------------------------------------------------------
// Briefs and directives
// ---------------------------------------------------------------------------

/** Write a full task brief to logs/ and return a chain-step/task spec whose
 * short task points at the injected brief. Keeps prompts inspectable on disk
 * and stops the parent LLM from retyping (and mutating) long prompts. */
function makeBriefStep(p: Paths, state: State, slug: string, briefText: string): { briefPath: string; task: string } {
	state.seq += 1;
	const briefPath = join(p.logs, `${pad3(state.seq)}-${slug}.md`);
	writeFileSync(briefPath, briefText, "utf8");
	return {
		briefPath,
		task: `Your complete task brief is the injected file ${briefPath}. Execute it exactly. It overrides any conflicting default behavior.`,
	};
}

function logDirective(p: Paths, directive: Directive): void {
	writeFileSync(
		join(p.logs, `${pad3(directive.seq)}-directive-${directive.kind}.json`),
		JSON.stringify({ ts: new Date().toISOString(), ...directive }, null, 2),
		"utf8",
	);
}

const VERDICT_RULE = `The very first line of your final answer MUST be exactly "VERDICT: PASS" or "VERDICT: FAIL" — nothing before it.`;

function frameDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	const brief = `# FRAME the feature

Feature request: ${state.feature}

You are the framing agent for a feature workflow. Apply the injected zinsser-framing skill.

1. Review the existing code relevant to this feature: entry points, current behavior, the modules a change would touch. Cite real file paths.
2. Your final answer must be the complete frame document (it is saved automatically to ${p.frame}). Required sections, each as single-sentence declarative bullet points:
   - **Problem** — what is wrong or missing.
   - **What the code does today** — current behavior with file references.
   - **Proposed solution** — what will change.
   - **Why this solves the problem** — the causal link, bullet by bullet.

Do not edit any project files. Do not include filler, hedging, or process narration in the document.
${notes ? `\nRevision requested by the user — address these notes and rewrite the full document:\n${notes}\nYour previous frame is injected for reference.` : ""}`;
	const step = makeBriefStep(p, state, "frame-brief", brief);
	const reads = [step.briefPath];
	if (notes && existsSync(p.frame)) reads.push(p.frame);
	return {
		kind: "frame",
		seq: state.seq,
		label: "Phase 1 — FRAME",
		args: {
			chain: [
				{
					agent: "scout",
					task: step.task,
					label: "Frame the feature",
					phase: "Frame",
					skill: "zinsser-framing",
					reads,
					output: p.frame,
					...(cfg.models.frame ? { model: cfg.models.frame } : {}),
				},
			],
			context: "fresh",
			clarify: false,
			chainDir: join(p.chains, `${pad3(state.seq)}-frame`),
		},
	};
}

function architectDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	const angles = HYPOTHESIS_ANGLES.slice(0, cfg.hypothesisCount);
	const parallel = angles.map((a) => {
		const brief = `# Architecture hypothesis ${a.id}: ${a.angle}

The approved frame document is injected. ${a.brief}

Review the actual codebase before proposing anything. Then produce ONE architecture hypothesis as your final answer (saved automatically to ${join(p.arch, `hypothesis-${a.id}.md`)}). Required sections:

1. **Summary** — one paragraph.
2. **Diagram** — a Mermaid diagram (fenced \`\`\`mermaid block) of the proposed structure.
3. **Components** — each component, its responsibility, and the file(s) it lives in.
4. **Data flow** — how data moves through the components for the main use case.
5. **Why this is good** — concrete advantages, grounded in the frame and the existing code.
6. **What would falsify this** — the observations or constraints that would prove this design wrong.

Do not edit any project files.
${notes ? `\nUser revision notes from the previous round:\n${notes}` : ""}`;
		const step = makeBriefStep(p, state, `hypothesis-${a.id}-brief`, brief);
		return {
			agent: "scout",
			task: step.task,
			label: `Hypothesis ${a.id}: ${a.angle}`,
			reads: [step.briefPath, p.frame],
			output: join(p.arch, `hypothesis-${a.id}.md`),
			...(cfg.models.hypothesis ? { model: cfg.models.hypothesis } : {}),
		};
	});

	const hypoPaths = angles.map((a) => join(p.arch, `hypothesis-${a.id}.md`));
	const judgeBrief = `# Judge the architecture hypotheses

The frame document and ${angles.length} competing architecture hypotheses are injected. You are the judge; you do not design, you decide.

Score every hypothesis 1-5 on each criterion:
- **Fit with the frame** — does it solve the stated problem, all of it, and nothing else?
- **Simplicity** — fewest moving parts that still work.
- **Fit with existing repo patterns** — verify against the actual code, not the hypothesis's own claims.
- **Reversibility** — how cheaply could this be undone or redirected?

Your final answer must be the complete architecture document (saved automatically to ${p.architecture}):

1. **Winner** — name it, and reproduce its full architecture: summary, Mermaid diagram, components, data flow.
2. **Scores** — a table of all hypotheses against all criteria.
3. **Why the losers lost** — per losing hypothesis, the decisive weakness in one or two sentences.
4. **Risks carried forward** — what the winner's "falsify" section says to watch for.

Do not edit any project files.`;
	const judgeStep = makeBriefStep(p, state, "architect-judge-brief", judgeBrief);

	return {
		kind: "architect",
		seq: state.seq,
		label: "Phase 2 — ARCHITECT",
		args: {
			chain: [
				{ parallel, concurrency: angles.length },
				{
					agent: "oracle",
					task: judgeStep.task,
					label: "Judge hypotheses",
					phase: "Architect",
					reads: [judgeStep.briefPath, p.frame, ...hypoPaths],
					output: p.architecture,
					...(cfg.models.architectJudge ? { model: cfg.models.architectJudge } : {}),
				},
			],
			context: "fresh",
			clarify: false,
			chainDir: join(p.chains, `${pad3(state.seq)}-architect`),
		},
	};
}

function prototypeDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const parallel = Array.from({ length: cfg.prototypeCount }, (_, i) => {
		const n = i + 1;
		const dir = join(p.prototypes, `proto-${n}`);
		const brief = `# UI prototype ${n} of ${cfg.prototypeCount}

The frame and approved architecture are injected. Apply the injected ui-prototyping skill.

Build a self-contained, runnable UI prototype of this feature in ${dir}/ — create the directory. Take a distinct stylistic and structural direction from what other prototypes might choose; prototype ${n} should feel like its own answer, not a variation.

Hard rules:
- Write ONLY inside ${dir}/. Never touch project source files.
- Include a README.md in the prototype directory explaining how to open/run it and what direction you took.
- Favor zero-build artifacts (single HTML file, or the project's existing dev stack mirrored locally) so the user can open it instantly.`;
		const step = makeBriefStep(p, state, `prototype-${n}-brief`, brief);
		return {
			agent: "worker",
			task: step.task,
			label: `Prototype ${n}`,
			reads: [step.briefPath, p.frame, p.architecture],
			skill: "ui-prototyping",
			output: false,
			...(cfg.models.prototype ? { model: cfg.models.prototype } : {}),
		};
	});

	const judgeBrief = `# Judge the UI prototypes

${cfg.prototypeCount} prototypes live in ${p.prototypes}/proto-1 .. proto-${cfg.prototypeCount}. The frame and architecture are injected.

Inspect every prototype's code and README. Your final answer is saved automatically to ${join(p.prototypes, "JUDGEMENT.md")} and must contain:

1. **Winner** — the winning directory name and a description of its direction precise enough that a planner who never sees the prototype can specify the real UI from it.
2. **Why it won** — fit with the frame, clarity, and feasibility within the approved architecture.
3. **Per-loser verdict** — one sentence each on why it lost.
4. **Salvage** — any specific ideas from losing prototypes worth folding into the plan.

Do not edit any files.`;
	const judgeStep = makeBriefStep(p, state, "prototype-judge-brief", judgeBrief);

	return {
		kind: "prototype",
		seq: state.seq,
		label: "Phase 3a — UI PROTOTYPES",
		args: {
			chain: [
				{ parallel, concurrency: cfg.prototypeCount },
				{
					agent: "oracle",
					task: judgeStep.task,
					label: "Judge prototypes",
					phase: "Prototype",
					reads: [judgeStep.briefPath, p.frame, p.architecture],
					output: join(p.prototypes, "JUDGEMENT.md"),
					...(cfg.models.prototypeJudge ? { model: cfg.models.prototypeJudge } : {}),
				},
			],
			context: "fresh",
			clarify: false,
			chainDir: join(p.chains, `${pad3(state.seq)}-prototype`),
		},
	};
}

function planDirective(p: Paths, state: State, cfg: SliceFlowConfig, notes?: string): Directive {
	const uiInstructions =
		state.ui === "greenfield"
			? `This feature has new (greenfield) UI. The prototype judgement is injected; the plan's UI portions must realize the winning prototype's direction.`
			: state.ui === "existing"
				? `This feature extends an EXISTING UI. Apply the injected design-guidelines skill and conform strictly to the UI patterns already present in this repository. Do not invent new visual patterns.`
				: `This feature has no UI work.`;

	const brief = `# Plan the implementation

The frame and approved architecture are injected. Apply the injected slice-rules skill — it defines the slice file format and sizing rules.

${uiInstructions}

Produce two things:

1. **The plan document** — your final answer, saved automatically to ${p.plan}. It must cover: the implementation approach; code snippets for every critical path (the parts where getting it wrong is expensive); test strategy; and an ordered slice index.
2. **Slice files** — write each slice with your write tool to ${p.slices}/NNN-<slug>.md (001, 002, ...), following the slice file format from slice-rules exactly. Slice 001 is the smallest WORKING end-to-end MVP of the feature; later slices iterate from that MVP toward the full plan. Size every slice for roughly 100 lines of implementation change.

Each slice file must be a self-sufficient contract: a builder who sees ONLY that slice file (plus memos of prior slices) must be able to implement it. Never assume the builder has read this plan.

Do not edit project source files — you only write under ${p.slices}/.
${notes ? `\nUser revision notes from the previous round — address them and rewrite plan and slices:\n${notes}` : ""}`;
	const step = makeBriefStep(p, state, "plan-brief", brief);
	const reads = [step.briefPath, p.frame, p.architecture];
	if (state.ui === "greenfield") reads.push(join(p.prototypes, "JUDGEMENT.md"));
	const skills = ["slice-rules"];
	if (state.ui === "existing") skills.push("design-guidelines");

	return {
		kind: "plan",
		seq: state.seq,
		label: "Phase 3 — PLAN",
		args: {
			chain: [
				{
					agent: "planner",
					task: step.task,
					label: "Write plan and slices",
					phase: "Plan",
					skill: skills,
					reads,
					output: p.plan,
					...(cfg.models.plan ? { model: cfg.models.plan } : {}),
				},
			],
			context: "fresh",
			clarify: false,
			chainDir: join(p.chains, `${pad3(state.seq)}-plan`),
		},
	};
}

function priorMemoPaths(p: Paths, state: State): string[] {
	return state.slices
		.slice(0, state.sliceIndex)
		.map((s) => join(p.memos, `${s.replace(/\.md$/, "")}.md`))
		.filter((f) => existsSync(f));
}

function sliceArtifacts(p: Paths, state: State) {
	const sliceFile = state.slices[state.sliceIndex];
	const sliceId = sliceFile.replace(/\.md$/, "");
	return {
		sliceFile,
		sliceId,
		slicePath: join(p.slices, sliceFile),
		memoPath: join(p.memos, `${sliceId}.md`),
		reviewPath: join(p.reviews, `${sliceId}-r${state.fixupRound}.md`),
	};
}

function reviewStep(p: Paths, state: State, cfg: SliceFlowConfig, kindLabel: string) {
	const a = sliceArtifacts(p, state);
	const brief = `# Review ${a.sliceId}${state.fixupRound > 0 ? ` (after fix-up round ${state.fixupRound})` : ""}

You are a fresh-context reviewer. The slice contract and the builder's memo are injected. Apply the injected reviewer-solid skill — it defines the review criteria.

Inspect the actual changes: the memo lists changed files and commit hash(es); use git (e.g. \`git show <hash>\`, \`git diff <hash>^..<hash>\`) and read the files directly. Judge ONLY this slice against its contract and the reviewer-solid criteria.

${VERDICT_RULE}
After the verdict line, list findings: each with file, line, severity (blocker|major|minor), and reason. PASS is allowed with minor findings; any blocker or major finding means FAIL. Your final answer is saved automatically to ${a.reviewPath}.

You are review-only: do not edit, fix, or commit anything.`;
	const step = makeBriefStep(p, state, `${a.sliceId}-review-r${state.fixupRound}-brief`, brief);
	return {
		agent: "reviewer",
		task: step.task,
		label: `Review ${a.sliceId}${state.fixupRound > 0 ? ` (r${state.fixupRound})` : ""}`,
		phase: kindLabel,
		// memoPath does not exist yet at compose time; the builder step writes it
		// before this reviewer step launches within the same chain.
		reads: [step.briefPath, a.slicePath, a.memoPath],
		output: a.reviewPath,
		...(cfg.models.review ? { model: cfg.models.review } : {}),
	};
}

function buildDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const a = sliceArtifacts(p, state);
	const memos = priorMemoPaths(p, state);
	const brief = `# Build ${a.sliceId}

You are a fresh-context builder. Your ONLY contract is the injected slice file ${a.slicePath}. Memos from previously completed slices are injected as READ-ONLY context — they tell you what already exists; never re-do or modify their scope beyond what your slice demands.

Apply the injected slice-rules skill. It is binding: TDD-first, scope discipline, the ~100 LOC budget and its escalation rule, and the required post-build memo.

Hard requirements:
1. Implement exactly what the slice specifies. Nothing more.
2. Tests first, then implementation, then run the tests and make them pass.
3. ${cfg.autoCommit ? "Commit your work as ONE commit (auto_commit is enabled). Do not push." : "Do NOT commit (auto_commit is disabled); leave changes in the working tree."}
4. Write your memo to ${a.memoPath} following the memo format in slice-rules. The memo MUST list every changed file${cfg.autoCommit ? " and the commit hash" : ""}.
5. Never touch ${p.root} except to write the memo.`;
	const step = makeBriefStep(p, state, `${a.sliceId}-build-brief`, brief);
	return {
		kind: "build",
		seq: state.seq,
		label: `Phase 4 — BUILD ${a.sliceId} (${state.sliceIndex + 1}/${state.slices.length})`,
		args: {
			chain: [
				{
					agent: "worker",
					task: step.task,
					label: `Build ${a.sliceId}`,
					phase: "Implement",
					skill: "slice-rules",
					reads: [step.briefPath, a.slicePath, ...memos],
					output: false,
					...(cfg.models.build ? { model: cfg.models.build } : {}),
				},
				reviewStep(p, state, cfg, "Implement"),
			],
			context: "fresh",
			clarify: false,
			chainDir: join(p.chains, `${pad3(state.seq)}-${a.sliceId}`),
		},
	};
}

function fixupDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const a = sliceArtifacts(p, state);
	const prevReview = join(p.reviews, `${a.sliceId}-r${state.fixupRound - 1}.md`);
	const brief = `# Fix-up ${a.sliceId} (round ${state.fixupRound})

You are a fresh-context fix-up agent with a deliberately narrow scope. The slice contract, the builder's memo, and the failed review are injected. Apply the injected slice-rules skill.

Hard requirements:
1. Fix ONLY the blocker and major findings listed in the review. Do not refactor beyond them, do not expand scope.
2. Keep tests green; add a test when a finding reveals a missing one.
3. ${cfg.autoCommit ? "Commit the fix as one commit. Do not push." : "Do NOT commit; leave changes in the working tree."}
4. Append a "## Fix-up round ${state.fixupRound}" section to the memo ${a.memoPath}: what you changed, files touched${cfg.autoCommit ? ", commit hash" : ""}.`;
	const step = makeBriefStep(p, state, `${a.sliceId}-fixup-r${state.fixupRound}-brief`, brief);
	return {
		kind: "fixup",
		seq: state.seq,
		label: `Phase 4 — FIX-UP ${a.sliceId} (round ${state.fixupRound})`,
		args: {
			chain: [
				{
					agent: "worker",
					task: step.task,
					label: `Fix-up ${a.sliceId} r${state.fixupRound}`,
					phase: "Implement",
					skill: "slice-rules",
					reads: [step.briefPath, a.slicePath, a.memoPath, prevReview],
					output: false,
					...(cfg.models.fixup ? { model: cfg.models.fixup } : {}),
				},
				reviewStep(p, state, cfg, "Implement"),
			],
			context: "fresh",
			clarify: false,
			chainDir: join(p.chains, `${pad3(state.seq)}-${a.sliceId}-fixup-r${state.fixupRound}`),
		},
	};
}

function verifierTask(p: Paths, state: State, cfg: SliceFlowConfig, dim: VerifyDimension) {
	const diffCmd = state.baselineCommit ? `git diff ${state.baselineCommit}..HEAD` : "git diff";
	const brief = `# Verify dimension: ${dim}

You are an independent verifier with fresh context. You did not build this code; assume the builders were wrong somewhere and your job is to find where. REFUTE, do not confirm: actively hunt for evidence that the implementation FAILS the "${dim}" dimension. A PASS is only earned when honest refutation attempts come up empty.

Apply the injected verify-rubrics skill and use ONLY the "${dim}" rubric.

Scope of evidence:
- The full diff: run \`${diffCmd}\` (exclude the ${cfg.workDir}/ directory from judgment — it is workflow metadata).
- The injected frame, architecture, and plan documents — the implementation must serve them.
- Run things when the rubric calls for it (tests, linters, the code itself).

${VERDICT_RULE}
After the verdict line, list every finding with: file, line, reason, and severity (blocker|major|minor). Any blocker or major finding means FAIL. Your final answer is saved automatically to ${join(p.verify, `${dim}.md`)}.

You are read/run-only: never edit or commit.`;
	const step = makeBriefStep(p, state, `verify-${dim}-brief`, brief);
	return {
		agent: "reviewer",
		task: step.task,
		reads: [step.briefPath, p.frame, p.architecture, p.plan],
		skill: "verify-rubrics",
		output: join(p.verify, `${dim}.md`),
		...(cfg.models.verify ? { model: cfg.models.verify } : {}),
	};
}

function verifyDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const tasks = VERIFY_DIMENSIONS.map((dim) => verifierTask(p, state, cfg, dim));
	return {
		kind: "verify",
		seq: state.seq,
		label: "Phase 5 — VERIFY (5 dimensions, parallel)",
		args: {
			tasks,
			concurrency: VERIFY_DIMENSIONS.length,
			context: "fresh",
			clarify: false,
		},
	};
}

function loopDirective(p: Paths, state: State, cfg: SliceFlowConfig): Directive {
	const fixSteps = state.failedDimensions.map((dim) => {
		const brief = `# Loop fix-up: ${dim} (iteration ${state.loopIteration})

The "${dim}" verifier returned FAIL. Its findings are injected (${join(p.verify, `${dim}.md`)}), along with the plan. Apply the injected slice-rules skill for discipline.

Hard requirements:
1. Fix ONLY the blocker and major findings in that verify report. No scope creep.
2. Keep all tests green.
3. ${cfg.autoCommit ? `Commit as one commit with message "fix(${dim}): address verifier findings (loop ${state.loopIteration})". Do not push.` : "Do NOT commit."}`;
		const step = makeBriefStep(p, state, `loop-${state.loopIteration}-fix-${dim}-brief`, brief);
		return {
			agent: "worker",
			task: step.task,
			label: `Fix ${dim} (loop ${state.loopIteration})`,
			phase: "Loop",
			skill: "slice-rules",
			reads: [step.briefPath, join(p.verify, `${dim}.md`), p.plan],
			output: false,
			...(cfg.models.fixup ? { model: cfg.models.fixup } : {}),
		};
	});
	const reVerify = state.failedDimensions.map((dim) => {
		const t = verifierTask(p, state, cfg, dim);
		return { ...t, label: `Re-verify ${dim}` };
	});
	return {
		kind: "loop-fix",
		seq: state.seq,
		label: `Phase 6 — LOOP iteration ${state.loopIteration} (${state.failedDimensions.join(", ")})`,
		args: {
			chain: [...fixSteps, { parallel: reVerify, concurrency: reVerify.length }],
			context: "fresh",
			clarify: false,
			chainDir: join(p.chains, `${pad3(state.seq)}-loop-${state.loopIteration}`),
		},
	};
}

// ---------------------------------------------------------------------------
// Directive rendering + gates
// ---------------------------------------------------------------------------

function issue(p: Paths, state: State, directive: Directive, preamble = ""): string {
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

type GateResult = { decision: "approve" | "revise" | "abort" | "pause"; notes?: string };

async function gate(ctx: ExtensionContext, cfg: SliceFlowConfig, title: string, artifact: string): Promise<GateResult> {
	if (!ctx.hasUI) {
		return cfg.autoApprove ? { decision: "approve" } : { decision: "pause" };
	}
	ctx.ui.notify(`Review ${artifact}`, "info");
	const choice = await ctx.ui.select(title, ["Approve and continue", "Request changes", "Abort workflow"]);
	if (choice === undefined) return { decision: "pause" };
	if (choice === "Approve and continue") return { decision: "approve" };
	if (choice === "Abort workflow") {
		const sure = await ctx.ui.confirm("Abort slice-flow?", "State stays on disk; /feature-resume cannot continue an aborted run.");
		return sure ? { decision: "abort" } : { decision: "pause" };
	}
	const notes = await ctx.ui.input("What should change?", "Describe the revisions you want");
	if (!notes || !notes.trim()) return { decision: "pause" };
	return { decision: "revise", notes: notes.trim() };
}

const PAUSE_MSG = (artifact: string) =>
	`PAUSED awaiting human approval of ${artifact}. No approval was captured (no interactive UI, or the dialog was dismissed). ` +
	`Tell the user to review the document and then either call slice_flow({"action":"next"}) again in an interactive session, ` +
	`or set "autoApprove": true in slice-flow.json for unattended runs. End your turn now.`;

function stopped(p: Paths, state: State, reason: string): string {
	state.phase = "stopped";
	state.pending = null;
	logEvent(state, `stopped: ${reason}`);
	saveState(p, state);
	return `Workflow STOPPED: ${reason}. State preserved at ${p.state}. Report (if any) at ${p.report}. Tell the user and end your turn.`;
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

// ---------------------------------------------------------------------------
// The `next` state machine
// ---------------------------------------------------------------------------

function readVerifyVerdicts(p: Paths): Record<VerifyDimension, "PASS" | "FAIL" | null> {
	const out = {} as Record<VerifyDimension, "PASS" | "FAIL" | null>;
	for (const dim of VERIFY_DIMENSIONS) out[dim] = verdictOf(join(p.verify, `${dim}.md`));
	return out;
}

async function handleNext(ctx: ExtensionContext, p: Paths, cfg: SliceFlowConfig, state: State): Promise<string> {
	if (state.phase === "done") return `Workflow already complete. Final docs are under ${p.root}/.`;
	if (state.phase === "stopped") return `Workflow is stopped. Start fresh with /feature after clearing ${p.root}, or inspect ${p.report}.`;
	const pending = state.pending;
	if (!pending) return stopped(p, state, "internal error: no pending directive");

	switch (pending.kind) {
		case "frame": {
			if (!nonEmpty(p.frame)) {
				return issue(p, state, pending, `The frame document ${p.frame} was not produced. Re-running the FRAME step.`);
			}
			const g = await gate(ctx, cfg, "Phase 1 (FRAME) complete — approve the frame?", p.frame);
			if (g.decision === "pause") return PAUSE_MSG(p.frame);
			if (g.decision === "abort") return stopped(p, state, "user aborted at frame gate");
			if (g.decision === "revise") {
				logEvent(state, "frame revision requested");
				return issue(p, state, frameDirective(p, state, cfg, g.notes), "User requested frame revisions.");
			}
			state.phase = "architect";
			logEvent(state, "frame approved");
			return issue(p, state, architectDirective(p, state, cfg), `Frame approved (${p.frame}).`);
		}

		case "architect": {
			if (!nonEmpty(p.architecture)) {
				return issue(p, state, pending, `The architecture document ${p.architecture} was not produced. Re-running ARCHITECT.`);
			}
			const g = await gate(ctx, cfg, "Phase 2 (ARCHITECT) complete — approve the architecture?", p.architecture);
			if (g.decision === "pause") return PAUSE_MSG(p.architecture);
			if (g.decision === "abort") return stopped(p, state, "user aborted at architecture gate");
			if (g.decision === "revise") {
				logEvent(state, "architecture revision requested");
				return issue(p, state, architectDirective(p, state, cfg, g.notes), "User requested architecture revisions.");
			}
			// UI shape decides whether phase 3 starts with prototypes.
			if (state.ui === null) {
				if (!ctx.hasUI) {
					if (cfg.autoApprove) state.ui = "none";
					else return PAUSE_MSG("the UI question (interactive session required)");
				} else {
					const choice = await ctx.ui.select("Does this feature involve UI work?", [
						"No UI",
						"New UI (greenfield) — run prototype fan-out",
						"Existing UI — conform to current design patterns",
					]);
					if (choice === undefined) return PAUSE_MSG("the UI question");
					state.ui = choice.startsWith("No UI") ? "none" : choice.startsWith("New UI") ? "greenfield" : "existing";
				}
			}
			logEvent(state, `architecture approved; ui=${state.ui}`);
			if (state.ui === "greenfield") {
				state.phase = "prototype";
				return issue(p, state, prototypeDirective(p, state, cfg), "Architecture approved. Greenfield UI: prototyping first.");
			}
			state.phase = "plan";
			return issue(p, state, planDirective(p, state, cfg), "Architecture approved.");
		}

		case "prototype": {
			if (!nonEmpty(join(p.prototypes, "JUDGEMENT.md"))) {
				return issue(p, state, pending, "Prototype judgement missing. Re-running the prototype phase.");
			}
			state.phase = "plan";
			logEvent(state, "prototypes judged");
			return issue(p, state, planDirective(p, state, cfg), `Prototype winner recorded in ${join(p.prototypes, "JUDGEMENT.md")}.`);
		}

		case "plan": {
			const sliceFiles = existsSync(p.slices)
				? readdirSync(p.slices).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort()
				: [];
			if (!nonEmpty(p.plan) || sliceFiles.length === 0) {
				return issue(p, state, pending, `Plan or slice files missing (found ${sliceFiles.length} slices in ${p.slices}). Re-running PLAN.`);
			}
			if (ctx.hasUI) ctx.ui.notify(`Slices: ${sliceFiles.join(", ")}`, "info");
			const g = await gate(ctx, cfg, `Phase 3 (PLAN) complete — approve the ${sliceFiles.length} slices?`, `${p.plan} and ${p.slices}/`);
			if (g.decision === "pause") return PAUSE_MSG(`${p.plan} and the slices`);
			if (g.decision === "abort") return stopped(p, state, "user aborted at plan gate");
			if (g.decision === "revise") {
				logEvent(state, "plan revision requested");
				return issue(p, state, planDirective(p, state, cfg, g.notes), "User requested plan revisions.");
			}
			state.slices = sliceFiles;
			state.sliceIndex = 0;
			state.fixupRound = 0;
			state.phase = "implement";
			logEvent(state, `plan approved with ${sliceFiles.length} slices`);
			return issue(p, state, buildDirective(p, state, cfg), `Plan approved: ${sliceFiles.length} slices.`);
		}

		case "build":
		case "fixup": {
			const a = sliceArtifacts(p, state);
			if (!nonEmpty(a.memoPath)) {
				return issue(p, state, pending, `Memo ${a.memoPath} missing — the builder did not complete its contract. Re-running this step.`);
			}
			const verdict = verdictOf(a.reviewPath);
			if (verdict === null) {
				return issue(p, state, pending, `Review verdict missing or malformed in ${a.reviewPath}. Re-running this step.`);
			}
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
			// Advance to next slice or to verification.
			state.sliceIndex += 1;
			state.fixupRound = 0;
			if (state.sliceIndex < state.slices.length) {
				return issue(p, state, buildDirective(p, state, cfg), `${a.sliceId} complete.`);
			}
			state.phase = "verify";
			logEvent(state, "all slices complete -> verify");
			return issue(p, state, verifyDirective(p, state, cfg), "All slices complete. Running independent verification.");
		}

		case "verify":
		case "loop-fix": {
			const verdicts = readVerifyVerdicts(p);
			const missing = VERIFY_DIMENSIONS.filter((d) => verdicts[d] === null);
			if (pending.kind === "verify" && missing.length > 0) {
				return issue(p, state, pending, `Verifier output missing/malformed for: ${missing.join(", ")}. Re-running verification.`);
			}
			// Missing verdicts after a loop iteration count as failures.
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

		default:
			return stopped(p, state, `unknown pending directive kind "${pending.kind}"`);
	}
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "slice_flow",
		label: "Slice Flow",
		description:
			"Orchestrates the slice-flow feature workflow (frame -> architect -> plan -> implement -> verify -> loop). " +
			"Actions: 'start' (requires description) begins a workflow; 'next' validates the last step, runs approval gates, and returns the next directive; " +
			"'status' reports state; 'abort' stops the workflow. Directives contain exact `subagent` tool arguments that MUST be invoked verbatim.",
		promptSnippet: "Drive the slice-flow feature workflow (start/next/status/abort)",
		promptGuidelines: [
			"When a slice_flow directive provides subagent arguments, call the subagent tool with that JSON verbatim, then call slice_flow with action 'next'. Never implement workflow steps yourself.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "next", "status", "abort"] as const),
			description: Type.Optional(Type.String({ description: "Feature description (required for action 'start')" })),
			note: Type.Optional(Type.String({ description: "Optional context to record in the workflow log" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cfg = loadConfig(ctx.cwd);
			const p = workPaths(ctx.cwd, cfg);

			if (params.action === "status") {
				const state = loadState(p);
				if (!state) return { content: [{ type: "text", text: "No slice-flow workflow in this directory. Start one with /feature <description>." }], details: {} };
				return { content: [{ type: "text", text: statusSummary(p, state) }], details: { state } };
			}

			if (params.action === "abort") {
				const state = loadState(p);
				if (!state) throw new Error("No slice-flow workflow to abort.");
				return { content: [{ type: "text", text: stopped(p, state, params.note ?? "aborted via slice_flow tool") }], details: {} };
			}

			if (params.action === "start") {
				if (!params.description?.trim()) throw new Error("action 'start' requires a non-empty description.");
				const existing = loadState(p);
				if (existing && existing.phase !== "done" && existing.phase !== "stopped") {
					throw new Error(
						`A slice-flow workflow is already active (phase: ${existing.phase}). Use /feature-resume to continue, slice_flow({"action":"abort"}) to stop it, or delete ${p.root} to start over.`,
					);
				}
				for (const dir of [p.root, p.logs, p.calls, p.chains, p.arch, p.slices, p.memos, p.reviews, p.verify, p.prototypes]) {
					mkdirSync(dir, { recursive: true });
				}
				let baseline: string | null = null;
				try {
					const res = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
					if (res.code === 0) baseline = res.stdout.trim();
				} catch {
					/* not a git repo — verifiers fall back to plain git diff / file reads */
				}
				if (cfg.gitignoreWorkDir && baseline !== null) ensureGitignored(ctx.cwd, cfg.workDir);
				const state: State = {
					version: 1,
					feature: params.description.trim(),
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					baselineCommit: baseline,
					phase: "frame",
					pending: null,
					ui: null,
					slices: [],
					sliceIndex: 0,
					fixupRound: 0,
					loopIteration: 0,
					failedDimensions: [],
					tokensSpent: 0,
					loopStartTokens: 0,
					seq: 0,
					log: [],
				};
				logEvent(state, `started: ${state.feature}`);
				const text = issue(p, state, frameDirective(p, state, cfg), `slice-flow started. State: ${p.state}. Baseline commit: ${baseline ?? "(not a git repo)"}.`);
				return { content: [{ type: "text", text }], details: { phase: state.phase } };
			}

			// action === "next"
			const state = loadState(p);
			if (!state) throw new Error("No slice-flow workflow in this directory. Start one with /feature <description>.");
			if (params.note) logEvent(state, `note: ${params.note}`);
			const text = await handleNext(ctx, p, cfg, state);
			return { content: [{ type: "text", text }], details: { phase: state.phase } };
		},
	});

	// --- Observability hooks: log every actual subagent invocation, and keep a
	// best-effort token estimate for the loop budget. Both no-op when no
	// workflow is active in this cwd.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		try {
			const cfg = loadConfig(ctx.cwd);
			const p = workPaths(ctx.cwd, cfg);
			const state = loadState(p);
			if (!state || state.phase === "done" || state.phase === "stopped") return;
			mkdirSync(p.calls, { recursive: true });
			const file = join(p.calls, `${new Date().toISOString().replace(/[:.]/g, "-")}-subagent-call.json`);
			writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), input: event.input }, null, 2), "utf8");
		} catch {
			/* observability must never block the workflow */
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		try {
			const cfg = loadConfig(ctx.cwd);
			const p = workPaths(ctx.cwd, cfg);
			const state = loadState(p);
			if (!state || state.phase === "done" || state.phase === "stopped") return;
			const inputChars = JSON.stringify(event.input ?? {}).length;
			const outputChars = (event.content ?? [])
				.map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text?.length ?? 0) : 0))
				.reduce((a: number, b: number) => a + b, 0);
			state.tokensSpent += Math.ceil((inputChars + outputChars) / 4);
			saveState(p, state);
		} catch {
			/* best-effort accounting only */
		}
	});

	// --- Slash commands -------------------------------------------------------
	pi.registerCommand("feature-status", {
		description: "Show the current slice-flow phase and slice",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const p = workPaths(ctx.cwd, cfg);
			const state = loadState(p);
			if (!state) {
				ctx.ui.notify("No slice-flow workflow here. Start one with /feature <description>.", "info");
				return;
			}
			ctx.ui.notify(statusSummary(p, state), "info");
		},
	});

	pi.registerCommand("feature-resume", {
		description: "Resume the slice-flow workflow from persisted state",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const p = workPaths(ctx.cwd, cfg);
			const state = loadState(p);
			if (!state) {
				ctx.ui.notify("Nothing to resume: no slice-flow state in this directory.", "warning");
				return;
			}
			if (state.phase === "done") {
				ctx.ui.notify("Workflow already complete. Start a new one with /feature.", "info");
				return;
			}
			if (state.phase === "stopped") {
				ctx.ui.notify(`Workflow was stopped. Inspect ${p.report} or delete ${p.root} to start over.`, "warning");
				return;
			}
			pi.sendUserMessage(
				`Resume the slice-flow feature workflow from persisted state. Call slice_flow({"action":"next"}) now and follow its directives exactly: ` +
					`invoke the subagent tool with the JSON it provides verbatim, then call slice_flow({"action":"next"}) again after each run. ` +
					`If artifacts from the interrupted step are missing, the tool will re-issue that step automatically.`,
			);
		},
	});
}

function statusSummary(p: Paths, state: State): string {
	const parts = [
		`slice-flow: ${state.feature}`,
		`phase: ${state.phase}`,
	];
	if (state.phase === "implement" && state.slices.length > 0) {
		parts.push(`slice: ${state.slices[state.sliceIndex] ?? "?"} (${state.sliceIndex + 1}/${state.slices.length}, fix-up round ${state.fixupRound})`);
	}
	if (state.phase === "loop") {
		parts.push(`loop: iteration ${state.loopIteration}, failing: ${state.failedDimensions.join(", ")}`);
	}
	if (state.pending) parts.push(`awaiting: ${state.pending.label}`);
	parts.push(`tokens (est): ${state.tokensSpent}`, `state: ${p.state}`);
	return parts.join(" | ");
}

function ensureGitignored(cwd: string, workDir: string): void {
	try {
		const gi = join(cwd, ".gitignore");
		const entry = `${workDir.replace(/\/$/, "")}/`;
		const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
		if (!current.split("\n").some((l) => l.trim() === entry || l.trim() === workDir)) {
			appendFileSync(gi, `${current.endsWith("\n") || current === "" ? "" : "\n"}${entry}\n`, "utf8");
		}
	} catch {
		/* non-fatal */
	}
}
