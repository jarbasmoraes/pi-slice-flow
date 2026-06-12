/**
 * All prompt content for spawned agents, as pure string builders. This is the
 * file to edit when you want agents briefed differently; it contains no
 * control flow, no IO, and no knowledge of the subagent tool shape.
 */

import { join } from "node:path";
import type { Paths, SliceArtifacts, VerifyDimension } from "./workspace.ts";

export const VERDICT_RULE = `The very first line of your final answer MUST be exactly "VERDICT: PASS" or "VERDICT: FAIL" — nothing before it.`;

export interface HypothesisAngle {
	id: number;
	angle: string;
	brief: string;
}

export const HYPOTHESIS_ANGLES: HypothesisAngle[] = [
	{ id: 1, angle: "minimal-change", brief: "Optimize for the smallest possible diff and maximum reuse of code that already exists." },
	{ id: 2, angle: "pattern-aligned", brief: "Optimize for the most faithful fit with the architecture patterns already established in this repository." },
	{ id: 3, angle: "evolvable", brief: "Optimize for reversibility and ease of future extension, even at the cost of a slightly larger initial change." },
];

const revisionFooter = (notes?: string, extra = "") =>
	notes ? `\nUser revision notes from the previous round${extra}:\n${notes}` : "";

export function frameBrief(p: Paths, feature: string, notes?: string): string {
	return `# FRAME the feature

Feature request: ${feature}

You are the framing agent for a feature workflow. Apply the injected zinsser-framing skill.

1. Review the existing code relevant to this feature: entry points, current behavior, the modules a change would touch. Cite real file paths.
2. Your final answer must be the complete frame document (it is saved automatically to ${p.frame}). Required sections, each as single-sentence declarative bullet points:
   - **Problem** — what is wrong or missing.
   - **What the code does today** — current behavior with file references.
   - **Proposed solution** — what will change.
   - **Why this solves the problem** — the causal link, bullet by bullet.

Do not edit any project files. Do not include filler, hedging, or process narration in the document.
${notes ? `\nRevision requested by the user — address these notes and rewrite the full document:\n${notes}\nYour previous frame is injected for reference.` : ""}`;
}

export function hypothesisBrief(p: Paths, a: HypothesisAngle, notes?: string): string {
	return `# Architecture hypothesis ${a.id}: ${a.angle}

The approved frame document is injected. ${a.brief}

Review the actual codebase before proposing anything. Then produce ONE architecture hypothesis as your final answer (saved automatically to ${join(p.arch, `hypothesis-${a.id}.md`)}). Required sections:

1. **Summary** — one paragraph.
2. **Diagram** — a Mermaid diagram (fenced \`\`\`mermaid block) of the proposed structure.
3. **Components** — each component, its responsibility, and the file(s) it lives in.
4. **Data flow** — how data moves through the components for the main use case.
5. **Why this is good** — concrete advantages, grounded in the frame and the existing code.
6. **What would falsify this** — the observations or constraints that would prove this design wrong.

Do not edit any project files.${revisionFooter(notes)}`;
}

