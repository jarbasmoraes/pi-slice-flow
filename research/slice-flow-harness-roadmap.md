# slice-flow Harness Roadmap — Converged & Prioritized

## Implementation status (2026-06-26)

**All 13 findings are implemented.** #6 (loop spawn-cost budget) and #8 (UI-shape
telemetry) landed earlier; the remaining 11 landed in the observability → cost →
design sequence below:

- **Observability:** #1 typed `logEvent` (kind/payload) + #7 single `logGate`
  producer + #3 persisted subagent results & hook diagnostics; #9 real Langfuse
  tracing via the ingestion REST API (`extensions/lib/telemetry.ts`, off by
  default, by-id upsert so it survives `/reload`); #13 real per-agent token cost
  from the `subagent` result `usage` (no pi-subagents patch needed) with an
  async-mode fallback.
- **Cost:** #5 `prototypeCount` 5→3; #2 `models.verifyRegression` (regression
  dims tier down to sonnet, failed dims keep opus); #11 frame-attack ledger-hash
  cache.
- **Design:** #4 split `archRetries` into rejudge/reconsider budgets; #10
  prototype `WINNER: NONE-ACCEPTABLE` reject-all floor; #12 `planCount` plan
  divergence (N candidates → comparative judge → promote winner; `planCount:1` is
  the legacy single-planner path).

Verified: `npm run check` clean, 228 tests pass (+33 new), and the Langfuse
telemetry was smoke-tested against the live self-hosted instance (ingestion 207
→ trace + generation with real cost landed). The headline theme is resolved:
override-rate is now structured (not regex-parsed prose), the loop budget is
deterministic, and real cost is measured per directive.

## 1. Executive summary

The single most important theme is that **slice-flow's two highest-stakes mechanisms — the autonomy ("flip a gate to auto") evidence loop and the runaway-cost guardrail — are both built on signals that cannot bear the weight placed on them.** The override-rate that earns a gate its `auto` flip lives only as free-text `gate <id>: <decision>` lines re-parsed by regex with no producer/consumer coupling (metrics.ts:58, engine.ts:216), and the 3M-token loop budget is enforced against a `Math.ceil((inputChars+outputChars)/4)` estimate that never sees the dominant fan-out spend, so it can essentially never trip (workspace.ts:686, engine.ts:740). The through-line across all three dimensions: **judgment quality floors are missing exactly where the workflow is least measured.** Design gaps (prototype has no reject-all verdict, briefs.ts:243; archRetries shares one budget across cheap and expensive causes, engine.ts:416/521) become live correctness risks only as gates walk from `human` to `auto` — which is the documented end goal (README.md:280). Cost waste (full-Opus regression re-verification every loop iteration, directives.ts:617; 5-way prototype fan-out, config.ts:100) is real but cannot be confirmed-or-tuned because nothing emits per-phase wall-clock or true token cost. Therefore the correct sequence is **observability first** (make spans/structured events/real token usage exist), then **design hardening** of the auto paths, then **cost-tuning** validated against the new measurements. The quick wins are almost all one-file additive changes that the existing on-disk, IO-free design already accommodates.

## 2. Prioritized roadmap (ordered by impact-per-effort; quick-wins first)

