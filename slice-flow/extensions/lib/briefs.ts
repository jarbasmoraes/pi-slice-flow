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

// --- Frame v2 briefs (intake -> explore -> compile -> validate) ---------------

export function intakeBrief(p: Paths, feature: string): string {
	return `# Intake check: is this feature description ready to frame?

Feature request: ${feature}

You are the intake classifier for a feature workflow. The description above is the prompt the entire workflow scales from; your job is to decide whether it is sufficient to start framing, and if not, to produce ONE batch of clarifying questions to ask the human now, while they are present.

1. Take a quick look at the repository (entry points, README, the modules this feature would plausibly touch) so your questions are informed, not generic. Spend little time; this is triage, not research.
2. Assess the description against this checklist:
   - **Outcome** — does it say what should be true when the feature is done?
   - **Users** — is it clear who or what consumes the change?
   - **Constraints** — are known constraints stated (compatibility, performance, scope)?
   - **Definition of done** — is there anything testable to verify against?
3. Your final answer is saved automatically to ${p.intake}. Its very first line MUST be exactly "INTAKE: SUFFICIENT" or "INTAKE: QUESTIONS" — nothing before it. Then:
   - **Summary** — your reading of the request in 2-4 single-sentence bullets.
   - **Checklist** — one line per checklist item: met or not met, and why.
   - **Questions** — only when the marker is QUESTIONS: a numbered batch of specific questions, each answerable in one sentence. Never more than 6.

Do not edit any project files.`;
}

export function researchBrief(feature: string, question: string, outPath: string): string {
	return `# Frame research: ${question}

Context: this research supports the FRAMING of the feature "${feature}". The human and their framing partner need grounded domain knowledge to decide what to build, not implementation detail.

Research question: ${question}

Rules in addition to your researcher defaults:
- Prefer primary sources: official docs, specs, source repositories, benchmarks.
- Never substitute memory for a citation. If a fetch fails or a source cannot be reached, record it as "Source unavailable: <url>" — do not summarize it from recall.
- Answer the question as asked; flag adjacent discoveries in Gaps instead of chasing them.
- Keep the brief under ~150 lines; the reader is a conversation, not an archive.

Your final answer is saved automatically to ${outPath}.`;
}

export interface AttackCharter {
	id: string;
	brief: string;
}

export const ATTACK_CHARTERS: AttackCharter[] = [
	{
		id: "wrong-problem",
		brief: "Argue that this framing solves the WRONG PROBLEM: the stated problem is a symptom, the real need is elsewhere, or the outcome would not satisfy the people it is for.",
	},
	{
		id: "simpler-alternative",
		brief: "Argue that a MATERIALLY SIMPLER alternative reaches the same outcome: less code, an existing tool, a config change, or doing nothing.",
	},
	{
		id: "breaks-existing",
		brief: "Argue that the proposed direction BREAKS OR DEGRADES something that already exists: current behavior, performance, conventions, or downstream consumers. Check the actual code.",
	},
];

export function attackBrief(p: Paths, feature: string, charter: AttackCharter, outPath: string): string {
	return `# Attack the framing: ${charter.id}

Feature being framed: ${feature}

You are a fresh-context adversary. You have NOT taken part in the framing conversation and owe it no agreement. Your single charter: ${charter.brief}

Evidence available to you:
- The decision ledger and intake assessment are injected.
- Research findings, if any, live under ${p.frameResearch}/ — list and read them.
- The repository itself — ground claims about existing behavior in real files.

Produce your strongest honest case as numbered objections. For each:
1. **Objection** — one declarative sentence.
2. **Evidence** — the file, source, or ledger entry that supports it.
3. **What would resolve it** — the answer, fact, or change that would make this objection go away.

Raise only objections you can support; an adversary who pads with weak objections gets ignored. If the framing genuinely survives your charter, say so in one line and explain what convinced you. Your final answer is saved automatically to ${outPath}.

Do not edit any files.`;
}

/** Architecture attack charters, parallel to the frame's ATTACK_CHARTERS but
 * aimed at the winning design's structure. The detail lives in the
 * architecture-attack skill; the id selects the charter. */
export const ARCH_ATTACK_CHARTERS: AttackCharter[] = [
	{ id: "wrong-seam", brief: "The design cuts the system at the wrong boundary; the seam will leak." },
	{ id: "simpler-structure", brief: "A materially simpler structure reaches the same frame outcome." },
	{ id: "fights-the-codebase", brief: "The design contradicts an established repo pattern or degrades existing behavior." },
];

