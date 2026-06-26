# slice-flow

A Pi package implementing a six-phase feature development workflow on top of
[pi-subagents](https://github.com/nicobailon/pi-subagents). The extension is a
thin, deterministic state machine; **all judgment lives in skills, all agent
spawning lives in pi-subagents** (chains for sequential phases, parallel mode
for fan-outs). Every spawned agent is a fresh Pi instance (`context: "fresh"`)
with no parent conversation history.

Phase 1 (FRAME) is the deliberate exception to "everything is a fresh agent":
the main session becomes the user's **framing partner** — Socratic,
adversarial, with on-demand web-research and attack fan-outs — because the
frame is where human intent gets compressed into the spec every later phase
runs on. The package ships its own Playwright-backed web tools
(`extensions/web-research.ts`, free DuckDuckGo default, no API keys) so the
research fan-out works out of the box.

## Requirements

- `pi-subagents` installed (`pi install npm:pi-subagents`) — slice-flow issues
  `subagent` tool calls; it never spawns processes itself. The bundled
  `slice-flow-researcher` agent carries the
  `web_search`/`fetch_content`/`get_search_content` allowlist (same names
  pi-web-access uses, so swapping later is config-free).
- For the web-research tools: `npm install` (pulls `playwright-core` + the
  extraction libs — no browser is downloaded) and a system browser, managed
  via Homebrew: `brew install --cask google-chrome`. Verify with
  `npm run web:doctor`. There is no `brew install playwright` formula; only the
  thin `playwright-core` library is an npm dependency.
- Optional: your own `ui-prototyping` and `design-guidelines` skills. Phase 3
  references them by name; if absent, pi-subagents warns and proceeds without
  them (slice-flow ships only the five skills below).

## Install

```bash
pi install /path/to/slice-flow        # user scope
pi install -l /path/to/slice-flow     # or project scope (.pi/settings.json)
```

Skills must be discoverable by pi-subagents' own skill resolution, which reads
installed packages and settings — so install the package rather than loading it
with a one-off `pi -e`.

The six `slice-flow-*` agents ship inside the package under `agents/` (also
declared in `package.json` `pi.agents`). pi's package manager has no "agents"
resource type, so `pi install` does **not** auto-copy them; instead the first
`/feature` provisions them into the project's discovered directory `.pi/agents/`,
copying any that are missing from the bundle (existing copies are left intact, so
local customizations survive). A preflight check then runs before the first phase
and — if the bundle itself is unavailable, i.e. a broken install — fails the
workflow, naming every required agent, so the run stops up front. Upgrade note:
old `.pi/agents/slice-<role>.md` files from prior versions are superseded by the
`slice-flow-<role>.md` files and can be removed.

## Usage

| Command | What it does |
|---|---|
| `/feature <description>` | Starts the workflow (prompt template). |
| `/feature-status` | Shows current phase, slice, loop iteration, token estimate. |
| `/feature-resume` | Continues from persisted state after a restart or `/reload`. |
| `/feature-reflect [judge]` | Proposes rubric-skill edits from real human-override cases (proposals only; nothing auto-applied). |

The parent agent only relays: it calls `slice_flow`, receives a directive with
exact `subagent` arguments, invokes them verbatim, and calls
`slice_flow({"action":"next"})` when the run finishes. It never implements
anything itself — with one exception: during the frame **explore** stage it
becomes the user's framing partner (framing-partner skill) and drives the
`research` / `attack` / `converge` actions, but still writes no project code
and no frame document.

## Observability and self-improvement (cross-run)

Two read-only/proposal-only `slice_flow` actions turn the per-task logs that
already exist into the trust signal that decides whether a gate has earned
`autonomy: "auto"`. Neither changes any gate/judge workflow behavior.

- **`slice_flow({"action":"metrics"})`** — strictly read-only. Aggregates
  across every task under `workDir` (via `listTasks`) and prints a markdown
  report: per gate (`frame`/`architect`/`prototype`/`plan`/`verify`), the
  approve/revise/abort/pause counts and the **override rate**
  `(revise + abort) / total decisions` — the fraction of times a human did not
  accept the judged artifact as-is — plus retry tallies (recompile, re-judge,
  RECONSIDER, replan, fix-up, loop) and per-task token spend. A gate the human
  accepted as-is across many runs is a candidate to flip to `"auto"`; one the
  human keeps overriding is not. Mutates nothing.
- **`slice_flow({"action":"reflect"[,"judge":"plan"]})`** and the
  **`/feature-reflect [judge]`** command — the self-improving loop. It mines
  the human-override cases for a judge (or every judge with a tunable rubric:
  `architect` → `architecture-attack`, `prototype` → `prototype-rubric`,
  `plan` → `plan-rubric`, `verify` → `verify-rubrics`), compiles them into
  `<workDir>/reflect/<judge>-cases.md`, and spawns a fresh-context
  `slice-flow-oracle-judge` (the rubric skill injected, briefs-as-files) that
  proposes unified-diff-style rubric edits with a rationale per edit into
  `<workDir>/reflect/<judge>-proposals.md`. The proposals are written **for
  human review and applied automatically by nothing** — the reflection agent is
  forbidden from editing the skill or any source file, the same way a gate
  earns `"auto"` only through human trust. `frame` has no tunable rubric (it is
  human-pinned), so it is excluded from reflection. When a judge has no override
  cases yet, an empty case file is written and no agent is spawned: a gate earns
  a rubric proposal only once a human has overridden its judge at least once.

## Phase flow

```
/feature <description>
   │
   ▼
PHASE 1  FRAME        five stages:
   │                  INTAKE   cheap scout scores the description; thin input →
   │                           one batch of clarifying questions up front
   │                           (frame/00-intake.md)
   │                  EXPLORE  interactive — the main session is the framing
   │                           partner (framing-partner skill). On demand:
   │                             research: parallel researcher agents with web
   │                               access → frame/research/NNN-*.md (sourced)
   │                             attack: fresh adversaries (wrong-problem,
   │                               simpler-alternative, breaks-existing)
   │                               → frame/attacks/NNN-*.md
   │                           Every decision lands in frame/ledger.md.
   │                  COMPILE  on converge: fresh scout compiles the ledger
   │                           → 01-frame.md (zinsser-framing skill, includes
   │                           testable acceptance criteria)
   │                  VALIDATE code lint (sections, hedge words, criteria) +
   │                           fidelity judge (strong model: doc ≡ ledger?);
   │                           FAIL → recompile, max 2, then surface
   │                  ⏸ GATE   TUI gate: approve / request changes (back to
   │                           EXPLORE with feedback in the ledger) / abort
   ▼
PHASE 2  ARCHITECT    chain: 3 parallel hypothesis agents (minimal-change,
   │                  pattern-aligned, evolvable; Mermaid + components + data
   │                  flow + falsifiers; failFast) → judge (oracle, strong
   │                  model) scores fit/simplicity/repo-fit/reversibility →
   │                  02-architecture.md with a machine-parsed first line
   │                  "WINNER: hypothesis-<id>". The engine validates expects
   │                  (stale files deleted before re-runs) and a structural
   │                  lint (sections + mermaid + scores table); lint failure →
   │                  judge-only re-run over the frozen hypotheses (max 2),
   │                  then the gate shows a warning instead of stopping.
   │                  ⏸ TUI gate (approval persisted before the UI question;
   │                  "Request changes" asks what to revise: re-judge only, or
   │                  regenerate hypotheses too) + UI question (none /
   │                  greenfield / existing)
   ▼
PHASE 3  PLAN         greenfield UI: chain of 5 parallel prototype agents
   │                  (ui-prototyping skill) + judge → prototypes/JUDGEMENT.md,
   │                  then planner. Existing UI: planner + design-guidelines
   │                  skill, no prototyping. Planner writes 03-plan.md (with
   │                  critical-path snippets) and ordered ~100-LOC slice files
   │                  under feature-work/slices/ (001 = smallest working MVP).
   │                  ⏸ TUI gate: approve the slices
   ▼
PHASE 4  IMPLEMENT    per slice, a fresh chain: builder (worker + slice-rules,
   │                  sees ONLY its slice file + prior memos read-only) →
   │                  reviewer (reviewer-solid, fresh context). FAIL verdict →
   │                  scoped fix-up chain (fixer + re-review), capped, before
   │                  the next slice starts.
   ▼
PHASE 5  VERIFY       5 parallel fresh verifiers (strong model), one per
   │                  dimension: code-quality, simplicity, security, evals,
   │                  tests. Each gets the full diff + frame/architecture/plan
   │                  and is instructed to REFUTE. Builders and verifiers are
   │                  always different agent instances. PASS/FAIL findings with
   │                  file/line/reason → feature-work/verify/<dim>.md
   ▼
PHASE 6  LOOP         per FAIL dimension: scoped fix-up agent, then re-run only
   │                  the affected verifiers. Repeats until clean, max 5
   │                  iterations and a configurable token budget; on breach,
   │                  stops and writes feature-work/REPORT.md with remaining
   │                  failures.
   ▼
 DONE
```

## On-disk layout (everything is resumable from here)

```
feature-work/
├── state.json            # full workflow state; no phase uses conversation memory
├── frame/                # phase 1 working tree
│   ├── 00-intake.md      # intake assessment (INTAKE: SUFFICIENT|QUESTIONS)
│   ├── ledger.md         # the decision ledger the partner maintains live
│   ├── research/NNN-*.md # sourced findings from researcher fan-outs
│   ├── attacks/NNN-*.md  # adversary reports per charter
│   └── judgement.md      # fidelity judge verdict on the compiled frame
├── 01-frame.md           # phase 1 output (compiled from the ledger)
├── 02-architecture.md    # phase 2 output (winner + scores + why losers lost)
├── 03-plan.md            # phase 3 output (with critical-path snippets)
├── arch/hypothesis-N.md  # the three competing architectures
├── prototypes/proto-N/   # greenfield UI prototypes + JUDGEMENT.md
├── slices/NNN-slug.md    # ordered slice contracts
├── memos/NNN-slug.md     # builders' post-build memos
├── reviews/NNN-slug-rK.md# per-slice review verdicts (r0 = first review)
├── verify/<dimension>.md # verifier verdicts (overwritten on re-verify)
├── chains/               # pi-subagents chain artifacts per directive
├── logs/                 # full task brief for every spawned agent (NNN-*.md)
│   ├── NNN-directive-*.json  # the exact subagent args issued
│   └── calls/                # every actual subagent tool invocation observed
└── REPORT.md             # written only when phase 6 breaches its limits
```

The cross-run self-improvement action writes beside the task folders, not
inside any one task:

```
feature-work/reflect/      # /feature-reflect output (cross-run; never auto-applied)
├── <judge>-cases.md       # compiled human-override cases mined from every task
├── <judge>-proposals.md   # the reflection agent's proposed rubric diffs (for human review)
├── logs/                  # the reflection agent's brief + directive JSON
└── chains/                # pi-subagents chain artifacts
```

Every spawned agent's full prompt is inspectable: briefs are written to
`logs/` and injected into children via pi-subagents `reads`, so the parent LLM
never retypes (or mutates) a prompt; the short `task` field just points at the
brief.

## Approval gates

Gates use Pi's TUI (`select`/`input` dialogs). "Request changes" re-runs the
phase with your notes appended to the brief. In non-interactive modes (`-p`,
`--mode json`) gates pause the workflow unless `"autoApprove": true` is set.

## Configuration — `slice-flow.json` (in the project root)

All keys optional; defaults shown. Cheap model for discovery and fix-ups,
strong model for architecture judging and verification; `null` inherits the
session's default model.

```json
{
  "workDir": "feature-work",
  "hypothesisCount": 3,
  "planCount": 2,
  "prototypeCount": 3,
  "attackCount": 3,
  "maxCompileRetries": 2,
  "maxArchRejudge": 2,
  "maxArchReconsider": 2,
  "maxPlanRetries": 2,
  "maxPrototypeRetries": 2,
  "maxLoopIterations": 5,
  "maxFixupsPerSlice": 2,
  "loopCostBudget": 30,
  "modelWeights": { "opus": 1, "sonnet": 0.25, "haiku": 0.08, "default": 0.5 },
  "reverifyAllInLoop": true,
  "autoCommit": true,
  "autoApprove": false,
  "gitignoreWorkDir": true,
  "telemetry": { "enabled": false, "flushOnPause": true, "debug": false },
  "autonomy": {
    "frame": "human",
    "architect": "human",
    "prototype": "human",
    "plan": "human",
    "verify": "human"
  },
  "models": {
    "intake": "anthropic/claude-haiku-4-5",
    "research": "anthropic/claude-haiku-4-5",
    "attack": null,
    "compile": null,
    "frameJudge": "anthropic/claude-opus-4-8",
    "hypothesis": "anthropic/claude-opus-4-8",
    "architectJudge": "anthropic/claude-opus-4-8",
    "prototype": "anthropic/claude-haiku-4-5",
    "prototypeJudge": "anthropic/claude-opus-4-8",
    "plan": null,
    "planJudge": "anthropic/claude-opus-4-8",
    "build": null,
    "review": null,
    "fixup": null,
    "verify": "anthropic/claude-opus-4-8",
    "verifyRegression": "anthropic/claude-sonnet-4-6"
  }
}
```

Notes:

- `telemetry` enables real Langfuse tracing (off by default). When `enabled`, it
  also requires `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`
  in the environment, else it stays a no-op. It emits one trace per run (stable
  across `/reload`), one observation per directive carrying real per-agent token
  cost (`subagent` result `usage`), and a gate-decision score per gate — all via
  the ingestion REST API, fail-soft (a dead host never blocks a turn).
- `planCount` (default 2) fans out N independent plan decompositions into
  `plan-<n>/` candidate dirs and promotes the comparatively-judged winner — the
  divergence the architect phase has and plan previously lacked. Set it to `1`
  for the single-planner legacy path.
- `verifyRegression` is the (cheaper) model for the loop's regression-check
  verifiers — dimensions already passing, re-run only to catch a regressed fix.
  The failed dimensions under active repair keep the strong `verify` model.
- `maxArchRejudge` / `maxArchReconsider` split the old single `maxArchitectRetries`
  budget so a run of cheap lint re-judges can never starve the expensive attack
  RECONSIDER full re-run (and vice-versa).
- `autonomy` is the per-gate trust policy on the path to a zero-touch engineer.
  Each gate is `"human"` (ask) or `"auto"` (trust the phase's own judges and
  advance without asking, even with a UI present). Every gate defaults to
  `"human"`; flip them to `"auto"` one at a time as the override data earns it.
  `frame` is pinned to the human and is never auto-approved by this map
  (intent is created there, not verified). `autoApprove` remains a separate
  global fallback: approve gates only when no UI is present.
- The plan, architecture, and prototype each face a dedicated adversary before
  their gate: a plan judge (decomposition soundness), an architecture attack
  panel (wrong-seam / simpler-structure / fights-the-codebase, with
  dispositions written to `02-architecture-attacks.md`), and a refute-stance
  prototype judge. Each judge's rubric lives in its own skill
  (`plan-rubric`, `architecture-attack`, `prototype-rubric`) so it can be
  tuned independently over time.
- `maxPrototypeRetries` bounds the judge-only re-run when the prototype
  judgement fails its lint (missing `WINNER:` marker, or a winner that names a
  directory with no README).
- `loopCostBudget` caps phase-6 spend deterministically in "opus-equivalent
  spawns" rather than tokens: each loop iteration adds one fixer per failed
  dimension plus one verifier per re-verified dimension, each weighted by its
  model tier via `modelWeights` (opus 1, sonnet 0.25, haiku 0.08; unknown/null
  models use `default`). The cost of the next iteration is computed before it is
  spawned, so the loop stops *before* breaching, not after. This counts the work
  slice-flow commissions — the only signal available, since a child agent's real
  token usage is not exposed at the `subagent` tool boundary. (A coarse chars/4
  I/O figure is still recorded for display, but never enforced on.)
- `reverifyAllInLoop: true` (default) re-runs all five verification dimensions
  on every loop iteration, not only the failed ones, so a loop fix that
  regresses a previously-passing dimension cannot reach `done` on a stale PASS.
  Set it `false` to re-verify only the failed dimensions (cheaper, but a
  regression in a passing dimension can slip through). `loopCostBudget`
  defaults to 30 to give this 5×-per-iteration verify cost headroom; the loop
  clears each re-verified dimension's verdict file first, so a verifier that
  fails to write keeps the loop going rather than passing on stale evidence.
- `maxPlanRetries` bounds the automatic replan when the deterministic slice
  lint fails (non-contiguous numbering, missing slice sections, empty
  Scope/Acceptance, or a forward dependency); after the budget the plan is
  surfaced to the human gate with a WARNING.
- `hypothesis` and `fixup` default to the strong tier (hypothesis names Opus
  explicitly because its scout agent is Haiku-pinned; `fixup: null` inherits
  the builder's session default) — architecture seams and correctness fix-ups
  are too high-leverage for the cheapest model.
- `autoCommit: true` makes each slice one commit (`slice NNN: <title>`); the
  baseline commit recorded at `/feature` time scopes the verification diff.
- `gitignoreWorkDir` appends `feature-work/` to `.gitignore` so slice commits
  stay clean.

## How it composes with pi-subagents

- **Sequential phases are chains** (`subagent({ chain: [...] })`), including
  single-step ones, so per-step `reads`/`output`/`skill`/`model` always apply
  and artifacts land under `feature-work/chains/`.
- **Fan-outs use parallel mode**: hypothesis trio and prototype five-way as
  `{ parallel: [...] }` chain groups (judge step follows in the same chain);
  the five verifiers as top-level `tasks: [...]`.
- **slice-flow ships seven dedicated agents** (`slice-flow-scout`,
  `slice-flow-researcher`, `slice-flow-builder`, `slice-flow-oracle-adversary`,
  `slice-flow-oracle-judge`, `slice-flow-planner`, `slice-flow-reviewer`) bundled in `slice-flow/agents/`
  and provisioned into `.pi/agents/` on workflow start, driven with per-call
  `skill`, `reads`, `output` (and `model`) overrides.
- `context: "fresh"` on every call defeats the `fork` default of
  planner/worker/oracle; `clarify: false` keeps pi-subagents' own TUI out of
  the way (slice-flow gates instead).

## Skills shipped

| Skill | Used by | Holds |
|---|---|---|
| `framing-partner` | the main session during frame exploration | partner stance, ledger format, when to research/attack, convergence checklist |
| `zinsser-framing` | phase 1 frame compiler | compiler contract (ledger fidelity), frame doc structure incl. acceptance criteria, Zinsser writing rules |
| `slice-rules` | planner, builders, fix-ups | **your slice contract** (see marker below), slice file format, memo format |
| `reviewer-solid` | phase 4 reviewers | SOLID, DRY, cohesion, domain isolation, docs standards, verdict format |
| `verify-rubrics` | phase 5/6 verifiers | one refutation rubric per dimension |

## Web research tools (`extensions/web-research.ts`)

Playwright-backed, `registerTool`-only (the agent gets **no bash** — the
extension owns the browser). Three tools, matching the dedicated
`slice-flow-researcher` agent's `tools` allowlist, so the frame research fan-out
works out of the box — and only agents whose allowlist names these tools can use
them (builders and verifiers cannot):

| Tool | What it does |
|---|---|
| `web_search` | Multi-query search via a configurable provider (default DuckDuckGo). Returns title/URL/snippet. |
| `fetch_content` | Renders a URL in headless Chrome (handles JS/SPAs) and extracts the main article as Markdown via Readability. |
| `get_search_content` | Search + fetch the readable content of the top N results in one step. |

**Browser engine.** Content is rendered locally with `playwright-core` driving a
**brew-managed Chrome** (`channel: "chrome"`) — no third-party reader proxy, and
no browser binary downloaded by npm. Install the browser with
`brew install --cask google-chrome`, then confirm the whole toolchain:

```bash
npm run web:doctor   # checks libs + launches Chrome + live render + extract
```

**Pluggable search providers.** `web_search` defaults to free DuckDuckGo (the
search form is POSTed, which avoids the GET anomaly/rate-limit bounce). Switch
engines with config — env vars override an optional `~/.pi/web-research.json`,
which overrides built-in defaults:

| Setting | Env var | Config key | Default |
|---|---|---|---|
| Provider | `WEB_SEARCH_PROVIDER` | `provider` | `ddg` |
| Max results | `WEB_SEARCH_MAX_RESULTS` | `maxResults` | `8` (cap 20) |
| Browser channel | `WEB_RESEARCH_BROWSER_CHANNEL` | `browserChannel` | `chrome` |
| Browser path | `WEB_RESEARCH_BROWSER_PATH` | `browserExecutablePath` | _(unset; overrides channel)_ |
| Headless | `WEB_RESEARCH_HEADLESS` | `headless` | `true` |
| Perplexity key | `PERPLEXITY_API_KEY` | `perplexityApiKey` | — |
| Google CSE | `GOOGLE_API_KEY` / `GOOGLE_SEARCH_CX` | `googleApiKey` / `googleCx` | — |

Built-in providers: `ddg` (free, no key), `perplexity` (needs key), `google`
(needs API key + CSE id). Add more by registering them in
`extensions/lib/web-research/providers.ts`. Keys are read from env/config only —
never hardcoded.

```jsonc
// ~/.pi/web-research.json — example: use Perplexity
{ "provider": "perplexity", "perplexityApiKey": "pplx-..." }
```

**Security.** SSRF guard blocks private / loopback / link-local / CGNAT /
cloud-metadata hosts (and DNS-rebinding at connect time); non-`http(s)` schemes,
downloads, and heavy resources (images/media/fonts) are blocked; each call uses
an ephemeral browser context with no persistent profile or stored credentials.

Failures are loud by design: a challenged search or blocked page returns an
explicit error so researchers record "source unavailable" instead of
improvising from memory. See [TECH-DEBT.md](TECH-DEBT.md) (DEBT-001) for the
one-browser-per-process memory note under large fan-outs.

> **Action item:** `skills/slice-rules/SKILL.md` contains a
> `BEGIN OWNER RULES … END OWNER RULES` block reconstructed from your spec.
> Replace it with your verbatim rules block.

## Code layout

The extension is split by responsibility; each module has one reason to change:

| Module | Owns | Edit it when… |
|---|---|---|
| `extensions/slice-flow.ts` | composition root: tool, hooks, slash commands | you add a command or hook |
| `extensions/web-research.ts` | registers `web_search` / `fetch_content` / `get_search_content` (entry only) | you add/rename a research tool |
| `extensions/lib/web-research/` | Playwright browser, SSRF guard, pluggable search providers, extraction, config | you change search/fetch backends or providers |
| `extensions/lib/config.ts` | defaults + `slice-flow.json` overlay | you add a knob |
| `extensions/lib/workspace.ts` | state, paths, all `feature-work/` IO | the on-disk contract changes |
| `extensions/lib/briefs.ts` | every spawned agent's prompt text (pure strings) | you want agents briefed differently |
| `extensions/lib/directives.ts` | exact `subagent` args; fresh/clarify/chainDir envelope | the pi-subagents call shape changes |
| `extensions/lib/gates.ts` | TUI approval gates (narrow `GateContext`) | the approval UX changes |
| `extensions/lib/metrics.ts` | pure cross-run analysis: per-gate override rates, retries, token spend | you change the observability report |
| `extensions/lib/engine.ts` | the phase state machine + cross-run reflect entry point | phase order/transitions change |

`npm run check` typechecks against a locally installed pi-coding-agent
(adjust the absolute paths in `tsconfig.check.json` for your machine).

## Testing

See [TEST-PLAN.md](TEST-PLAN.md) for a step-by-step plan you can run on a toy
repo, including failure-injection and resume tests.