| Rank | Dimension | Recommendation | Impact | Effort | Concrete first step (file:function) |
|------|-----------|----------------|--------|--------|--------------------------------------|
| 1 | observability | Add optional typed `kind`/payload to `logEvent` (keep human string) so retry/loop/gate analytics stop depending on byte-identical phrasing | Med | S | workspace.ts:232 `logEvent` — add `kind?`, `payload?`; read it in metrics.ts:58-70 `classifyRetry` |
| 2 | cost | Add `models.verifyRegression` (e.g. Sonnet) and use it for the non-failed "Regression-check" dims; **keep** `reverifyAllInLoop=true` | Med | S | directives.ts:617-620 `loopDirective` (reVerifyDims branch) + new field in config.ts:111 |
| 3 | observability | Persist subagent **result text** + parsed VERDICT/WINNER, add an "unattributed call" diagnostics counter, surface swallowed hook errors | Med | S | workspace.ts:681-688 `observeSubagentResult`; slice-flow.ts:213-233 catch blocks |
| 4 | design+cost | Split `state.archRetries` into separate budgets so cheap lint re-judges can't starve the expensive RECONSIDER full re-run | Low-Med | S | config.ts:103 add `maxArchRejudge`/`maxArchFullReruns`; engine.ts:416 vs :521 |
| 5 | cost | Lower `prototypeCount` 5→3 to match `hypothesisCount`, trimming the Opus prototype-judge's read context ~40% on greenfield-UI runs | Low | S | config.ts:100 `DEFAULT_CONFIG.prototypeCount` |
| 6 | cost | Fix the false `loopTokenBudget` comment (it is unreachable vs the chars/4 metric); treat `maxLoopIterations` as the real cap | Low-Med | S | config.ts:101-102 comment; config.ts:103 budget |
| 7 | observability | Extract one shared `gate <id>: <decision>` formatter/parser constant (or assert engine output against `GATE_LINE` in a test) so a reword can't silently zero override-rate | Low | S | metrics.ts:58 `GATE_LINE` ↔ engine.ts:216 emit |
| 8 | design | Emit a gate-format telemetry line for the UI-shape choice **and** require human confirm before skipping prototypes under `autoApprove` | Med | S | gates.ts:49-58 `askUiShape`; engine.ts:497-508 call site |
| 9 | observability | Open a per-directive/per-phase span at the in-process `tool_call` hook, close at `tool_result`; open root trace in `startWorkflow` | High (enabling) | M | slice-flow.ts:209-234 `pi.on('tool_call')`/`('tool_result')` (NOT issue()) |
| 10 | design | Add `VERDICT: NONE-ACCEPTABLE` to the prototype judge → `clean=false` so a weak UI slate can never auto-adopt once `autonomy.prototype:"auto"` | Med (conditional) | M | briefs.ts:240-250 `prototypeJudgeBrief`; engine.ts:550-575 `onPrototype` |
| 11 | cost | Cache the frame attack panel keyed on ledger-content hash; if adding an iteration cap, surface it to the human (never auto-abort) | Med | M | engine.ts:279-286 `startAttack`; skills/framing-partner/SKILL.md:64 |
| 12 | design | Add **divergence** to PLAN: 2 competing slice decompositions judged comparatively (the one pattern architect has and plan lacks); fix stale context.md | Med | L | directives.ts:399-437 `planDirective` (freshParallel) |
| 13 | observability | Capture **real** subagent token usage at the harness/spawn layer (AssistantMessage.usage), replace chars/4, feed loop budget + span cost | High | L | workspace.ts:686; pi-subagents spawn layer (not a model-emitted marker) |

## 3. Three tracks

**(a) Close the design gaps**
- Prototype reject-all floor: `VERDICT: NONE-ACCEPTABLE` mapped to `clean=false`, mirroring arch RECONSIDER → re-fan-out within `maxPrototypeRetries`. *(briefs.ts:240, engine.ts:550)*
- Split the shared `archRetries` budget so adversary RECONSIDER findings aren't starved by format re-judges. *(engine.ts:416/521, config.ts:103)*
- Bring the run-prototypes-or-not branch under telemetry + human confirm in `autoApprove`. *(gates.ts:49, engine.ts:497)*
- Add divergence (competing decompositions) to PLAN — drop the redundant attack-panel half; the refute-judge already covers MVP/seam/sizing rubric dims. *(directives.ts:399)*

**(b) Make slice-flow measurable (observability)**
- Typed `logEvent` field so retry/loop/gate counters become structured, not prose. *(workspace.ts:232)*
- Per-directive spans anchored at the in-process `tool_call`/`tool_result` pair (per-phase, not per-agent — fan-out lives inside pi-subagents). *(slice-flow.ts:209)*
- Persist subagent result text + unattributed-call diagnostics + surface swallowed errors. *(workspace.ts:681, slice-flow.ts:213)*
- Real token usage from the spawn layer's `AssistantMessage.usage`, not chars/4 or a model-self-reported marker. *(workspace.ts:686)*

