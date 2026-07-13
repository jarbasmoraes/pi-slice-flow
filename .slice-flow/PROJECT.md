<!-- SLICE-FLOW PROJECT PROFILE (managed by `slice-flow init`; safe to hand-edit) -->
# Project profile

## Domain & vocabulary
**slice-flow** is a deterministic, judge-gated, six-phase feature-development workflow orchestrated as a Pi coding-agent extension. It breaks monolithic feature requests into ordered ~100-LOC slices with no forward dependencies, runs each through builder→reviewer→verifier chains, and gates each phase on rubric judges + deterministic checks (never model-judging-model alone).

**Core terms:**
- **Feature** — a single user-facing capability, always initiated by `/feature <description>`. Runs as a deterministic state machine through FRAME→ARCHITECT→(PROTOTYPE)→PLAN→BUILD→VERIFY→(LOOP).
- **Slice** — a ~100-LOC, single-commit, test-first hunk of work with a concrete acceptance contract (`NNN-<slug>.md`). Slice 001 is the minimal working MVP; every later slice keeps the system runnable.
- **Rubric** — an LLM-facing Markdown skill file (SKILL.md) that holds the explicit judgment criteria, decision charters, and contract terms. Rubrics are the tunable surface; editing one changes workflow behavior without code changes.
- **Subagent** — a fresh Pi instance (no parent conversation history) spawned for one phase-step. Each role (scout, researcher, adversary, judge, planner, builder, reviewer, verifier) is a dedicated `slice-flow-<role>.md` agent.
- **Gate** — a human approve/revise/abort/pause decision, or (when `autonomy[gate]="auto"`) a zero-touch pass. Frame gate is pinned human; others can be auto-trusted once a gate earns it via override metrics.
- **Check-pack** — deterministic (no-model) gating at verify completion: Tier-A universal scanners (`gitleaks`, `semgrep`, `osv-scanner`), Tier-B stack-templated checks (tenant-predicate, banned-tokens), and Tier-C bespoke checks. A **Gap** is a risk axis that is live, touched by the diff, and uncovered by checks.

## Architectural invariants & seams
slice-flow enforces four hard layer boundaries, each with a single responsibility:

| Layer | Responsibility | Location | Must NOT |
|---|---|---|---|
| **Engine (state machine)** | Deterministic orchestration: validate artifacts, run retry budgets, advance `state.phase`, build exact `subagent` calls. | `extensions/lib/engine.ts`, `directives.ts`, `gates.ts` | Make product judgment; write feature code. |
| **Judgment (skills)** | Rubric text is the behavior: decision criteria, attack charters, contract terms, acceptance conditions. One Markdown file per skill; editing it changes workflow behavior. | `skills/*/SKILL.md` (13 skills) | Spawn agents; touch disk state. |
| **Execution (agents)** | Fresh-context subagents: one injected brief + one injected skill, no parent conversation memory. | `agents/slice-flow-*.md` (7 agents) | Reuse parent history; make independent judgment. |
| **Deterministic checks** | No-model lints, regex/AST scanners, external tool runners (gitleaks, semgrep, osv-scanner). Gates phases before a human or model is consulted. | `extensions/lib/checks.ts`, `scanners.ts`, `detect-stack.ts` | Use an LLM. |

**Seams & no-crossing rules:**
- **Parent LLM is a relay only:** it invokes the `slice_flow` tool, receives an exact directive JSON, calls it verbatim via `subagent`, then advances via `slice_flow next`. It never implements work. Exception: FRAME explore stage where the main session itself is the framing partner.
- **Judge families are orthogonal:** builders (default Haiku) use their own model; judges (default Opus) route to a cross-family via `resolveJudge` (Claude→GPT, etc.) to dodge model self-preference. Degrades to position-swap when only one family is available.
- **Fresh context is binding:** every spawned subagent runs with `context: "fresh"` + `clarify: false`. No shared history. Slice + prior read-only memos = entire truth the agent sees.
- **Slice is the contract:** builders read only the slice file (`NNN-<slug>.md`), never conversation history or decisions from prior phases. Scope creep is instant: anything not in the slice is not the job.
- **No forward dependencies:** every slice is self-contained; slice N never depends on the implementation details of slice N+1. Enables true parallelization if needed.

