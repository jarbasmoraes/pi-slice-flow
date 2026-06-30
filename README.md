# slice-flow

> A deterministic, judge-gated, six-phase feature-development workflow for the [Pi coding agent](https://github.com/earendil-works) — built so that *judgment lives in editable rubrics*, *every step runs in a fresh-context subagent*, and *verification never relies on Claude-judging-Claude alone*.

slice-flow turns a one-line feature request into a fully-traced pipeline of small, reviewed, verified code slices. You type `/feature <description>`; a thin state-machine extension then drives a parent LLM to spawn a sequence of independent subagents — researchers, adversaries, judges, planners, builders, reviewers, verifiers — each in a brand-new Pi instance with no shared history. State persists to disk at every step, so a run survives restarts, crashes, and `/reload`, and several features can be in flight at once.

## What problem does it solve?

Single-shot "agent, build me X" prompts fail quietly: the model frames the problem its own way, picks the first architecture it thinks of, writes a giant diff, then grades its own homework. slice-flow attacks each of those failure modes structurally:

- **Framing drift** → an interactive FRAME phase with research + adversaries that compiles a decision ledger into a testable spec.
- **First-idea architecture** → parallel hypotheses, a cross-family judge, and an attack panel.
- **Big-bang diffs** → ordered ~100-LOC slices with no forward dependencies, one commit each.
- **Claude grading Claude** → judges routed to a *different model family*, plus a **deterministic check-pack** (secret/SAST/dependency scanners and source-level risk scanners) with *no model in the loop*, so it catches blind spots a same-family judge panel structurally shares.
- **Lost work / no audit trail** → every artifact, brief, directive, and gate decision is written to a resumable on-disk tree, with optional Langfuse telemetry.

---

## Table of contents

1. [Mental model & architecture](#mental-model--architecture)
2. [The six phases](#the-six-phases)
3. [Getting started](#getting-started)
4. [Configuration](#configuration)
5. [Repository layout](#repository-layout)
6. [Skills & agents reference](#skills--agents-reference)
7. [The web-research module](#the-web-research-module)
8. [The risk / check-pack system](#the-risk--check-pack-system)
9. [Extending slice-flow](#extending-slice-flow)
10. [Project status & known limitations](#project-status--known-limitations)

---

## Mental model & architecture

slice-flow is built on a deliberate four-layer separation. Each layer has exactly one job, and the boundaries are the whole point.

| Layer | Where it lives | What it is | What it must *not* do |
|---|---|---|---|
| **Engine (state machine)** | `extensions/lib/engine.ts`, `directives.ts`, `gates.ts` | Thin, deterministic orchestration. Validates artifacts, runs retry budgets, advances `state.phase`, builds the exact `subagent` call for the next step. | Make any product judgment; write feature code. |
| **Judgment (skills)** | `skills/*/SKILL.md` | Plain-Markdown rubrics, charters, and contracts injected into agents at spawn time. **This is the tunable surface** — edit the text, change the behavior, no code change. | Spawn agents; touch disk state. |
| **Execution (subagents/agents)** | `agents/slice-flow-*.md` (+ pi-subagents) | Fresh-context Pi instances that execute one injected brief + one injected skill. | Carry judgment of their own; reuse parent history. |
| **Deterministic checks** | `extensions/lib/checks.ts`, `scanners.ts`, `detect-stack.ts` | No-model lints, regex markers, and external/source scanners that gate a phase *before* a human or model is consulted. | Use an LLM. |

The key invariant: **the parent LLM is only a relay.** It calls the `slice_flow` tool, receives a directive whose `args` are exact `subagent` JSON, invokes that JSON *verbatim*, then calls `slice_flow` action `next`. It never implements work. The single exception is FRAME's explore stage, where the main session itself becomes the framing partner.

### Why "fresh context"?

Every spawned agent runs with `context: "fresh"` + `clarify: false` — a new Pi instance with **no parent conversation history**. The slice (plus prior read-only memos) is the entire truth the agent sees. This makes each judgment independent: a judge cannot be anchored by the builder's reasoning, and an adversary cannot be softened by the framing it is attacking.

### The six-phase flow

```
                                   ┌─ research ─┐
  /feature ──▶ (1) FRAME ◀── explore┤  attack    │   interactive framing partner
                  │                 └─ converge ─┘   (main session + subagents)
                  │  scout compiles ledger ▶ fidelity judge ▶ [FRAME GATE]
                  ▼
              (2) ARCHITECT   N parallel hypotheses ▶ judge picks WINNER
                  │           ▶ attack panel (HOLDS | RECONSIDER) ▶ [ARCH GATE] ▶ ask UI shape
                  ▼
              (3) PROTOTYPE   only when ui = "greenfield"
                  │           N runnable UI prototypes ▶ rubric judge (proto-n | NONE-ACCEPTABLE) ▶ [GATE]
                  ▼
              (4) PLAN        divergent plan candidates ▶ plan judge (PASS/FAIL)
                  │           ▶ ordered ~100-LOC slices, no forward deps ▶ [PLAN GATE]
                  ▼
              (5) BUILD       for each slice:  builder ──▶ reviewer (PASS/FAIL)
                  │                              └─ FAIL ─▶ scoped fix-up (bounded) ─┘
                  ▼
              (6) VERIFY      5 parallel REFUTE verifiers (code-quality, simplicity,
                  │           security, evals, tests)
                  │           all PASS ─▶ deterministic CHECK-PACK ─▶ [COMPLETION GATE] ─▶ done
                  │           any FAIL ─▶ LOOP
                  ▼
                 LOOP         fix failed dims ▶ re-verify; bounded by maxLoopIterations
                              AND loopCostBudget (cost charged BEFORE each spawn)
```

A full mermaid version of the implemented flow lives at [`docs/slice-flow-overview.mmd`](docs/slice-flow-overview.mmd).

### Sequential vs. parallel

- **Chains** (`freshChain`) run steps in order: build→review, compile→judge.
- **Parallel groups** (`freshParallel`) fan out independent work: hypotheses, attackers, plan candidates, the 5 verifiers.

### Gates

A **gate** is a human `approve` / `revise` / `abort` / `pause` decision over a phase artifact. A gate can be made zero-touch by setting `autonomy[gate] = "auto"` — but with two hard rules: **frame is never auto-trusted**, and an artifact that is not `clean` (failed its judges/lints) is never auto-approved. `revise` re-issues the step with notes; `abort` stops the run; `pause` parks it for `/feature-resume`.

---

## The six phases

Each phase ends in a gate and has a bounded auto-retry budget before it surfaces to a human.

### 1. FRAME
**What:** Turns a vague request into a testable spec. After an intake sufficiency check (`SUFFICIENT | QUESTIONS`), the main session enters an **interactive explore stage** as the framing partner, maintaining a live `frame/ledger.md` decision ledger. From here you can fan out `research` (web researchers), `attack` (adversaries against the ledger), and `converge` (compile). The `slice-flow-scout` then compiles the ledger into `01-frame.md` via the **zinsser-framing** skill (single-sentence prose, hedge-word lint, numbered acceptance criteria); a fidelity **oracle-judge** validates it.
**Runs:** main session + `slice-flow-researcher`, `slice-flow-oracle-adversary`, `slice-flow-scout`, `slice-flow-oracle-judge`.
**Gate:** `lintFrame` (seven required sections, banned hedge words, acceptance checklist) → auto-recompile up to `maxCompileRetries` → **frame gate (always human)**.

### 2. ARCHITECT
**What:** Runs `hypothesisCount` `slice-flow-scout` agents in parallel; a judge emits a `WINNER: hypothesis-<id>` marker, with judge-only re-runs bought up to `maxArchRejudge`. An attack panel then runs once under the **architecture-attack** charters (wrong-seam / simpler-structure / fights-the-codebase), emitting `ARCH-ATTACK: HOLDS | RECONSIDER`; a `RECONSIDER` routes through a bounded full regenerate (`maxArchReconsider`).
**Gate:** `lintArchitecture` (ten sections, ≥2 mermaid diagrams, Scores + Requirement Traceability tables) → arch gate → then **asks UI shape** (`greenfield` vs existing).

### 3. PROTOTYPE *(greenfield UI only)*
**What:** `prototypeCount` `slice-flow-builder` agents each build one self-contained runnable UI prototype (**ui-prototyping** skill, distinct position each). A **prototype-rubric** judge emits `WINNER: proto-<n> | NONE-ACCEPTABLE`; `NONE-ACCEPTABLE` triggers regeneration up to `maxPrototypeRetries`.
**Gate:** human approval of the winning UI direction. Skipped entirely for existing UI (the planner uses **design-guidelines** instead).

### 4. PLAN
**What:** With `planCount > 1` (default 2), runs divergent plan candidates and promotes a winner via the **plan-rubric** judge (`VERDICT: PASS | FAIL`); the planner emits ordered ~100-LOC slices (`slices/NNN-slug.md`) governed by **slice-rules**. `lintSlices` enforces contiguous `001` numbering, populated Scope/Acceptance, slice-001-depends-on-none, and the load-bearing **no-forward-dependency** rule. Auto-replans up to `maxPlanRetries`.
**Runs:** `slice-flow-planner`, `slice-flow-oracle-judge`.
**Gate:** plan gate → sets `state.slices` / `sliceIndex` → enters build.

### 5. BUILD
**What:** For each slice, chains `slice-flow-builder` (the **only** writer; has edit/write, TDD-first, ~100/150 LOC budget, one commit per slice) → a fresh `slice-flow-reviewer` (**reviewer-solid**, `VERDICT: PASS | FAIL`). A `FAIL` spawns a scoped fix-up up to `maxFixupsPerSlice`, then offers a human choice. `sliceIndex` advances until all slices are done → verify.

### 6. VERIFY + LOOP
**What:** Fans out **5 parallel REFUTE verifiers** over the verify dimensions (code-quality, simplicity, security, evals, tests), each given exactly one **verify-rubrics** rubric to disprove.
- **All PASS** → runs the deterministic **check-pack** → completion gate → marks phase `done` and finalizes the worktree.
- **Any FAIL** → enters **LOOP**: each iteration spawns fixers for the failed dimensions and re-verifies, bounded by **both** `maxLoopIterations` and `loopCostBudget`. The loop charges the weighted opus-equivalent spawn cost *before* issuing; on overrun it writes a breach report and stops.

---

## Getting started

### Requirements

- **Pi coding agent** with **pi-subagents** installed first:
  ```bash
  pi install npm:pi-subagents
  ```
  (pi-subagents carries the `web_search` / `fetch_content` / `get_search_content` allowlist on the researcher agent.)
- **Node.js** for the test suite (`node --test`).
- **For web-research:** `npm install` (pulls `playwright-core` + extraction libs — downloads *no* browser) plus a system Chrome:
  ```bash
  brew install --cask google-chrome
  ```
- **Optional:** install `gitleaks`, `semgrep`, `osv-scanner` on `PATH` to activate the Tier-A check-pack oracles (missing tools degrade to a logged skip).
- **Optional:** your own `ui-prototyping` / `design-guidelines` skills (PROTOTYPE references them by name and proceeds with a warning if absent — slice-flow ships baseline versions of both).

### Install

```bash
pi install /path/to/slice-flow        # user scope
pi install -l /path/to/slice-flow     # project scope (writes .pi/settings.json)
```

> **Agent provisioning:** Pi has no "agents" resource type, so `pi install` does **not** copy the seven bundled `slice-flow-*` agents. The **first** `/feature` run provisions any missing agents into the project's `.pi/agents/` (existing local copies are preserved so customizations survive). A preflight check runs before the first phase and **fails the whole run up front** — naming every missing agent — if the bundle itself is unavailable (broken install). Old `.pi/agents/slice-<role>.md` files from prior versions are superseded by `slice-flow-<role>.md` and can be deleted.

### Slash commands

| Command | What it does |
|---|---|
| `/feature <description>` | Start a new feature workflow. |
| `/feature-status [slug]` | Show phase / slice / loop / token status. |
| `/feature-resume [slug]` | Continue a task from disk. |
| `/feature-reflect [judge]` | Mine human-override cases and write **proposed** rubric diffs (never auto-applied). |

The cross-run, read-only `slice_flow` actions `metrics` (override rates, retries, token spend across all tasks) and `reflect` back the last two commands.

> With multiple tasks active at once you **must** pass `slug` on every call, or `openTask` throws an "ambiguous" error.

### Web-research health check

```bash
npm run web:doctor
```
Verifies the npm libs import, Chrome launches, a live `example.com` render round-trips, and Markdown extraction works. Exits 0/1.

### Running tests & typecheck

```bash
npm test          # node --test over test/*.test.js (41 files)
npm run check     # tsc --noEmit -p tsconfig.check.json
```

> ⚠️ `tsconfig.check.json` hardcodes **machine-specific absolute paths** to a locally installed `pi-coding-agent` (peer module). You must edit those paths for your machine or `npm run check` will fail.

---

## Configuration

Config resolves through **three layers**, merged by `loadConfig(cwd, homeDir)`:

```
DEFAULT_CONFIG  <  ~/.pi/slice-flow.json (global)  <  ./slice-flow.json (project)
```

The nested maps `autonomy`, `telemetry`, `checks`, `agents`, and `models` **deep-merge key-by-key** (override one phase without restating the whole object); every other top-level key replaces wholesale. A malformed overlay throws a path-qualified JSON error.

### Per-phase agents & models

Keys are identical across `agents` and `models`: `intake`, `research`, `attack`, `compile`, `frameJudge`, `hypothesis`, `architectJudge`, `prototype`, `prototypeJudge`, `plan`, `planJudge`, `build`, `review`, `fixup`, `verify` (and `models` adds `verifyRegression`).

- `agents.<phase>` names a dedicated `slice-flow-<role>` subagent (no generic fallback).
- `models.<phase>` is a **ModelSpec**: a single id (all runs), a `string[]` that round-robins across fan-out runs via `modelAt(spec, i)`, or `null` to inherit the agent/session default.

**Defaults:** discovery/fix-ups → `anthropic/claude-haiku-4-5`; judging / verify / hypothesis → `anthropic/claude-opus-4-8`; regression re-verify → `anthropic/claude-sonnet-4-6`; build / plan / review / fixup → `null` (session default).

### Notable top-level knobs

| Key | Default | Meaning |
|---|---|---|
| `autonomy[gate]` | `"human"` | `"auto"` makes a gate zero-touch (frame pinned human; non-clean artifacts never auto-approve). |
| `judgeFamily` | `"cross"` | Route judges off the builder's family to dodge Claude self-preference; degrades to position-swap when only the host family is present. |
| `planCount` | `2` | Divergent plan candidates (set `1` for legacy single planner). |
| `reverifyAllInLoop` | `true` | Re-run all verify dimensions each loop, not just failed ones. |
| `loopCostBudget` | `30` | Opus-equivalent spawn budget for the verify loop (via `modelWeights`). |
| Retry budgets | — | `maxCompileRetries`, `maxArchRejudge`, `maxArchReconsider`, `maxPrototypeRetries`, `maxPlanRetries`, `maxFixupsPerSlice`, `maxLoopIterations`. |
| Fan-out counts | — | `attackCount`, `hypothesisCount`, `prototypeCount`, `planCount`. |
| `autoApprove` | — | Gate fallback when no UI is attached (otherwise gates **pause** under `-p`/`--mode json`). |
| `autoCommit`, `gitignoreWorkDir` | — | Worktree / commit behavior. |
| `workDir` | — | Task tree location under cwd. |
| `modelWeights` | — | Loop spawn-cost weights; **first lowercase-substring match in key order wins**, so insert more-specific keys (`gpt-5.4-mini`) *before* their prefix (`gpt-5.4`). |

### Check-pack policy (`checks` key)

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the check-pack at the completion gate. |
| `mode` | `"warn"` | `"warn"` rides the gate as a notice; `"block"` stops the run on any finding. |
| `oracles` | `["secrets","sast","deps"]` | Tier-A external scanners to run. |
| `generate` | `true` | Allow Tier-C bespoke check authoring. |
| `maxGenRetries` | `2` | Tier-C authoring retries. |

### Environment variables

- **Telemetry (off by default):** `cfg.telemetry.enabled=true` **plus** `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`); otherwise NOOP. `cfg.telemetry.debug` logs flush failures.
- **Web-research:** see the [web-research module](#the-web-research-module) table below.

---

## Repository layout

```
slice-flow/                         The Pi package (the product)
├── extensions/
│   ├── slice-flow.ts               Composition root: registers the slice_flow tool,
│   │                               observability hooks, /feature-status & /feature-resume
│   ├── web-research.ts             Web-research extension entry: registers the 3 web tools
│   └── lib/
│       ├── engine.ts               Phase state machine: handlers, retries, gates, check-pack wiring
│       ├── directives.ts           Builds exact `subagent` args per step (chains/parallel, judge routing)
│       ├── gates.ts                Human approve/revise/abort/pause; autonomy + clean trust contract
│       ├── workspace.ts            On-disk task tree, State persistence, deterministic lints & markers
│       ├── checks.ts               No-model check-pack runner (Tier-A oracles, Tier-B dispatch, validateCheck)
│       ├── scanners.ts             Pure Tier-B scanners: tenant-predicate, banned-tokens
│       ├── detect-stack.ts         RiskAxis enum, stack probe, manifest build/read/write
│       ├── config.ts               Config types, DEFAULT_CONFIG, 3-layer loadConfig, mergeConfig
│       ├── judge-family.ts         Cross-family judge routing + position-swap
│       ├── metrics.ts              Pure cross-run analysis (override rate, retries, token spend)
│       ├── telemetry.ts            Fail-soft Langfuse ingestion client
│       ├── codegraph.ts            Codegraph index/CLI detection + startup preamble
│       └── web-research/           browser, config, providers, ddg-parse, extract,
│                                   net-guard (SSRF), format, types, util
├── skills/                         13 SKILL.md rubric/charter/contract files (the tunable judgment surface)
├── agents/                         7 slice-flow-* fresh-context subagent definitions
├── prompts/                        feature.md, feature-reflect.md slash-command templates
├── scripts/web-doctor.mjs          Backing script for `npm run web:doctor`
├── test/                           41 node:test files
├── README.md                       Package-level phase map, layout, provisioning rules
├── package.json                    pi.{extensions,skills,prompts,agents}, deps, npm scripts
├── tsconfig.check.json             Machine-specific typecheck config (edit paths per machine)
├── TEST-PLAN.md                    12-step manual end-to-end plan (toy greet.js repo)
├── T3-SPEC.md                      Tier-3 observability/reflect handoff spec
└── TECH-DEBT.md                    Tracked deferred work (DEBT-001)

docs/                               slice-flow-overview.mmd (flow), harness-flow-overview.mmd,
                                    agentic_engineering_topics.md
research/                           slice-flow-harness-roadmap.md, pi-extensibility-report.md
context.md                          Phase strength audit (names PLAN historically weakest)
```

### On-disk task tree (per feature)

State is fully resumable from disk — no phase uses conversation memory:

```
.pi/task/<slug>/
├── state.json          The persisted State / phase / pending directive
├── frame/  slices/  memos/  reviews/  verify/
├── logs/               Briefs (<seq>-<slug>.md) + directive logs
└── chains/             Chain group records
```

The `reflect/` folder sits beside task slugs but carries no `state.json`, so `listTasks` ignores it. The committed check-pack manifest lives separately at `.slice-flow/checks/manifest.json`.

---

## Skills & agents reference

### Skills (`skills/*/SKILL.md`) — the tunable judgment surface

| Skill | Role |
|---|---|
| `framing-partner` | Socratic/adversarial stance + research/attack/converge rules for the FRAME explore stage. |
| `zinsser-framing` | How the scout compiles the frame from the ledger: sections, numbered acceptance criteria, hedge-word lint. |
| `architecture-attack` | Adversary charters (wrong-seam / simpler-structure / fights-the-codebase) + `HOLDS\|RECONSIDER` marker. |
| `plan-rubric` | Plan-judge refute dimensions (coverage, no scope inflation, sequencing, MVP integrity, sizing, fidelity). |
| `prototype-rubric` | UI/UX refute criteria + `WINNER: proto-<n> \| NONE-ACCEPTABLE` format. |
| `ui-prototyping` | How a builder makes one self-contained runnable greenfield prototype. |
| `design-guidelines` | Non-greenfield rule: conform to existing components/tokens/patterns. |
| `slice-rules` | The binding slice contract: format, fresh-context discipline, TDD-first, LOC budget, one-commit-per-slice, memo. |
| `reviewer-solid` | Per-slice review criteria (contract fidelity, tests, SOLID/DRY, isolation) + `VERDICT: PASS\|FAIL`. |
| `verify-rubrics` | One refute rubric per verify dimension (code-quality, simplicity, security, evals, tests). |
| `risk-taxonomy` | Catalog of deterministic risk axes (live-when / touched-when / check). |
| `check-generator` | How to author a deterministic check + planted-violation fixture (RED-on-fixture / GREEN-on-clean). |
| `codegraph` | Steers scout/builder to prefer codegraph structural queries over grep/find/read. |

Several skills declare themselves explicitly editable: `plan-rubric`, `prototype-rubric`, `architecture-attack`, and `verify-rubrics` are "the tunable surface — edit it to sharpen the judge over time"; `slice-rules` and `risk-taxonomy` carry **OWNER'S RULES BLOCK** markers for project-specific tuning.

### Agents (`agents/slice-flow-*.md`) — fresh-context roles

| Agent | Default model | Tools | Role |
|---|---|---|---|
| `slice-flow-scout` | haiku (→ opus on hypothesis) | read-only | Intake checks, frame compilation, architecture hypotheses; writes one artifact. |
| `slice-flow-researcher` | haiku | `web_search`/fetch tools | Answers exactly one framing question with a source-backed brief. |
| `slice-flow-oracle-adversary` | opus | read-only (`completionGuard:false`) | Breaks a frame/architecture/plan on its assigned charter; writes one objections file. |
| `slice-flow-oracle-judge` | opus | read-only (`completionGuard:false`) | Refutes an artifact against its rubric; returns the exact verdict marker. |
| `slice-flow-planner` | phase-inherited | read-only | Turns approved frame+architecture into ordered ~100-LOC slices. |
| `slice-flow-builder` | phase-inherited | **edit/write** | The single writer thread; builds one slice TDD-first, applies fix-ups, resolves loop failures. |
| `slice-flow-reviewer` | opus | read-only (no edit) | Judges a built slice **or** refutes one verify dimension; writes only a verdict file. |

Read-only roles set `completionGuard: false` so pi-subagents doesn't misclassify a correct no-edit verdict as a failed task. Every agent lists `fallbackModels` (codex/ollama chains) as a provider-outage net. Build/plan/prototype agents deliberately omit a `model:` line so they inherit the phase model.

---

## The web-research module

A self-hosted, keyless-by-default web-research extension that registers three tools used by `slice-flow-researcher`. It renders pages with a headless **system Chrome** via `playwright-core` (no npm-downloaded browser), extracts main content to Markdown with Mozilla Readability, and **guards every request against SSRF** — no third-party scraping proxy, no stored credentials.

### Tools

| Tool | Caps |
|---|---|
| `web_search` | 1–5 queries; `maxResults` ≤ 20. Per-query failures are captured; only an all-failed run throws. |
| `fetch_content` | One URL → readable Markdown; `maxChars` default 20 000, clamped 1 000–100 000. |
| `get_search_content` | Search (n default 3, cap 8) then fetch pages at concurrency 3, with `[FETCH FAILED]` markers per source. |

### How it works

`getBrowser` lazily launches one shared `chromium` (channel `"chrome"`, or an explicit executable path) and opens a **fresh ephemeral context** per call (no shared cookies). Each render validates the URL with `assertPublicHttpUrl`, does a DNS lookup + `assertResolvedPublic` (DNS-rebind block), routes every request through `isBlockedHost` while aborting image/media/font resources, and navigates `domcontentloaded` (30s) + best-effort `networkidle` (5s). The default **DDG** provider POSTs the query form to `html.duckduckgo.com` (falling back to `lite.duckduckgo.com` on a `DdgChallengeError`) — no API key. A challenged search or blocked page returns an explicit error marker so agents record "source unavailable" instead of hallucinating.

### Config (precedence: **env var > `~/.pi/web-research.json` > default**)

| Env var | File key | Default |
|---|---|---|
| `WEB_SEARCH_PROVIDER` | `provider` | `"ddg"` (also `perplexity`, `google`) |
| `WEB_SEARCH_MAX_RESULTS` | `maxResults` | `8` (clamped 1–20) |
| `WEB_RESEARCH_BROWSER_PATH` | `browserExecutablePath` | — (overrides channel) |
| `WEB_RESEARCH_BROWSER_CHANNEL` | `browserChannel` | `"chrome"` |
| `WEB_RESEARCH_HEADLESS` | `headless` | `"true"` (anything but `"false"` is headless) |
| `PERPLEXITY_API_KEY` | `perplexityApiKey` | — (model `sonar`) |
| `GOOGLE_API_KEY` + `GOOGLE_SEARCH_CX` | `googleApiKey` / `googleCx` | — (both required) |

> The SSRF guard blocks localhost / private / CGNAT / `169.254.169.254` cloud-metadata / `metadata.google.internal` and DNS-rebind targets, so it **cannot** fetch internal or localhost URLs. Add a new engine by registering a `SearchProvider` in `providers.ts` `REGISTRY`.

---

## The risk / check-pack system

The check-pack converts "an LLM might miss this class of bug" into deterministic gates that sit **outside the model's correlated error space**. It runs only at the verify-done moment (when all 5 model verifiers would PASS) and writes `<task>/verify/check-pack.md` with its own `VERDICT:` marker.

### Three tiers

| Tier | What | Activation |
|---|---|---|
| **A — universal oracle** | `gitleaks` (secrets), `semgrep` (SAST), `osv-scanner` (deps). | Zero-config, `PATH`-probed via `which`; a missing binary is a **SKIP**, an oracle that throws **is a finding**. |
| **B — stack-templated** | Pure source scanners: `tenant-predicate` and `banned-tokens`. | Selected by stack detection; enforce **only** when the manifest is `confirmed: true`. |
| **C — bespoke generated** | A check authored for a live, uncovered risk axis. | Admitted only after `validateCheck` proves it's **RED on a planted fixture AND GREEN on a clean tree**. |

### Risk axes & "live ∧ touched ∧ uncovered"

The `RiskAxis` enum (`secrets`, `injection`, `multi-tenancy`, `authz`, `pii-logging`, `migration-lineage`, `money-idempotency`, `rate-limit`, `xss`) is the machine mirror of the `risk-taxonomy` skill — **the two must stay in sync**. `detectStack` reads dependency maps, lockfiles, and compose files to produce stack signals; `classifyAxes` maps presence to *live* axes (conservatively — a false-live costs one human "no"). An axis is a **Gap** only when it is **live AND touched by the diff AND uncovered** — a live axis the diff never exercises is not a gap.

### The manifest

`.slice-flow/checks/manifest.json` is committed to the project: `version`, `detectedAt`, `signals`, `axes`, `checks[]`, and a `confirmed` flag. Re-running detection (`buildManifest`) **never clobbers** human-filled params or the `confirmed` flag. Because detection is a heuristic, a **one-time human confirm** must flip `confirmed` before Tier-B enforces (for headless enforcement, commit a manifest with `"confirmed": true`). A Tier-B check whose required holes are unfilled (e.g. tenant-predicate `labels`) is a **pending check** — skipped with a nudge, never silently passed or enforced.

### Two scanners worth knowing

- **`scanTenantPredicate`** extracts backtick template literals and flags any `MATCH`/`MERGE`/`CREATE` on a configured tenant label (or a vector/fulltext search proc) that lacks a tenant predicate **and** lacks a `@tenant-safe` annotation. Opt out with `@tenant-safe: <reason>`.
- **`scanBannedTokens`** strips comments and flags configured tokens (e.g. `dangerouslySetInnerHTML`, `rehype-raw`) in guarded file suffixes.

Both return `[]` (disabled) when their key param list is empty.

> **Field note:** the deterministic tenant-predicate check has been backtested — it caught a real P0 cross-tenant leak in a sibling project (4 hits pre-fix, 0 false positives on the fixed HEAD).

---

## Extending slice-flow

### Tune a judge or contract
Edit the relevant `SKILL.md` directly — the rubric text *is* the behavior, no code change needed. For `slice-rules` and `risk-taxonomy`, edit **only between the OWNER'S RULES markers** (e.g. retune the LOC budget, the memo format, or your threat-model axes).

### Add a deterministic check (new stack / axis)
1. Add a marker package (one line) to the `MARKERS` table in `detect-stack.ts`.
2. Extend the `RiskAxis` union **and** the `risk-taxonomy` `SKILL.md` OWNER RULES in lockstep (the file explicitly says keep `key:` in sync with the enum).
3. Wire presence→axis in `classifyAxes`.
4. Emit any Tier-B check in `selectChecks` (tenant-predicate needs `{labels, predicateFields, safeAnnotation, glob}`; banned-tokens needs `{tokens, guardedSuffixes, glob}`).
5. For a bespoke Tier-C check, author it via the `check-generator` skill with a planted-violation fixture — it's admitted only if `validateCheck` shows RED-on-fixture / GREEN-on-clean.

### Add a risk axis (summary)
Keep three things in sync: the `RiskAxis` enum, the `risk-taxonomy` `SKILL.md`, and the per-project `manifest.json`. The taxonomy file has editable BEGIN/END OWNER RULES for retuning to a non-web threat model.

### Swap a model
Prefer changing the **phase model** in `slice-flow.json` over editing an agent file — build/plan/prototype agents inherit the phase model precisely so you can do this. To fan a phase across families, set its `models.<phase>` to a JSON array (`modelAt` round-robins by run index). To register a new cross-family judge, add `{family, cli, model}` to `JUDGE_FAMILY_REGISTRY` (presence is a `which <cli>` probe). To change tools, edit the agent's `agents/*.md` frontmatter.

### Enable codegraph
Run `codegraph init`. The index is any `*.db` under `.codegraph/` (gitignored); detection walks ancestor directories up to the repo root to find it from inside a nested worktree.

### The self-improving loop
`/feature-reflect [judge]` (or `slice_flow` action `reflect`) mines human-override cases and spawns a fresh `oracle-judge` that writes **proposed** unified-diff rubric edits for human review only — **nothing is auto-applied.** Frame is excluded (human-pinned, no tunable rubric). The cross-run `metrics` action computes per-gate **override rate** = `(revise + abort) / total`, the evidence that earns a gate its `autonomy: "auto"` flip.

---

## Project status & known limitations

slice-flow is **v0.1.0, MIT-licensed**, with a healthy automated baseline (41 `node:test` files). The converged 13-finding harness roadmap in `research/` is marked fully implemented as of 2026-06-26.

Honest caveats, pulled from the tech-debt and status digests:

- **DEBT-001 (open):** the web-research layer launches **one Playwright browser per extension process**, so a large parallel research fan-out spawns N browsers (~150–300 MB each) and can OOM. The fix (a shared connect-over-CDP browser server) is deferred until the trigger actually fires. `closeBrowser()` exists for teardown.
- **`tsconfig.check.json` is machine-specific:** it hardcodes absolute paths to a locally installed `pi-coding-agent`. `npm run check` fails until you edit them for your machine.
- **PLAN was historically the weakest phase** (per `context.md`'s strength audit — missing divergence/adversary/judge/lint); divergent plans + a plan judge + `lintSlices` were the direct response. Set `planCount: 1` only if you want the legacy single-planner behavior.
- **Agents are not auto-installed:** Pi has no agents resource type, so provisioning happens on first `/feature` run, guarded by a hard preflight. Skills must be installed **as a package** (`pi install`) — a one-off `pi -e` will not register them.
- **Manual E2E only:** the end-to-end flow is exercised by the 12-step `TEST-PLAN.md` on a toy `greet.js` repo (including failure injection, resume/kill, double-start and broken-install guards), not by automated integration runs.
- **Operational gotchas:** check-pack `block` mode can stop an otherwise-clean run; a detected risk profile stays quarantined until a human confirms it; gates **pause** (no silent auto-approve) under `-p`/`--mode json` unless `autoApprove: true`; the worktree prompt only fires on a git repo with a UI present.