export function archAttackBrief(p: Paths, charterId: string, outPath: string): string {
	return `# Attack the architecture: ${charterId}

The approved frame and the winning architecture (${p.architecture}) are injected. You are a fresh-context adversary; you owe the design no agreement.

Apply the injected architecture-attack skill. Your charter is "${charterId}" — argue its strongest honest case against the winning design, grounded in the frame and the actual code. Raise only objections you can support.

Your final answer is saved automatically to ${outPath}. Do not edit any files.`;
}

export function archDispositionBrief(p: Paths): string {
	return `# Disposition the architecture attacks

The frame and the winning architecture (${p.architecture}) are injected. The attack reports live under ${p.archAttacks}/ — list and read every one.

Apply the injected architecture-attack skill (disposition role). Disposition every objection — resolved, accepted as risk, or rejected — and emit the required first-line ARCH-ATTACK marker followed by a "## Attack dispositions" section.

Your final answer is saved automatically to ${p.archDispositions}. Do not edit any files.`;
}

export function compileBrief(p: Paths, feature: string, notes?: string): string {
	return `# Compile the frame document

Feature: ${feature}

You are the frame compiler. A human and their framing partner explored this feature and recorded everything in the decision ledger (injected). Your job is COMPRESSION, not creation: turn the ledger into the frame document, following the injected zinsser-framing skill exactly (structure, writing rules, and the acceptance-criteria contract are all defined there).

Sources, in order of authority:
1. The decision ledger (injected) — every decision in your document must trace to it; invent nothing.
2. The intake assessment (injected).
3. Research findings under ${p.frameResearch}/ and attack reports under ${p.frameAttacks}/ — list and read whatever exists.
4. The repository — verify file claims before writing them.

Hard rules:
- Every decision, rejected alternative, and open question in the ledger appears in the document; nothing in the document lacks a ledger basis.
- Unresolved open questions are carried into "## Open questions", never silently dropped.
- Acceptance criteria are numbered and individually testable: a verifier must be able to check each one against the diff and say yes or no.

Your final answer must be the complete frame document (saved automatically to ${p.frame}). Do not edit any project files.${notes ? `\n\nThis is a RECOMPILE. The previous attempt failed validation; fix these findings and rewrite the full document (previous frame and judge report are injected):\n${notes}` : ""}`;
}

