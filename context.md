# Code Context — slice-flow phase strength audit

Structural audit of which of FRAME's strength-giving patterns (A–I) each later phase
has. Phases run: **frame → architect → (prototype) → plan → build/fixup → verify → loop**.

## Files Retrieved
1. `slice-flow/extensions/lib/directives.ts` (1-330) — every phase's `subagent` args: who fans out, what's parallel, what's a judge step, retry envelopes.
2. `slice-flow/extensions/lib/engine.ts` (1-470) — state machine: artifact validation, lint calls, gates, retry budgets, phase advance. `HANDLERS` map ~line 360.
3. `slice-flow/extensions/lib/briefs.ts` (1-300) — all prompt text: intake/research/attack/compile/frameJudge/hypothesis/architectJudge/prototype(+judge)/plan/build/review/fixup/verifier/loopFix.
4. `slice-flow/extensions/lib/workspace.ts` (266-414) — deterministic checks: `verdictOf`, `intakeMarkerOf`, `lintFrame`, `lintArchitecture`, `winnerOf`, `listSliceFiles`, `readVerifyVerdicts`.
5. `slice-flow/extensions/lib/config.ts` (66-118) — per-phase agent+model defaults (opus for judges/verify; haiku for hypothesis/prototype/fixup; session-default for compile/plan/build).
6. `slice-flow/extensions/lib/gates.ts` (15-50) — `gate()` approve/revise/abort/pause, `askUiShape`.
7. `slice-flow/skills/` — framing-partner, zinsser-framing, slice-rules, reviewer-solid, verify-rubrics, codegraph (6). `slice-flow/agents/` — scout, oracle, researcher, planner, builder, reviewer (6).

## The 9 strength patterns (FRAME = the bar)
A=Intake/triage · B=Divergence (N competing fresh attempts) · C=Dedicated adversary (break-it, separate from judge) · D=Judge with enumerated FAIL conditions · E=Deterministic lint · F=Traceability artifact a judge diffs against · G=Human gate w/ smart revise routing · H=Evidence grounding (research/citations/file-paths) · I=Retry budget w/ graceful escalation

## Strength Matrix

| Phase | A Intake | B Diverge | C Adversary | D Judge | E Lint | F Trace | G Gate | H Evidence | I Retry |
|---|---|---|---|---|---|---|---|---|---|
| **FRAME** | ✅ `intakeBrief` INTAKE: marker | ✅ research+attack parallel fan-outs | ✅ 3 `ATTACK_CHARTERS`, agent≠judge | ✅ `frameJudgeBrief` 5 enumerated FAILs | ✅ `lintFrame` sections+banned words+criteria | ✅ ledger; judge diffs frame↔ledger | ✅ `onFrameCompiled`; revise→explore, feedback appended to ledger | ✅ researcher w/ citations + "claims cite code" | ✅ `maxCompileRetries`→gate warn |
| **ARCHITECT** | ❌ frame trusted as-is | ✅ 3 `HYPOTHESIS_ANGLES` parallel, failFast | ⚠️ only self "What would falsify" + comparative judge; nothing attacks the winner | ⚠️ `architectJudgeBrief` scores+WINNER but **comparative selector, no enumerated FAILs** | ✅ `lintArchitecture` sections+mermaid+table | ⚠️ "Risks carried forward"; no diffed source-of-truth | ✅ `onArchitect`; revise routes re-judge vs full re-run | ⚠️ "verify against actual code" but no research/citations | ✅ `maxArchitectRetries`, judge-only re-run |
| **PROTOTYPE** | ❌ | ✅ `prototypeCount`=5 parallel | ❌ none | ⚠️ `prototypeJudgeBrief` picks winner, **no VERDICT / no FAIL conditions** | ❌ none | ❌ JUDGEMENT.md = selection only | ❌ **`onPrototype` auto-advances, no human gate** | ⚠️ inspects code+README only | ❌ reissue only if file missing |
| **PLAN** | ❌ | ❌ **single planner, one plan** | ❌ **none** | ❌ **no judge — raw to human gate** | ❌ **`listSliceFiles` only checks `NNN-*.md` filename** | ⚠️ "trace to frame" asked, not enforced/diffed | ✅ `onPlan` runGate, revise→`planDirective(notes)` | ⚠️ "plan against actual code", snippets asked | ❌ reissue only if missing |
| **BUILD/fixup** | ❌ slice = spec | ❌ **single builder per slice** | ✅ `reviewBrief`/reviewer-solid, fresh, "not the builder's friend" | ✅ `VERDICT` + reviewer-solid severities | ❌ **no memo-format lint** (only `nonEmpty` check) | ✅ required memo (files+hash); "memo that lies is blocker" | ⚠️ **no PASS gate; human only after `maxFixupsPerSlice` exhausted** | ✅ reviewer reads diff via git, runs tests | ✅ `maxFixupsPerSlice` loop→escalate |
| **VERIFY** | ❌ | ✅ 5 `VERIFY_DIMENSIONS` parallel | ✅ every verifier "REFUTE, do not confirm" | ✅ per-dim `VERDICT` + verify-rubrics hunt-lists | ⚠️ `verdictOf` parse + missing→reissue; no content lint | ✅ per-dim findings vs frame/arch/plan | ❌ **`onVerified` auto done/loop, no human gate** | ✅ runs diff/tests, "reproducible by a stranger" | ✅ `maxLoopIterations`+`loopTokenBudget`+breach report |
| **LOOP** | ❌ | ⚠️ parallel per failed dim, single fixer each | ✅ reuses refute verifiers | ✅ re-verify verdicts | ❌ | ⚠️ refs verify report+plan; no memo update | ❌ auto-loops | ✅ re-verify runs evidence | ✅ same caps as verify |