## Conventions
**Test framework:** Node.js built-in `node:test` with `node:assert/strict`. Run with `npm test` (41 files at `test/*.test.js`).

**TypeScript:** `npm run check` runs `tsc --noEmit -p tsconfig.check.json`. **Machine-specific:** the config hardcodes absolute paths to locally installed `pi-coding-agent` (peer dependency); edit paths for your machine.

**Code structure:**
- **Extensions** (`extensions/*.ts`) register Pi tools and skills.
- **Workspace model** (`extensions/lib/workspace.ts`) is pure: types, file I/O, deterministic lints (`lintFrame`, `lintArchitecture`, `verdictOf`), no side effects.
- **Engine** (`extensions/lib/engine.ts`) is the phase state machine: calls workspace lints, invokes gates, builds directives, persists state.
- **Directives** (`extensions/lib/directives.ts`) build exact `subagent` JSON arguments (chains, parallel groups, injected briefs + skills).
- **Config** (`extensions/lib/config.ts`) three-layer merge: DEFAULT_CONFIG < `~/.pi/slice-flow.json` (global) < `./slice-flow.json` (project).

**Naming:**
- Agents: `slice-flow-<role>.md` (scout, researcher, oracle-adversary, oracle-judge, planner, builder, reviewer).
- Skills: `skills/<kebab-name>/SKILL.md` (framing-partner, zinsser-framing, slice-rules, reviewer-solid, verify-rubrics, etc.).
- Slice files: `slices/NNN-<slug>.md` (zero-padded 3-digit ordinal + kebab-slug).
- Task tree: `.pi/task/<slug>/state.json` + `frame/`, `slices/`, `memos/`, `reviews/`, `verify/`, `logs/`, `chains/`.

**Error handling & reporting:**
- Errors thrown by validation (bad input) are caught at gates and surfaced as human revise prompts.
- Lint failures (`lintFrame`, `lintArchitecture`, `lintSlices`, `lintMemo`) are deterministic gates that auto-retry up to a budget.
- A check-pack finding is either a skip (tool missing), a warning, or a block — never silently passed.

**Commit convention:**
One commit per slice (when `auto_commit: true`). Message: `slice NNN: <slice title>`. No merging slices; never push during a build run.