export function frameJudgeBrief(p: Paths): string {
	return `# Judge the frame compilation for fidelity

The decision ledger and the compiled frame document (${p.frame}) are injected. Research findings live under ${p.frameResearch}/ and attack reports under ${p.frameAttacks}/ — list and read whatever exists.

You are the fidelity judge. You do NOT judge whether the framing is wise — the human made those calls with adversarial help during exploration. You judge ONE question: is the document a faithful, lossless compression of the ledger?

FAIL conditions (any one suffices):
- The document states a decision, constraint, or claim with no basis in the ledger, intake, or research.
- A ledger decision or rejected alternative is missing from the document.
- An unresolved open question from the ledger was dropped instead of carried into "## Open questions".
- An acceptance criterion is not individually testable against a future diff.
- A "What the code does today" claim cites a file that does not say what the document claims (spot-check the repository).

${VERDICT_RULE}
After the verdict line, list each finding: the document section, the ledger entry (or its absence), and the discrepancy in one sentence. Your final answer is saved automatically to ${p.frameJudgement}.

Do not edit any files.`;
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

export function architectJudgeBrief(p: Paths, hypothesisCount: number, notes?: string): string {
	return `# Judge the architecture and compile the design document

The frame document and ${hypothesisCount} competing architecture hypotheses are injected. You are the judge: you pick the winner and then compile its design into one spec-driven document. You compile the winner's content — you do not invent design.

Score every hypothesis 1-5 on each criterion:
- **Fit with the frame** — does it solve the stated problem, all of it, and nothing else?
- **Simplicity** — fewest moving parts that still work.
- **Fit with existing repo patterns** — verify against the actual code, not the hypothesis's own claims.
- **Reversibility** — how cheaply could this be undone or redirected?

The very first line of your final answer MUST be exactly "WINNER: hypothesis-<id>" naming the winning hypothesis — nothing before it. A mechanical lint parses this marker and the headings below; deviating fails the document.

Your final answer is the complete spec-driven design document (saved automatically to ${p.architecture}). Write it in plain-language prose, and use these exact markdown headings, in this order:

## Winner — name the winning hypothesis and say in a sentence or two why it won.
## Goals & Non-Goals — what this design must achieve and what it deliberately will not.
## Architecture Overview — the prose description of the structure and the main flow, plus EXACTLY TWO labeled Mermaid diagrams (each a fenced \`\`\`mermaid block): first a component/context diagram, then a main-flow sequence diagram.
## Components — each component, its responsibility, and the file(s) it lives in.
## Data Models & Schema Changes — first determine database impact using this explicit rule: the design is DB-impacting if and only if it adds a table, alters a schema, or writes a previously read-only entity. If there is no impact, this section is a single sentence saying so (e.g. "No database impact."). If there is impact, include an ER diagram and migration notes.
## Error Handling — how failures are detected, surfaced, and recovered.
## Alternatives Considered — per losing hypothesis, the decisive weakness in one or two sentences.
## Risks & Mitigations — what to watch for (from the winner's "falsify" section) and how to mitigate each.
## Requirement Traceability — a markdown table with one row per frame acceptance criterion, regenerated from the current frame. Inline each criterion's text and map it to the component(s) that satisfy it.
## Scores — a markdown table of all hypotheses against all four criteria.

Keep it concise: target roughly 500 lines or fewer. You are compiling the winner's design, not expanding it.

Do not edit any project files.${notes ? `\n\nRevision notes — address these in your judgment and rewrite the full document:\n${notes}` : ""}`;
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

export function prototypeJudgeBrief(p: Paths, total: number, notes?: string): string {
	return `# Judge the UI prototypes

${total} prototypes live in ${p.prototypes}/proto-1 .. proto-${total}. The frame and architecture are injected. Inspect every prototype's code and README.

Apply the injected prototype-rubric skill. It defines the refute-stance criteria, the per-candidate record you must produce so a human can override your pick, and the required first-line WINNER format. If NO prototype clears the bar, do not anoint a weak winner: make your first line exactly \`WINNER: NONE-ACCEPTABLE\` and give the reasons — the workflow will regenerate the prototypes rather than carry a weak slate into the plan.

Your final answer is saved automatically to ${join(p.prototypes, "JUDGEMENT.md")}.

Do not edit any files.${revisionFooter(notes)}`;
}

export function planBrief(
	p: Paths,
	ui: "none" | "greenfield" | "existing" | null,
	notes?: string,
	out: { plan: string; slices: string } = { plan: p.plan, slices: p.slices },
	candidate?: { n: number; total: number },
): string {
	const uiInstructions =
		ui === "greenfield"
			? `This feature has new (greenfield) UI. The prototype judgement is injected; the plan's UI portions must realize the winning prototype's direction.`
			: ui === "existing"
				? `This feature extends an EXISTING UI. Apply the injected design-guidelines skill and conform strictly to the UI patterns already present in this repository. Do not invent new visual patterns.`
				: `This feature has no UI work.`;

	const candidateNote = candidate
		? `\nYou are decomposition candidate ${candidate.n} of ${candidate.total}. Produce YOUR OWN independent slicing of this work — a different seam ordering, MVP boundary, or risk-first sequence than an obvious default. A separate judge will compare all ${candidate.total} candidates and pick the soundest; do not converge toward the others.\n`
		: "";

	return `# Plan the implementation
${candidateNote}
The frame and approved architecture are injected. Apply the injected slice-rules skill — it defines the slice file format and sizing rules.

${uiInstructions}

Produce two things:

1. **The plan document** — your final answer, saved automatically to ${out.plan}. It must cover: the implementation approach; code snippets for every critical path (the parts where getting it wrong is expensive); test strategy; and an ordered slice index.
2. **Slice files** — write each slice with your write tool to ${out.slices}/NNN-<slug>.md (001, 002, ...), following the slice file format from slice-rules exactly. Slice 001 is the smallest WORKING end-to-end MVP of the feature; later slices iterate from that MVP toward the full plan. Size every slice for roughly 100 lines of implementation change.

Each slice file must be a self-sufficient contract: a builder who sees ONLY that slice file (plus memos of prior slices) must be able to implement it. Never assume the builder has read this plan.

Do not edit project source files — you only write under ${out.slices}/.${revisionFooter(notes, " — address them and rewrite plan and slices")}`;
}

/** The comparative selector over N plan candidates (planCount > 1). Picks the
 * soundest decomposition and emits a `WINNER: plan-<n>` marker plus a VERDICT on
 * the winner's soundness, mirroring the architect judge. */
export function planSelectBrief(p: Paths, total: number): string {
	return `# Select the best plan decomposition

${total} competing plans live in ${p.root}/plan-1 .. plan-${total}, each with a plan.md and a slices/ directory. The frame and architecture are injected. List and read every candidate's plan.md and all of its slice files before deciding.

Apply the injected plan-rubric skill to each candidate, then choose the SINGLE soundest decomposition. Judge ONLY the decomposition (coverage of the frame, MVP-first ordering, slice sizing, architecture fidelity, forward dependencies) — not code quality or value.

Your first line is exactly \`WINNER: plan-<n>\`, naming the winning directory — nothing before it. Then justify the pick against the rubric dimensions and note any strong idea from a losing candidate worth folding in.

${VERDICT_RULE}
The verdict is on the WINNER's soundness. Your final answer is saved automatically to ${p.planJudgement}.

Do not edit any files.`;
}

export function planJudgeBrief(p: Paths): string {
	return `# Judge the plan decomposition

The frame, the winning architecture, and the plan (${p.plan}) are injected. The slice files live under ${p.slices}/ — list and read every one before judging.

Apply the injected plan-rubric skill. It defines the dimensions of decomposition soundness you must refute and the required verdict format. Judge ONLY the decomposition: not code quality, not value, not UI. Deterministic structure (numbering, required sections, forward-dependency syntax) is already linted — do not re-report it.

${VERDICT_RULE}
Your final answer is saved automatically to ${p.planJudgement}.

Do not edit any files.`;
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

/**
 * Brief for the self-improvement reflection agent (T3b). A fresh judge reads
 * the rubric skill it would tune and a compiled set of human-override cases
 * (the judge passed an artifact, then the human revised/aborted it — or the
 * inverse) and proposes unified-diff-style rubric edits, each with a rationale.
 * It is PROPOSALS ONLY: it must never edit the skill file or any source file —
 * a human reviews and applies, matching the "earn trust" principle. Pure
 * string: it names the rubric path and the cases path and forbids direct edits.
 */
export function reflectBrief(judgeId: string, rubricPath: string, casesPath: string): string {
	return `# Reflect on the "${judgeId}" judge rubric

You are a fresh-context judge asked to IMPROVE a rubric, not to apply it. Two files are injected:

1. The rubric skill you would tune: ${rubricPath}. This is the rubric the "${judgeId}" gate's judge currently follows.
2. The override cases: ${casesPath}. Each case is a run where a human did NOT accept the judged artifact as-is (a revise/abort after the judge passed it, or the inverse). That disagreement is the training signal — the rubric missed something the human cared about, or flagged something the human did not.

Your task: study the override cases against the current rubric and propose concrete edits to the rubric that would have better predicted the human's decision.

Hard rules:
- Output PROPOSALS ONLY. You MUST NOT edit ${rubricPath}, any skill file, or any source file. Write nothing to disk yourself except your final answer.
- Express every proposed change as a unified-diff-style hunk against ${rubricPath} (in a \`\`\`diff fenced block, with - / + lines), so a human can review and apply it deliberately.
- For EACH proposed edit, give a one- to three-sentence rationale that cites the specific override case(s) it is derived from.
- Propose nothing the cases do not support. If the cases show no rubric gap, say so in one line and propose no edits — an unsupported "improvement" is noise.
- Do not invent cases or human intent beyond what ${casesPath} records.

Your final answer is the proposals document; it is saved automatically for human review. Apply nothing.`;
}

export function loopFixBrief(p: Paths, dim: VerifyDimension, loopIteration: number, autoCommit: boolean): string {
	return `# Loop fix-up: ${dim} (iteration ${loopIteration})

The "${dim}" verifier returned FAIL. Its findings are injected (${join(p.verify, `${dim}.md`)}), along with the plan. Apply the injected slice-rules skill for discipline.

Hard requirements:
1. Fix ONLY the blocker and major findings in that verify report. No scope creep.
2. Keep all tests green.
3. ${autoCommit ? `Commit as one commit with message "fix(${dim}): address verifier findings (loop ${loopIteration})". Do not push.` : "Do NOT commit."}`;
}
