# slice-flow `init` & Per-Project Context — Research + Design Brainstorm

> Goal: understand how Pi ("PI") feeds project context to agents, how `AGENTS.md` /
> `CLAUDE.md` reach slice-flow's fresh-context subagents, and design a
> `slice-flow init` command that captures a project's specifics once and feeds
> them into every phase — including the new risk-taxonomy / check-pack surfaces.

---

## 1. How Pi project context actually works

Pi (the `@earendil-works/pi-coding-agent`) has a built-in **context-file** mechanism,
verified against the installed pi-mono source (`packages/coding-agent/README.md:319`,
`docs/usage.md:96`):

- At startup Pi loads **`AGENTS.md` (or `CLAUDE.md`)** from three locations and
  **concatenates all matches**:
  1. `~/.pi/agent/AGENTS.md` — global
  2. every parent directory, walking up from cwd
  3. the current directory
- The concatenated text is injected as **project instructions** into the system prompt.
- `loadProjectContextFiles()` is an **exported utility** — an extension can call it to
  inspect the exact same resolution order the CLI uses (CHANGELOG #3142/#3253).
- `--no-context-files` / `-nc` disables discovery; `/reload` hot-reloads it.
- Adjacent knobs: `.pi/SYSTEM.md` **replaces** the system prompt; `APPEND_SYSTEM.md`
  **appends** to it. (Both are heavier hammers than `AGENTS.md`.)

So `AGENTS.md`/`CLAUDE.md` is **the** sanctioned, human-authored, durable,
project-specific context channel in Pi. It is not slice-flow-specific — it is whatever
the human wrote for general Pi use in that repo.

## 2. How context reaches slice-flow's *fresh* subagents today

slice-flow's load-bearing invariant is **fresh context** (`context: "fresh"`,
`clarify: false`, `systemPromptMode: replace`): every scout/judge/builder/verifier is a
brand-new Pi instance with no parent history. That independence is the whole point — but
it also means a fresh agent is **blind to everything not in its brief, its injected
skill, or an inherited context file.** There are exactly **two** channels that carry
per-project truth across that fresh-context boundary:

### Channel A — `inheritProjectContext: true` → `AGENTS.md` / `CLAUDE.md`
All seven `slice-flow-*` agents set `inheritProjectContext: true` (and
`inheritSkills: false`). Per pi-subagents (`README.md:408`): *"Keep inherited project
instructions from files like AGENTS.md and CLAUDE.md."* This is the **only** channel that
reaches **every phase** regardless of brief. It is the highest-leverage, lowest-plumbing
surface slice-flow already depends on — and today it carries only whatever generic
`AGENTS.md` the human happened to write, **not** anything slice-flow-aware.

### Channel B — brief-embedded project profile (already partially built!)
`briefs.ts` already injects **machine-detected** project profile into some briefs:
- `riskCoverageClause(liveAxes)` (`briefs.ts:292`) embeds **this project's live risk
  axes** (from the check-pack `manifest.json`) directly into the PLAN-select and
  PLAN-judge briefs, so the planner/judge reason about tenancy/authz/etc. at decompose
  time. This is real, shipping, per-project context flowing into a fresh agent.
- `provisionCheckPack` (`engine.ts:136`) + `stackPreamble` + `codegraphPreamble` produce
  one-line **startup notices** — but those ride the `issue()`/`exploreMessage()`
  `preamble`, which is shown to the **parent relay**, not embedded in the subagent brief.
  They inform orchestration; they are *not* a robust subagent-context channel.

### The gap
Everything else a fresh agent needs to be *correct for this project* — domain
vocabulary, architectural invariants, the tenant model, naming/test conventions,
preferred libraries, "what "done" means here", banned patterns, the OWNER'S RULES of
`risk-taxonomy` / `slice-rules` — is today either:
- **(a)** re-discovered from scratch on every fresh run (slow, lossy, non-deterministic), or
- **(b)** sitting in a generic `AGENTS.md` not tuned for the pipeline, or
- **(c)** hand-edited one knob at a time into skill OWNER RULES + the check-pack manifest.

There is **no single guided step** that captures a project's specifics once and routes
them into both channels. That is exactly the hole `slice-flow init` fills.

## 3. Core insight

> slice-flow already has the *plumbing* for per-project context (Channel A is wired into
> every agent; Channel B already carries live risk axes into PLAN). What's missing is an
> **authoring step** that populates those channels deliberately, and keeps the
> human-editable surfaces (manifest params, OWNER RULES) in sync — instead of leaving
> each as a separate manual chore.

`slice-flow init` is that authoring step. It is the natural sibling of `provisionCheckPack`:
provisioning already *detects* the stack and asks one confirm; `init` generalizes that to
*capture the whole project profile* and write it where agents read it.

