# slice-flow test plan (toy repo)

Each test states what to do and what must be true afterward. Run them in
order; later tests reuse the toy repo.

## 0. Setup

```bash
mkdir -p /tmp/slice-flow-toy && cd /tmp/slice-flow-toy
git init -q
cat > greet.js <<'EOF'
#!/usr/bin/env node
const name = process.argv[2] ?? "world";
console.log(`hello, ${name}`);
EOF
cat > greet.test.js <<'EOF'
const { execSync } = require("node:child_process");
const out = execSync("node greet.js pi").toString().trim();
if (out !== "hello, pi") { throw new Error(`unexpected: ${out}`); }
console.log("ok");
EOF
printf '{ "name": "toy", "scripts": { "test": "node greet.test.js" } }\n' > package.json
git add -A && git commit -qm "toy baseline"

pi install npm:pi-subagents          # if not already installed
pi install /path/to/slice-flow
pi
```

**Check:** inside pi, `/feature`, `/feature-status`, and `/feature-resume`
appear in slash autocomplete, and the `slice_flow` tool loads without errors
on startup.

## 1. Smoke: cheap-model config

Create `slice-flow.json` in the toy repo so the whole run uses a cheap model
(keeps the test fast and inexpensive):

```json
{
  "models": {
    "attack": "anthropic/claude-haiku-4-5",
    "compile": "anthropic/claude-haiku-4-5",
    "frameJudge": "anthropic/claude-haiku-4-5",
    "architectJudge": "anthropic/claude-haiku-4-5",
    "prototypeJudge": "anthropic/claude-haiku-4-5",
    "plan": "anthropic/claude-haiku-4-5",
    "build": "anthropic/claude-haiku-4-5",
    "review": "anthropic/claude-haiku-4-5",
    "verify": "anthropic/claude-haiku-4-5"
  }
}
```

**Check:** after phase 2 runs, `feature-work/logs/*-directive-architect.json`
shows `"model": "anthropic/claude-haiku-4-5"` on the judge step — proving the
per-phase model config is honored.

## 2. Phase 1 — frame v2 (intake → explore → compile → gate)

In pi:

```
/feature add a --shout flag to greet.js that uppercases the greeting, with tests
```

**2a. Intake.** The parent calls `slice_flow` then `subagent` with a chain whose
only step is `agent: "scout"` with `context: "fresh"` (inspect
`feature-work/logs/001-directive-intake.json` and `logs/calls/`). After it,
`feature-work/frame/00-intake.md` exists with a first line
`INTAKE: SUFFICIENT` or `INTAKE: QUESTIONS`, and `state.json` has
`"frameStage": "explore"`. `.gitignore` now contains `feature-work/`.

**2b. Explore.** The parent now behaves as the framing partner: it asks the
intake questions (when present) and converses instead of issuing directives.
Verify it writes `feature-work/frame/ledger.md` as you talk.

**2c. Research.** Say "research how other CLIs name shout/uppercase flags".
**Check:** the parent calls `slice_flow({"action":"research", ...})`, the
directive fans out `agent: "researcher"` tasks, and sourced findings land in
`feature-work/frame/research/NNN-*.md`; the partner summarizes them with
sources and records conclusions in the ledger. (This exercises the package's
own `web_search`/`fetch_content` tools — no API keys.)

**2d. Attack.** Say "attack this framing". **Check:** three `agent: "oracle"`
tasks run (wrong-problem, simpler-alternative, breaks-existing), reports land
in `feature-work/frame/attacks/`, and the partner walks you through the
objections, recording dispositions in the ledger.

**2e. Converge guard.** Before any ledger exists (fresh run), "converge"
must be refused with a message about the empty ledger.

**2f. Compile + validate.** Say you are satisfied; the partner calls
`converge`. **Check:** a two-step chain runs (scout compiler with
`skill: "zinsser-framing"`, then oracle fidelity judge), producing
`01-frame.md` (with `## Acceptance criteria`, `## Out of scope`,
`## Open questions`) and `frame/judgement.md` starting `VERDICT: PASS`.
If the compile is bad (hedge words / missing sections), a recompile is issued
automatically (max 2 — watch for "retry 1/2" in the response).

**2g. Gate.** A TUI select appears ("approve the frame?"). Choose **Request
changes**, type "mention greet.test.js in the current-behavior section".
**Check:** your note is appended to `frame/ledger.md` under "Gate feedback"
and the workflow returns to explore (no recompile directive yet). Work the
feedback, converge again, then approve.

## 3. Phase 2 — architecture fan-out + judge

**Check, at the pause:**

