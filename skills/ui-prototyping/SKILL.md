---
name: ui-prototyping
description: How a slice-flow builder makes one self-contained, runnable UI prototype during the greenfield prototype fan-out — a distinct direction, zero-build artifacts, and a README the judge and planner can read. Use when building a UI prototype in the prototype phase.
---

# UI Prototyping

You are building ONE prototype of a feature's UI so a human and a judge can compare directions before the real UI is planned. A prototype is a throwaway argument for a direction, not production code. Make it runnable, make it distinct, and make its intent legible.

## Stance (binding)

1. **Take a real position.** Your prototype is one answer, not a hedge. Commit to a layout, an interaction model, and a visual tone. A prototype that tries to be every option is worthless to the judge.
2. **Be distinct.** You are one of several. Choose a direction the others are unlikely to choose; do not converge on the obvious default.
3. **Serve the frame.** The direction must let the user do what the frame says they need to do. Style serves the task, not the reverse.
4. **Throwaway, not sloppy.** The code is disposable, but the demo must run and the main flow must work end to end.

## Hard rules

- Write ONLY inside your assigned prototype directory. Never touch project source files.
- Favor zero-build artifacts: a single self-contained HTML file, or the project's existing dev stack mirrored locally, so the reviewer opens it instantly.
- Use real, representative content and state, not lorem ipsum, so the direction can be judged honestly.
- Show the primary user journey working, plus the obvious second state (empty, error, or loading).
- No backend, no real data, no secrets. Stub data inline.

## Required README.md

Every prototype directory carries a `README.md` precise enough that a planner who never opens the prototype can specify the real UI from it:

```markdown
# Prototype <n>: <direction in a few words>

## Direction
- <one sentence: the stylistic and structural bet this prototype makes>

## How to run
- <exact command or "open index.html">

## What it shows
- <the user journey demonstrated, and which frame acceptance criteria it exercises>

## Trade-offs
- <one sentence on what this direction is good at, one on what it gives up>
```

## Quality bar

- A reviewer opens the README, runs the prototype in under a minute, and understands the direction without reading the code.
- The primary flow works; clicking the main path does not dead-end.
- The direction is recognizably different from a plain default scaffold.