## 4. `slice-flow init` — design

### 4.1 Goal
One command (`/feature-init`, or `slice_flow` action `init`) that, in a single guided
pass, produces a durable **project profile** that flows into both context channels and
seeds every human-editable surface — non-destructively and idempotently.

> **Context-economy decision (supersedes an earlier draft that put the profile in
> `AGENTS.md`).** `AGENTS.md`/`CLAUDE.md` are **always-on and tool-shared** — Pi, Claude
> Code, and Codex each load them into *every* interactive session. Putting a slice-flow
> profile there taxes every non-slice-flow session of every tool the developer switches
> between, and pollutes the human-facing file with pipeline internals (live axes, OWNER
> RULES, slice budgets). So slice-flow's operational profile lives in a **dedicated
> slice-flow-owned file injected via briefs (Channel B)** — zero cost when the pipeline
> isn't running, phase-scopable, and identical regardless of which interactive harness the
> dev uses. `AGENTS.md` stays the shared *general* file; `init` may *offer* to improve it
> but never owns a managed block there.

### 4.2 What it produces (one pass, four artifacts)
1. **A dedicated `.slice-flow/PROJECT.md`** (Channel B — the prose sibling of the
   structured `manifest.json`, both under `.slice-flow/`). Human-authored project truths
   that fresh agents need but can't see: domain & vocabulary, architectural invariants /
   seams not to cross, tenant / auth model, conventions (naming, test command, error
   handling, logging), preferred libraries / banned patterns, repo definition-of-done.
   - **Injection:** a new `projectProfileClause(section)` (generalizing the shipping
     `riskCoverageClause`) embeds the relevant **section** into each phase's brief —
     invariants → architect, conventions → builder/reviewer, axes → plan — so each agent
     pays only for the slice it needs, and **non-slice-flow sessions pay nothing**.
   - **Not** `AGENTS.md`: keep `inheritProjectContext: true` so agents still free-ride on
     whatever *general* context the human maintains there, but stop adding slice-flow
     weight to an always-on, tool-shared file.
   - Idempotent via marker-delimited sections + the manifest's preserve-human-edits rule.
2. **A populated, confirmed check-pack `manifest.json`** (Channel B). `init` runs
   `detectStack` → `buildManifest`, then **interviews for the human-fillable holes**
   (tenant-predicate `labels`, banned-tokens `tokens`, guarded globs) so Tier-B checks
   stop being "pending/quarantined", and flips `confirmed: true` — exactly what today
   requires a manual one-off edit. The live axes then flow into PLAN briefs via the
   already-shipping `riskCoverageClause`.
3. **Seeded OWNER'S RULES blocks** in `risk-taxonomy` and `slice-rules` SKILL.md — the
   project's threat-model axes and tuned LOC budget / memo format — pre-filled from the
   interview instead of left as TODO comments. (Keeps the `RiskAxis` enum ↔ taxonomy
   skill ↔ manifest **in sync**, which the README already flags as a manual hazard.)
4. **A codegraph nudge** — if the codegraph CLI is present but unindexed, `init` is the
   right moment to prompt `codegraph init` (today only a passive `codegraphPreamble` line).

### 4.3 Flow
```
slice-flow init
  ├─ detectStack(cwd)                      → signals, live axes, candidate Tier-B checks
  ├─ scan repo (scout, read-only)          → propose: domain, conventions, test cmd,
  │                                           invariants, banned patterns  (DRAFT)
  ├─ read existing AGENTS.md/CLAUDE.md      → diff against draft, never duplicate
  ├─ interactive confirm (the ONE human gate)
  │     • approve / edit each profile field
  │     • fill manifest holes (tenant labels, banned tokens, globs)
  │     • confirm the risk profile (reuses askCheckPackConfirm)
  └─ write (idempotent, non-clobbering):
        AGENTS.md managed block · manifest.json (confirmed) ·
        OWNER RULES seeds · codegraph nudge
```
Unattended mode (`-p`): draft from repo only, write the managed block + an
**unconfirmed** manifest (checks stay quarantined until a human confirms) — never
auto-confirm a security profile, matching `provisionCheckPack`'s existing rule.

### 4.4 Why this is low-risk to build
- Reuses `detectStack` / `buildManifest` / `askCheckPackConfirm` / the OWNER RULES
  convention — almost no new primitives.
- The injection path is a generalization of the **already-shipping** `riskCoverageClause`
  brief embedding — not a brand-new channel.
- Idempotency model already proven by `buildManifest` (preserve human edits, re-detect
  safely).

## 5. Broader per-project-context improvements (ranked by leverage/effort)

