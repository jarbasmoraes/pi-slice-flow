---
name: plan-rubric
description: The rubric the slice-flow plan judge applies — the dimensions of decomposition soundness it must refute, and the required VERDICT format. Use when judging a plan and its slice files against the frame and the winning architecture. This is the tunable surface; edit it to sharpen the judge over time.
---

# Plan Rubric

You judge one artifact: the **decomposition** — the plan document plus its slice files. You do not judge code quality, value, or UI; those belong to other phases. You judge whether this set of slices is a sound, buildable path from the frame and the winning architecture to the finished feature.

Your stance is refutation. Start from "this decomposition is wrong" and try to prove it with evidence from the frame, the architecture, and the slice files. A PASS is earned only when honest refutation comes up empty.

List and read every slice file under the slices directory before judging. Deterministic structure (numbering, required sections, forward-dependency syntax) is already linted; do not re-report it. Judge the semantics below.

## Dimensions to refute

1. **Coverage.** Every numbered frame acceptance criterion is satisfied by at least one slice's acceptance criteria. Name any frame criterion that no slice covers.
2. **No scope inflation.** Every slice scope item traces to a frame requirement or the winning architecture. Flag any slice that invents behavior nobody asked for.
3. **Sequencing.** Each prefix of slices (001..00k) leaves the system working and the build green. Flag any slice that needs something only a later slice builds.
4. **MVP integrity.** Slice 001 is a thin but working end-to-end skeleton of the feature, not scaffolding that runs nothing.
5. **Sizing realism.** Each slice is plausibly close to the ~100-line budget. Flag a slice whose scope plainly needs far more.
6. **Architecture fidelity.** The slices realize the winning architecture's components and seams. Flag any slice that contradicts it.
7. **Self-sufficiency.** Each slice is implementable from itself plus prior memos alone. Flag a slice that leans on the plan document or context a fresh builder will not have.

## Severity

- **blocker** — a coverage gap, a slice that breaks the build mid-sequence, or slice 001 that does not run.
- **major** — scope inflation, architecture infidelity, a self-sufficiency breach, or implausible sizing.
- **minor** — wording or ordering smells that do not threaten the build.

## Output format (binding)

The very first line of your answer is exactly `VERDICT: PASS` or `VERDICT: FAIL`.

- FAIL if there is at least one blocker or major finding; PASS otherwise (minors allowed).
- After the verdict, list each finding: the slice id (or "plan"), the dimension, the evidence (quote the slice or the frame criterion), and the smallest change that resolves it.
- Findings must be evidence-backed. Name the slice and the frame/architecture element. No vibes.
