# Tier 3 implementation spec — Observability + Self-Improving

This is a self-contained handoff. You can implement Tier 3 from this document
alone, without any prior conversation. Read it, then read the files it names.

## Where this sits

slice-flow is a feature-development workflow (frame → architect → prototype →
plan → build → verify → loop) driven by a state machine in
`extensions/lib/engine.ts`. Tiers 0–2 are already shipped:

- T0/T1: a loop re-verify fix, deterministic lints (`lintSlices`, `lintMemo`),
  model re-tiering.
- T2: a per-gate **autonomy** map (`config.autonomy`, every gate `"human"` by
  default, `frame` pinned), adversarial **judges** (plan judge, architecture
  attack panel, refute-stance prototype judge), the oracle agent split into
  `slice-flow-oracle-adversary` / `slice-flow-oracle-judge`, and per-judge
  rubric **skills** (`plan-rubric`, `architecture-attack`, `prototype-rubric`).

**North star:** a zero-touch engineer — autonomous from architect onward, with
frame keeping the human forever. The autonomy map can flip each gate from
`"human"` to `"auto"`, but **only once there is evidence the gate's judges are
trustworthy.** Tier 3 builds that evidence loop. Without it, the autonomy
switches exist but nobody can responsibly flip them.

T3 has two halves. Build **T3a (observability) first** — T3b depends on its data.

---

## The observability substrate that ALREADY exists (reuse it; do not rebuild)

Every task lives in `<workDir>/<slug>/` (default `workDir` = `.pi/task`).
`extensions/lib/workspace.ts` already records, per task:

- **`state.log`**: `Array<{ ts: string; event: string }>` — the event trail.
  Key events already emitted (grep `logEvent(` in engine.ts):
  - `gate <id>: <decision>` — emitted for every gate (`frame|architect|plan|prototype|verify`) with decision `approve|revise|abort|pause`. **This is the override signal**: a judge produced a verdict, then the human decided.
  - phase transitions, retries (`... -> replan N/M`, `re-judge`, `RECONSIDER -> full re-run`), verdicts (`review PASS/FAIL`, `clean verification pass`), `architecture approved (winner: ...)`, etc.
- **`state.tokensSpent`**: best-effort chars/4 token estimate across all spawned agents.
- **`state.phase`**, `slices`, `loopIteration`, `failedDimensions`, retry counters.
- **Verdict files on disk**, parseable with existing helpers:
  - `verdictOf(file)` → `"PASS"|"FAIL"|null` (frame judgement, plan judgement, slice reviews, `verify/<dim>.md`).
  - `winnerOf` / `prototypeWinnerOf` / `archAttackMarkerOf` markers.
  - `p.frameJudgement`, `p.planJudgement`, `p.archDispositions`, `p.reviews/`, `p.verify/`.
- **`p.logs/`**: directive JSON (`NNN-directive-<kind>.json`) + every agent brief.
- **`p.calls/`**: raw subagent call JSON (`observeSubagentCall`).
- **`listTasks(cwd, workDir)`** → `TaskRef[]` = `{ slug, state }` for every task on disk. This is your entry point for cross-run aggregation.

Helpers you will reuse: `loadConfig`, `workPaths`, `listTasks`, `loadState`,
`verdictOf`, `readVerifyVerdicts`, `VERIFY_DIMENSIONS`.

---

## T3a — Observability (cross-run metrics)

**Goal:** turn the per-task logs that already exist into a cross-run view that
answers: *which gate has earned `auto`?* Specifically, per gate/phase: how often
the judge’s verdict was overridden by the human, retry counts, pass/fail rates,
and token cost per run/phase.

**Deliverable:** a new pure module `extensions/lib/metrics.ts` plus a read-only
`slice_flow` action `"metrics"` (or `"report"`) that prints the summary. Keep
the engine/state machine untouched — this is read-only analysis over existing
artifacts.

1. `extensions/lib/metrics.ts` (pure, no IO beyond reading task state via
   passed-in data where practical; mirror the testability of `config.ts`):
   - `interface GateStat { gate: string; approve: number; revise: number; abort: number; pause: number; overrideRate: number }`
     where `overrideRate = (revise + abort) / (total decisions)` — the fraction
     of times a human did NOT accept the judged artifact as-is.
   - `interface TaskMetrics { slug: string; phase: string; tokensSpent: number; gates: GateStat[]; retries: Record<string, number>; verdicts: {...} }`
   - `computeTaskMetrics(state: State): TaskMetrics` — parse `state.log` with a
     regex on the `gate <id>: <decision>` lines and the `-> replan|re-judge|
     RECONSIDER|fix-up round` lines; read nothing it cannot get from `state`
     (verdict files can be read via a thin adapter the action supplies, to keep
     the core pure and unit-testable).
   - `aggregate(tasks: TaskMetrics[]): { gates: GateStat[]; totals: ... }` —
     sum per gate across all tasks; this is the number that decides an `auto` flip.
   - `renderReport(agg, perTask): string` — a compact markdown table.