**Telemetry:**
Optional Langfuse integration (off by default). Env vars: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`). Set `cfg.telemetry.enabled=true` to activate; missing credentials → NOOP.

## Preferred libraries / banned patterns
**Preferred:**
- **Playwright** (via `playwright-core`) for web research: headless Chrome, page rendering, content extraction with Mozilla Readability.
- **Turndown** for HTML→Markdown conversion.
- **Linkedom** for DOM manipulation without a full browser.
- **Node built-ins** (`node:fs`, `node:crypto`, `node:path`, `node:url`, `node:test`, `node:assert`) — no heavy dependencies.
- **ES modules** (`type: "module"` in package.json; all imports/exports modern).

**Banned patterns:**
- **Never share model judgment across phases:** judges always get fresh context and a binding rubric, never "what did the builder think."
- **Never invent scope:** if it's not in the slice/frame/architecture/plan, it's not the job.
- **No drive-by refactors in a slice build:** fix-related bugs noted in the memo, not fixed inline.
- **No unsheltered writes:** only the builder writes code; reviewer, verifier, adversary, judge, researcher are all read-only.
- **No persistent browser state:** every web-research fetch uses a fresh ephemeral context (no shared cookies, no login state).
- **No bash execution in judges/verifiers:** use deterministic lints and scanners, never `exec` in a model-driven phase.

## Risk model notes
slice-flow's check-pack enforces **9 risk axes** (`RiskAxis` enum in `extensions/lib/detect-stack.ts`; kept in sync with `skills/risk-taxonomy/SKILL.md`):

| Axis | Live when | Coverage check | Tier |
|---|---|---|---|
| **secrets** | always | `gitleaks` (universal scanner) | A |
| **injection** | code builds queries/shells (DB, ORM, `exec`/`eval` sinks) | `semgrep p/owasp-top-ten` (SAST rules) | A |
| **multi-tenancy** | shared store partitioned by tenant (auth + database) | `tenant-predicate`: query must bind tenant predicate OR carry `@tenant-safe` annotation | B |
| **authz** | auth provider present | route-coverage lint (every handler asserts authz) OR integration test (non-owner denied) | B/C |
| **pii-logging** | user data in system (auth provider or user store) | banned-field scanner over log call sites; redaction assertion in logger | B |
| **migration-lineage** | ORM/migration tool present | `prisma migrate diff` or equivalent (drift check against live schema) | C |
| **money-idempotency** | payment provider present | every charge passes idempotency key; retry/replay test (no double effect) | C |
| **rate-limit** | public web surface or job queue | limiter/concurrency bound on public mutating routes and queue consumers | C |
| **xss** | markdown/HTML renderer present | banned-tokens scanner (`dangerouslySetInnerHTML`, `rehype-raw`, `skipHtml`, etc.) over guarded renderer files | B |

**Gap = live ∧ touched ∧ uncovered.** A diff can touch multiple axes; only report coverage gaps (live + touched + no deterministic check).

**Check-pack governance:**
- Stack detection runs once at `/feature-init` or first phase, probes dependencies + compose files, emits `axes[]` and `checks[]` to `.slice-flow/checks/manifest.json`.
- Tier-B checks (tenant-predicate, banned-tokens) are pending until a human confirms `manifest.confirmed: true` (one-time flip; persisted in git).
- Tier-C (bespoke checks) admitted only after `validateCheck` proves RED on a planted-violation fixture AND GREEN on clean tree.
- Check mode: `"warn"` (notice on gate) or `"block"` (stops run on any finding).

**Project-specific tuning:** edit `OWNER'S RULES` blocks in `skills/risk-taxonomy/SKILL.md` and `skills/slice-rules/SKILL.md` to adjust threat model and LOC budgets for your context.

## Definition of done
A feature is done when:

1. **All slices built and merged:** every `NNN-<slug>.md` slice in the plan has a passing build review and memo, committed to the working tree.
2. **All verifiers pass:** the 5 parallel REFUTE verifiers (code-quality, simplicity, security, evals, tests) all emit `VERDICT: PASS` over the final diff.
3. **Check-pack passes or is waived:** deterministic checks (Tier A/B/C) run at the verify-done moment and emit `VERDICT: PASS` (or known exceptions are documented in the review).
4. **Frame acceptance criteria met:** the slice implementations satisfy the numbered acceptance criteria from the approved frame document (`01-frame.md`).
5. **No open loops:** if verify loops to fix failures, all loop iterations complete and pass re-verify (bounded by `maxLoopIterations` + `loopCostBudget`).
6. **Completion gate approved:** a human (or autonomy-auto) approves the verify findings and check-pack report; the run is marked phase-done and the worktree is finalized.

**Evidence required:**
- Built slices with passing reviews and memos.
- Test coverage: every slice has TDD tests for its acceptance criteria.
- Deterministic checks: gitleaks, semgrep, osv-scanner outputs (Tier A); project-confirmed Tier B/C checks pass.
- Diff audit: reviewer's green light on contract fidelity, test coverage, SOLID/DRY principles, and isolation.
- Frame traceability: every acceptance criterion is cited in a slice acceptance or memo.

**Optional (not blocking but recommended):**
- Integration test(s) proving the feature end-to-end.
- Docs update if the feature adds a public API or configuration knob.
- Performance/load test if the feature touches a hot path.