export function architectJudgeBrief(p: Paths, hypothesisCount: number): string {
	return `# Judge the architecture hypotheses

The frame document and ${hypothesisCount} competing architecture hypotheses are injected. You are the judge; you do not design, you decide.

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
}

export function prototypeBrief(p: Paths, n: number, total: number): string {
	const dir = join(p.prototypes, `proto-${n}`);
	return `# UI prototype ${n} of ${total}

The frame and approved architecture are injected. Apply the injected ui-prototyping skill.

Build a self-contained, runnable UI prototype of this feature in ${dir}/ — create the directory. Take a distinct stylistic and structural direction from what other prototypes might choose; prototype ${n} should feel like its own answer, not a variation.

Hard rules:
- Write ONLY inside ${dir}/. Never touch project source files.
- Include a README.md in the prototype directory explaining how to open/run it and what direction you took.
- Favor zero-build artifacts (single HTML file, or the project's existing dev stack mirrored locally) so the user can open it instantly.`;
}

export function prototypeJudgeBrief(p: Paths, total: number): string {
	return `# Judge the UI prototypes

${total} prototypes live in ${p.prototypes}/proto-1 .. proto-${total}. The frame and architecture are injected.

Inspect every prototype's code and README. Your final answer is saved automatically to ${join(p.prototypes, "JUDGEMENT.md")} and must contain:

1. **Winner** — the winning directory name and a description of its direction precise enough that a planner who never sees the prototype can specify the real UI from it.
2. **Why it won** — fit with the frame, clarity, and feasibility within the approved architecture.
3. **Per-loser verdict** — one sentence each on why it lost.
4. **Salvage** — any specific ideas from losing prototypes worth folding into the plan.

Do not edit any files.`;
}

export function planBrief(p: Paths, ui: "none" | "greenfield" | "existing" | null, notes?: string): string {
	const uiInstructions =
		ui === "greenfield"
			? `This feature has new (greenfield) UI. The prototype judgement is injected; the plan's UI portions must realize the winning prototype's direction.`
			: ui === "existing"
				? `This feature extends an EXISTING UI. Apply the injected design-guidelines skill and conform strictly to the UI patterns already present in this repository. Do not invent new visual patterns.`
				: `This feature has no UI work.`;

	return `# Plan the implementation

The frame and approved architecture are injected. Apply the injected slice-rules skill — it defines the slice file format and sizing rules.

${uiInstructions}

Produce two things:

1. **The plan document** — your final answer, saved automatically to ${p.plan}. It must cover: the implementation approach; code snippets for every critical path (the parts where getting it wrong is expensive); test strategy; and an ordered slice index.
2. **Slice files** — write each slice with your write tool to ${p.slices}/NNN-<slug>.md (001, 002, ...), following the slice file format from slice-rules exactly. Slice 001 is the smallest WORKING end-to-end MVP of the feature; later slices iterate from that MVP toward the full plan. Size every slice for roughly 100 lines of implementation change.

Each slice file must be a self-sufficient contract: a builder who sees ONLY that slice file (plus memos of prior slices) must be able to implement it. Never assume the builder has read this plan.

Do not edit project source files — you only write under ${p.slices}/.${revisionFooter(notes, " — address them and rewrite plan and slices")}`;
}

export function buildBrief(p: Paths, a: SliceArtifacts, autoCommit: boolean): string {
	return `# Build ${a.sliceId}

You are a fresh-context builder. Your ONLY contract is the injected slice file ${a.slicePath}. Memos from previously completed slices are injected as READ-ONLY context — they tell you what already exists; never re-do or modify their scope beyond what your slice demands.

Apply the injected slice-rules skill. It is binding: TDD-first, scope discipline, the ~100 LOC budget and its escalation rule, and the required post-build memo.

Hard requirements:
1. Implement exactly what the slice specifies. Nothing more.
2. Tests first, then implementation, then run the tests and make them pass.
3. ${autoCommit ? "Commit your work as ONE commit (auto_commit is enabled). Do not push." : "Do NOT commit (auto_commit is disabled); leave changes in the working tree."}
4. Write your memo to ${a.memoPath} following the memo format in slice-rules. The memo MUST list every changed file${autoCommit ? " and the commit hash" : ""}.
5. Never touch ${p.root} except to write the memo.`;
}

export function reviewBrief(a: SliceArtifacts, fixupRound: number): string {
	return `# Review ${a.sliceId}${fixupRound > 0 ? ` (after fix-up round ${fixupRound})` : ""}

You are a fresh-context reviewer. The slice contract and the builder's memo are injected. Apply the injected reviewer-solid skill — it defines the review criteria.

Inspect the actual changes: the memo lists changed files and commit hash(es); use git (e.g. \`git show <hash>\`, \`git diff <hash>^..<hash>\`) and read the files directly. Judge ONLY this slice against its contract and the reviewer-solid criteria.

${VERDICT_RULE}
After the verdict line, list findings: each with file, line, severity (blocker|major|minor), and reason. PASS is allowed with minor findings; any blocker or major finding means FAIL. Your final answer is saved automatically to ${a.reviewPath}.

You are review-only: do not edit, fix, or commit anything.`;
}

export function fixupBrief(a: SliceArtifacts, fixupRound: number, autoCommit: boolean): string {
	return `# Fix-up ${a.sliceId} (round ${fixupRound})

You are a fresh-context fix-up agent with a deliberately narrow scope. The slice contract, the builder's memo, and the failed review are injected. Apply the injected slice-rules skill.

Hard requirements:
1. Fix ONLY the blocker and major findings listed in the review. Do not refactor beyond them, do not expand scope.
2. Keep tests green; add a test when a finding reveals a missing one.
3. ${autoCommit ? "Commit the fix as one commit. Do not push." : "Do NOT commit; leave changes in the working tree."}
4. Append a "## Fix-up round ${fixupRound}" section to the memo ${a.memoPath}: what you changed, files touched${autoCommit ? ", commit hash" : ""}.`;
}

export function verifierBrief(p: Paths, dim: VerifyDimension, baselineCommit: string | null, workDir: string): string {
	const diffCmd = baselineCommit ? `git diff ${baselineCommit}..HEAD` : "git diff";
	return `# Verify dimension: ${dim}

You are an independent verifier with fresh context. You did not build this code; assume the builders were wrong somewhere and your job is to find where. REFUTE, do not confirm: actively hunt for evidence that the implementation FAILS the "${dim}" dimension. A PASS is only earned when honest refutation attempts come up empty.

Apply the injected verify-rubrics skill and use ONLY the "${dim}" rubric.

Scope of evidence:
- The full diff: run \`${diffCmd}\` (exclude the ${workDir}/ directory from judgment — it is workflow metadata).
- The injected frame, architecture, and plan documents — the implementation must serve them.
- Run things when the rubric calls for it (tests, linters, the code itself).

${VERDICT_RULE}
After the verdict line, list every finding with: file, line, reason, and severity (blocker|major|minor). Any blocker or major finding means FAIL. Your final answer is saved automatically to ${join(p.verify, `${dim}.md`)}.

You are read/run-only: never edit or commit.`;
}

export function loopFixBrief(p: Paths, dim: VerifyDimension, loopIteration: number, autoCommit: boolean): string {
	return `# Loop fix-up: ${dim} (iteration ${loopIteration})

The "${dim}" verifier returned FAIL. Its findings are injected (${join(p.verify, `${dim}.md`)}), along with the plan. Apply the injected slice-rules skill for discipline.

Hard requirements:
1. Fix ONLY the blocker and major findings in that verify report. No scope creep.
2. Keep all tests green.
3. ${autoCommit ? `Commit as one commit with message "fix(${dim}): address verifier findings (loop ${loopIteration})". Do not push.` : "Do NOT commit."}`;
}