2. Wire a read-only action in `extensions/slice-flow.ts` (find the existing
   `slice_flow` tool action switch): `action: "metrics"` → `listTasks` →
   `computeTaskMetrics` per task → `aggregate` → print `renderReport`. No state
   mutation, no gates.

3. Tests `test/metrics.test.js` (node:test, mirror `test/config-defaults.test.js`
   style): feed synthetic `state.log` arrays and assert gate decision counts,
   `overrideRate`, retry tallies, and aggregation across multiple tasks.

**Acceptance for T3a:** `slice_flow({"action":"metrics"})` prints, for each gate,
the approve/revise/abort/pause counts and override rate aggregated across all
tasks under `workDir`, plus per-task token spend — with zero changes to workflow
behavior (all existing tests still pass).

---

## T3b — Self-improving (`/feature-reflect`)

**Goal:** mine the override signal so a judge’s rubric improves over time. When a
human overrode a judge (a `revise`/`abort` after the judge passed an artifact, or
the inverse), that disagreement is the training signal for the rubric skill.

**Deliverable:** a new prompt/command `prompts/feature-reflect.md` and the
directive plumbing to run a reflection agent that proposes rubric diffs — as
reviewable suggestions, never auto-applied (human approves first, matching the
"earn trust" principle).

1. `briefs.ts`: add `reflectBrief(judgeId, rubricPath, casesPath)` — instructs a
   fresh judge-agent to read (a) the rubric skill it would tune, (b) a compiled
   set of override cases (judge verdict + the human decision + the artifact), and
   propose a unified-diff-style set of rubric edits with a rationale per edit.
   It MUST output proposals only; it never edits the skill file directly.
2. A directive builder + a new `slice_flow` action `"reflect"` (args: which judge,
   default all) that: gathers override cases from `listTasks` via the T3a metrics
   (cases where `overrideRate` contributed), writes them to a cases file under a
   reflect workdir, and spawns the reflection agent (reuse `slice-flow-oracle-judge`,
   `context: fresh`, the rubric skill injected). Output: `reflect/<judge>-proposals.md`.
3. `prompts/feature-reflect.md`: a slash command that runs the reflect action and
   relays the proposals to the human for review.
4. Tests: the brief is a pure string (assert it names the rubric + cases paths and
   forbids direct edits); the case-gathering is pure over synthetic task metrics.

**Acceptance for T3b:** `/feature-reflect` produces a proposals file of concrete
rubric-skill edits derived from real override cases, written for human review,
applying nothing automatically.

---

## Conventions & guardrails (binding)

- **Tests:** `node --test` (`npm test`). **Typecheck:** `tsc --noEmit -p tsconfig.check.json` (`npm run check`). Both MUST pass.
- New pure logic goes in `extensions/lib/*.ts` with a unit test in `test/*.test.js`. Follow the existing module docstring style.
- **Prompts/briefs are pure string builders** in `briefs.ts` — no IO, no control flow.
- **Spawned agents:** `context: "fresh"`, brief written to disk and injected via `reads` (see `makeBriefStep` in `directives.ts`). Reuse existing agents; add none unless a genuinely new archetype is needed.
- **Read-only for T3a:** the metrics path must not mutate state or touch the workflow. T3b writes only under a reflect workdir and proposes diffs; it never edits a skill or source file.
- **No behavior regressions:** all 135 existing tests must still pass. Do not change gate/judge semantics.
- Keep `config.ts`, agent maps, and the `config-defaults`/`provision`/`agents`/`package-bundle` tests in sync if you add any config key or agent.

## Sequencing
1. T3a metrics module + tests → action → verify.
2. T3b reflect brief + action + prompt + tests → verify.
3. Update README with the two new actions and the `/feature-reflect` command.

## Definition of done
- `npm run check` clean and `npm test` green (≥135 tests, plus the new ones).
- `slice_flow({"action":"metrics"})` renders the cross-run gate/override/token report.
- `/feature-reflect` produces human-reviewable rubric proposals from override cases.
- README documents both; no workflow-behavior change; no new dangling skill/agent references.