| # | Improvement | Why | Effort |
|---|---|---|---|
| 1 | **`slice-flow init`** (§4) | Single authoring step for the slice-flow profile + manifest + OWNER RULES; unifies 3 manual chores | M |
| 2 | **`projectProfileClause(section)`** generalizing `riskCoverageClause` — embeds `.slice-flow/PROJECT.md` **per phase** (invariants → architect, conventions → builder/reviewer, axes → plan) | Run-time-only, phase-scoped context; zero tax on non-slice-flow sessions of any tool | M |
| 3 | **`init`-seeded intake** — feed the profile into `intakeBrief` so triage questions are project-aware ("you said tenancy matters; does this touch tenant data?") | Sharper frame, fewer rounds | S |
| 4 | **`/feature-reflect`-style profile drift detector** — mine completed runs for facts agents had to rediscover, propose `PROJECT.md` additions (never auto-apply), mirroring pi-mono's own `session-transcripts.ts` AGENTS.md-miner | Self-improving project context, same governance as rubric reflection | L |
| 5 | **Per-project skill overrides via `init`** — let init scaffold a project-local `.pi/skills/*` override for a rubric (e.g. stricter security verify) | Project-specific judgment without forking the package | M |
| 6 | **Codegraph auto-init prompt inside `init`** | Structural recon is the cheapest correctness multiplier; today it's passive | S |
| 7 | **Optional: `init` offers to improve the *general* `AGENTS.md`** with genuinely cross-tool truths (domain, test cmd) — author there only what *every* tool benefits from | Keeps general context useful without dumping pipeline internals into an always-on file | S |

## 6. Phased implementation plan

- **Phase 1 — slice-flow file + brief injection (ship first).** `init` writes
  `.slice-flow/PROJECT.md` from a repo scan + one confirm; add `projectProfileClause` and
  wire it into the architect/build/review briefs (generalizing `riskCoverageClause`).
  Immediate lift, **and zero context cost outside slice-flow runs.** (#1 partial, #2, #6.)
- **Phase 2 — Check-pack/taxonomy unification.** `init` populates + confirms
  `manifest.json` holes and seeds OWNER RULES, keeping enum↔skill↔manifest in sync.
  (#1 complete.)
- **Phase 3 — Intake awareness & general-AGENTS.md offer.** Profile into `intakeBrief`;
  optional cross-tool truths into `AGENTS.md`. (#3, #7.)
- **Phase 4 — Self-improving profile.** Drift detector proposes `PROJECT.md` diffs from
  run history. (#4, #5.)

## 7. Open decisions (recommendation in **bold**)

1. **Where does the profile live?** → **A dedicated `.slice-flow/PROJECT.md`, injected
   into briefs (Channel B)** — *not* an `AGENTS.md` managed block. Rationale: `AGENTS.md`/
   `CLAUDE.md` are always-on and shared across Pi / Claude Code / Codex, so a profile there
   taxes *every* session of *every* tool even when slice-flow isn't running, and pollutes
   the human-facing file with pipeline internals. A slice-flow-owned file costs tokens
   **only during runs**, is **phase-scopable**, and is **harness-agnostic** for developers
   who switch tools. Keep `inheritProjectContext: true` so agents still inherit any
   *general* `AGENTS.md` the human maintains.
2. **Command surface?** → **`/feature-init` prompt + `slice_flow` action `init`**, plus
   auto-offer it on the **first `/feature`** when no `PROJECT.md` exists (like first-run
   agent provisioning).
3. **Interactive vs. fully auto?** → **interactive with one confirm gate**; unattended
   drafts but never auto-confirms the security profile (matches `provisionCheckPack`).
4. **Idempotency?** → **marker-delimited sections in `PROJECT.md` + the manifest's
   existing preserve-human-edits rule.** Re-running `init` refreshes detection, never
   clobbers prose.

---

### TL;DR
Pi loads `AGENTS.md`/`CLAUDE.md` into **every** session of **every** tool (Pi, Claude
Code, Codex) — always-on and shared — so it's the wrong home for slice-flow's profile:
context window is gold and non-slice-flow sessions shouldn't pay for it. slice-flow already
pipes machine-detected risk axes into PLAN briefs via `riskCoverageClause`. So the profile
belongs in a **dedicated `.slice-flow/PROJECT.md` injected per-phase via briefs (Channel
B)** — run-time-only, phase-scoped, harness-agnostic. `slice-flow init` is the authoring
step: it writes that file, **confirms and fills** the check-pack manifest, and **seeds**
the risk-taxonomy / slice-rules OWNER RULES — reusing stack-detection and
preserve-human-edits machinery that already ships. `AGENTS.md` stays the shared *general*
file; `init` may offer to improve it but never owns a block there.
