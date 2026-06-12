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
runs on. The package ships its own free web tools (`extensions/web-research.ts`,
no API keys) so the research fan-out works out of the box.

## Requirements

- `pi-subagents` installed (`pi install npm:pi-subagents`) — slice-flow issues
  `subagent` tool calls; it never spawns processes itself. Its builtin
  `researcher` agent picks up this package's `web_search`/`fetch_content`
  tools automatically (same names pi-web-access uses, so swapping later is
  config-free).
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

## Usage

| Command | What it does |
|---|---|
| `/feature <description>` | Starts the workflow (prompt template). |
| `/feature-status` | Shows current phase, slice, loop iteration, token estimate. |
| `/feature-resume` | Continues from persisted state after a restart or `/reload`. |

The parent agent only relays: it calls `slice_flow`, receives a directive with
exact `subagent` arguments, invokes them verbatim, and calls
`slice_flow({"action":"next"})` when the run finishes. It never implements
anything itself — with one exception: during the frame **explore** stage it
becomes the user's framing partner (framing-partner skill) and drives the
`research` / `attack` / `converge` actions, but still writes no project code
and no frame document.

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
   │                  flow + falsifiers) → judge (oracle, strong model) scores
   │                  fit/simplicity/repo-fit/reversibility → 02-architecture.md
   │                  ⏸ TUI gate + UI question (none / greenfield / existing)
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
  "prototypeCount": 5,
  "attackCount": 3,
  "maxCompileRetries": 2,
  "maxLoopIterations": 5,
  "maxFixupsPerSlice": 2,
  "loopTokenBudget": 1500000,
  "autoCommit": true,
  "autoApprove": false,
  "gitignoreWorkDir": true,
  "models": {
    "intake": "anthropic/claude-haiku-4-5",
    "research": "anthropic/claude-haiku-4-5",
    "attack": null,
    "compile": null,
    "frameJudge": "anthropic/claude-opus-4-8",
    "hypothesis": "anthropic/claude-haiku-4-5",
    "architectJudge": "anthropic/claude-opus-4-8",
    "prototype": "anthropic/claude-haiku-4-5",
    "prototypeJudge": "anthropic/claude-opus-4-8",
    "plan": null,
    "build": null,
    "review": null,
    "fixup": "anthropic/claude-haiku-4-5",
    "verify": "anthropic/claude-opus-4-8"
  }
}
```

Notes:

- `loopTokenBudget` is enforced best-effort: token use is estimated
  (chars/4) from observed `subagent` tool IO, counted from the moment phase 6
  starts.
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
- **Builtin agents are reused** (`scout`, `planner`, `worker`, `reviewer`,
  `oracle`) with per-call `skill`, `model`, `reads`, `output` overrides — no
  custom agent definitions to maintain.
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

Free, no API keys, no bash: `web_search` (DuckDuckGo HTML endpoint, multi-query)
and `fetch_content` (Jina Reader with a direct-fetch fallback, truncated). Tool
names match pi-subagents' builtin `researcher` agent allowlist, so the frame
research fan-out works with zero custom agent definitions — and only agents
whose allowlist names these tools can use them (builders and verifiers cannot).
Failures are loud by design: a rate-limited search or blocked page returns an
explicit error so researchers record "source unavailable" instead of
improvising from memory.

> **Action item:** `skills/slice-rules/SKILL.md` contains a
> `BEGIN OWNER RULES … END OWNER RULES` block reconstructed from your spec.
> Replace it with your verbatim rules block.

## Code layout

The extension is split by responsibility; each module has one reason to change:

| Module | Owns | Edit it when… |
|---|---|---|
| `extensions/slice-flow.ts` | composition root: tool, hooks, slash commands | you add a command or hook |
| `extensions/web-research.ts` | standalone `web_search` + `fetch_content` tools | you change search/fetch backends |
| `extensions/lib/config.ts` | defaults + `slice-flow.json` overlay | you add a knob |
| `extensions/lib/workspace.ts` | state, paths, all `feature-work/` IO | the on-disk contract changes |
| `extensions/lib/briefs.ts` | every spawned agent's prompt text (pure strings) | you want agents briefed differently |
| `extensions/lib/directives.ts` | exact `subagent` args; fresh/clarify/chainDir envelope | the pi-subagents call shape changes |
| `extensions/lib/gates.ts` | TUI approval gates (narrow `GateContext`) | the approval UX changes |
| `extensions/lib/engine.ts` | the phase state machine | phase order/transitions change |

`npm run check` typechecks against a locally installed pi-coding-agent
(adjust the absolute paths in `tsconfig.check.json` for your machine).

## Testing

See [TEST-PLAN.md](TEST-PLAN.md) for a step-by-step plan you can run on a toy
repo, including failure-injection and resume tests.