**(c) Run it cheaper/faster**
- Tier regression re-verification to Sonnet while failed dims keep Opus (removes ~20 worst-case Opus turns/run). *(directives.ts:617, config.ts:111)*
- `prototypeCount` 5→3. *(config.ts:100)*
- Ledger-hash-cache the 3-Opus frame attack panel to avoid redundant re-attacks within an unchanged explore session. *(engine.ts:279)*
- Fix the misleading `loopTokenBudget` comment; rely on `maxLoopIterations` as the genuine cap until real accounting lands. *(config.ts:101)*

## 4. Sequencing

1. **Observability quick-wins first (ranks 1, 3, 7).** Structured `logEvent`, persisted result text, and a shared gate-line constant are additive, IO-free (honoring T3-SPEC.md:63 "engine untouched" / metrics.ts:6-7 pure), and backward-compatible via `loadState` defaulting. They make every later change measurable and stop silent analytics breakage.
2. **Then real token usage + spans (ranks 9, 13).** Cost-tuning must come *after* this — you cannot confirm that tiering regression verification (rank 2) or trimming prototypes (rank 5) actually saved money while the only cost signal is a chars/4 fiction. Rank 13 specifically de-risks the loop budget guardrail that is currently decorative.
3. **Cost-tuning, now measurable (ranks 2, 5, 6, 11).** Apply once spans/usage exist so before/after deltas are real.
4. **Design hardening last and gated on the autonomy rollout (ranks 4, 8, 10, 12).** These bite only as gates flip to `auto`; rank 8 (UI-shape telemetry) and rank 7 (gate-line robustness) feed the override-rate evidence loop that *decides* those flips — so they should precede flipping `prototype`/`architect` to auto, and rank 10's reject-all floor should land before `autonomy.prototype:"auto"` is ever set.

Key dependency: **observability (1,3,7,9,13) → cost (2,5,6,11) → autonomy-flip-dependent design hardening (10, 8, 4).** Rank 12 (PLAN divergence) is independent and can land anytime.

## 5. Rejected / low-confidence

- **Architecture judge PASS/FAIL floor + unbundle pick-winner-from-compile** — Rejected: the absolute floor already exists downstream as the arch-attack panel's `ARCH-ATTACK: HOLDS|RECONSIDER` over enumerated charters with a full re-run path (engine.ts:437-445, 521-535); comparative-judge-then-adversary is a documented deliberate shape.
- **Implement-phase per-slice gate / "no independent check" hole** — Rejected: an independent fresh-context reviewer already exists (reviewer-solid, directives.ts:440); premises "C absent, G absent, highest blast radius" contradict the cited context.md and the full-diff verify panel mitigates it. Only an optional second blind reviewer survives.
- **Cross-dimension synthesis pass in verify** — Rejected: "use ONLY your rubric" is a lens, not a skip instruction; an overlapping defect is in-rubric for both verifiers. A verdict-only synthesis can't recover a finding nobody wrote; the real (different) question is dimension-set exhaustiveness.
- **Pending-directive heartbeat/TTL for the 16.4h unclosed-span** — Rejected: slice-flow emits no spans and has no daemon/timer; `state.updatedAt` already stamps issue time. At most a "pending Nh (stale)" display in statusSummary using existing data.
- **Cheaper/deterministic tier for all 5 verify dims** — Rejected: `models.verify` is already a `ModelSpec` list supporting per-dim tiering today; and evals/tests are the *most* judgment-heavy dims (no eval harness; tests adequacy is mutation/tautology reasoning), so cheapening them degrades verification.
- **Flipping `reverifyAllInLoop` default to false** — Rejected (kept only the model-tiering half of rank 2): it breaks the documented correctness guarantee (config.ts:75-77, engine.ts:746-749) and deletes the very regression branch the tiering targets.
- **Plan-attack charter panel** — Rejected as redundant (folded into rank 12's divergence-only scope): the proposed charters near-duplicate plan-rubric dims #3/#4/#5 the existing refute-judge already runs, and it overrides the documented per-phase adversary choice (README.md:284).

---
_Generated 2026-06-26 by a 4-phase audit workflow (28 agents): 5 code-mappers → 3 dimension auditors → adversarial per-rec verification (14 confirmed / 5 rejected) → synthesis. Code-first; Langfuse session data used as accent evidence._