- `feature-work/arch/hypothesis-{1,2,3}.md` all exist; each contains a
  ` ```mermaid ` block, components, data flow, and a falsification section.
- `feature-work/02-architecture.md` names a winner, has a score table
  (fit/simplicity/repo-patterns/reversibility), and a "why the losers lost"
  section.
- The directive JSON shows one chain with a `parallel` group of 3 followed by
  an `oracle` judge step.

Approve. **Check:** the UI question appears; answer **No UI** (this feature is
a CLI flag).

## 4. Phase 3 — plan + slices gate

**Check, at the pause:**

- `feature-work/03-plan.md` exists and contains at least one code snippet.
- `feature-work/slices/` contains ordered `NNN-*.md` files (toy feature: expect
  1–3); `001-*` describes a working MVP (flag parsed, greeting uppercased,
  test added); each slice file has Objective / Scope / Out of scope /
  Acceptance criteria.

Approve the slices.

## 5. Phase 4 — build + review per slice

Let it run. **Check after each slice:**

- One commit per slice: `git log --oneline` shows `slice 001: ...` (etc.),
  and `git status` is clean.
- `feature-work/memos/001-*.md` lists changed files + commit hash.
- `feature-work/reviews/001-*-r0.md` starts with `VERDICT: PASS` or
  `VERDICT: FAIL`; on FAIL, a fix-up chain runs (directive kind `fixup`)
  **before** the next slice starts, and a `-r1.md` review appears.
- The build directive's `reads` contains ONLY the brief, the slice file, and
  prior memos — not the plan or frame (slice-is-the-contract check).

## 6. Phase 5 — verification fan-out

**Check:**

- The directive is top-level `tasks: [...]` with 5 entries (one per
  dimension), `skill: "verify-rubrics"`, `context: "fresh"`.
- `feature-work/verify/` gains `code-quality.md`, `simplicity.md`,
  `security.md`, `evals.md`, `tests.md`, each starting with a `VERDICT:` line;
  findings include file/line/reason.
- `node greet.js pi --shout` prints `HELLO, PI` and `npm test` passes — the
  evals/tests verifiers should have actually run these (their reports cite
  commands).

## 7. Phase 6 — loop on FAIL (injected failure)

If everything passed in step 6, inject a failure: edit
`feature-work/verify/tests.md` so its first line is `VERDICT: FAIL` and add a
finding (e.g. `greet.test.js:1 — major — no test covers --shout with a name
argument`). Then in pi: `ask slice_flow for next` (or just let the agent call
`next`).

**Check:**

- A loop directive is issued: chain = one `worker` fix step for `tests`
  followed by a `parallel` group re-running ONLY the `tests` verifier (not the
  other four).
- `state.json` shows `"phase": "loop"`, `loopIteration: 1`.
- After a clean re-verify, the workflow reports COMPLETE.

## 8. Resumability

Start a second feature (`git commit` anything pending first, delete
`feature-work/`): `/feature add a --repeat N flag`. Approve the frame, then
**kill pi** (Ctrl+C twice) mid-phase-2. Restart `pi` in the same directory.

**Check:**

- `/feature-status` shows the persisted phase from disk.
- `/feature-resume` sends the resume message; the agent calls
  `slice_flow({"action":"next"})`; because phase-2 artifacts are missing, the
  SAME architect directive is re-issued (compare seq/brief files in `logs/`).
- `/reload` mid-workflow followed by `/feature-resume` behaves identically
  (state is on disk, not in memory).

## 9. Limits and report

With the second feature still mid-loop (or by re-injecting FAIL verdicts
repeatedly as in step 7), set `"maxLoopIterations": 1` in `slice-flow.json`
and force a second loop iteration.

**Check:** the workflow STOPS, `feature-work/REPORT.md` exists and embeds the
remaining FAIL dimension reports, and `/feature-status` shows
`phase: stopped`.

## 10. Non-interactive guard

```bash
cd /tmp/slice-flow-toy && rm -rf feature-work
pi -p 'Start the slice-flow workflow: call slice_flow({"action":"start","description":"add --version flag"}), run the subagent call it returns, then call slice_flow({"action":"next"})'
```

**Check:** with no user to converse with, the agent self-explores (writes
`frame/ledger.md` from the description and code, runs one attack round,
converges), and the run pauses at the frame gate with the PAUSED message (no
silent auto-approval). Then set `"autoApprove": true` in `slice-flow.json`,
re-run, and confirm the gate is skipped (UI question defaults to "none").

## 11. Double-start guard

In an interactive session with an active workflow, type `/feature something
else`. **Check:** `slice_flow` errors with "already active" and points to
`/feature-resume` / abort / deleting `feature-work/`.