✅ present · ⚠️ partial · ❌ absent

## Top cross-cutting gaps (ranked by how much they widen the gap from FRAME)

1. **PLAN is the weakest phase by far — missing C, D, E, B all at once.** It is a *single* planner with *no adversary, no judge, no slice-format lint, no divergence* — straight to the human gate. The plan + slice files are the contract every builder reads in fresh context, so an unjudged/unlinted plan is the highest-leverage defect surface in the whole pipeline. Frame, by contrast, never lets its output reach the human un-judged and un-linted. (`planDirective`, `onPlan`, `listSliceFiles` filename-only check.)

2. **No phase except FRAME (and build/verify) has a *dedicated adversary* (C).** Architect and prototype rely on *comparative judges* — "pick best of N" — which is categorically weaker than an agent chartered to destroy the chosen output. The winning architecture and winning prototype are never attacked the way the framing is by `ATTACK_CHARTERS`. Self-reported "What would falsify this" is not an independent adversary.

3. **Mechanical lint (E) exists only for frame & architecture.** Plan slice files, prototypes, and build memos have no deterministic format gate, so a malformed slice contract or a lying-shaped memo can pass into the next phase on `nonEmpty()` alone. Frame's `lintFrame` (sections + banned words + testable-criteria presence) is the model to replicate.

4. **Judges that *select* vs. judges that *gate* (D).** Frame & verify judges enumerate explicit FAIL conditions; architect & prototype judges only rank. A comparative winner can still be globally inadequate and there is no FAIL path — only the human gate (architect) or nothing at all (prototype).

5. **Human gate (G) absent on PROTOTYPE and VERIFY; BUILD gate only fires on failure.** The prototype winner auto-selects into the plan and verify auto-advances to done — two irreversible-ish transitions with no human checkpoint, unlike frame/architect/plan.

6. **Traceability artifact (F): the ledger is unique to FRAME.** No downstream phase has an authoritative source doc that a judge diffs for lossless-ness. Architect "Risks carried forward" and the build memo are partial analogs; plan and prototype have none, so "did we drop a frame requirement?" is never mechanically checkable after the frame phase.

7. **Intake/triage (A) is frame-only.** Nothing checks "is the frame actually buildable?" before architect, or "is the architecture decided enough to plan?" before plan. Each phase trusts its input artifact is sufficient.

8. **Evidence grounding (H): only FRAME can pull external/domain facts.** Its research fan-out with mandatory citations has no equivalent downstream — architect/plan grounding is code-only ("check the actual code"), with no source-backed mechanism for library/pattern/prior-art questions that arise during design.

## Start Here
Open **`slice-flow/extensions/lib/briefs.ts`** (the prompts) alongside **`directives.ts`** (the orchestration). To close the #1 gap, the pattern to copy is the frame compile+judge pair: add a `planJudgeBrief` with enumerated FAIL conditions + a `lintPlan`/`lintSlice` in `workspace.ts`, then wire a judge step into `planDirective` and a lint check into `onPlan` — mirroring `compileDirective`/`onFrameCompiled` exactly.

## Supervisor coordination
Not blocked; no decision needed. Findings are evidence-first and complete.
