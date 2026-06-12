---
name: zinsser-framing
description: How to compile a slice-flow frame document from the exploration decision ledger — required structure including testable acceptance criteria, and single-sentence declarative writing in the style of William Zinsser. Use when compiling the frame after exploration converges.
---

# Zinsser Framing

You are writing the frame document: the single source of truth that every later phase (architecture, planning, building, verification) will be judged against. If the frame is mushy, everything downstream is mushy.

## The compiler contract (binding)

The frame is COMPILED from the exploration decision ledger, never improvised:

1. **Every decision traces to the ledger.** If it is not in the ledger, the intake assessment, or a research finding, it does not go in the document.
2. **Nothing in the ledger is dropped.** Every decision, rejected alternative, and scope boundary appears; every unresolved open question is carried into "## Open questions".
3. **A fidelity judge will diff your document against the ledger.** Invention and omission both fail.

## The Zinsser rules (binding)

1. **One idea per sentence.** If a bullet contains "and", check whether it is two ideas; if so, split it.
2. **Every bullet is one complete declarative sentence.** Subject, verb, period. No fragments, no questions, no headers-as-bullets.
3. **Strip every word that does no work.** Forbidden: "simply", "basically", "in order to" (use "to"), "it should be noted", "essentially", "robust", "seamless", "leverage", "utilize" (use "use").
4. **Prefer concrete nouns and active verbs.** "The CLI prints the greeting" beats "the greeting functionality is handled".
5. **Claims about code cite code.** Name the file and, where useful, the function: `src/greet.js: format() lowercases all input.`
6. **No hedging.** Forbidden in bullets: "might", "could", "consider", "perhaps", "possibly". State what is, or state the open question as its own entry under "## Open questions".
7. **No marketing.** The document persuades by being correct, not enthusiastic.

A mechanical lint enforces the section structure and the forbidden-word lists above before any human sees the document.

## Required document structure

```markdown
# Frame: <feature in six words or fewer>

## Problem
- <one sentence per bullet>

## What the code does today
- <one sentence per bullet, each citing a file path>

## Proposed solution
- <one sentence per bullet>

## Why this solves the problem
- <one sentence per bullet; each bullet links a solution element to a problem element>

## Acceptance criteria
1. <a numbered, individually testable check: a verifier reading the final diff must be able to answer yes or no>
2. <...>

## Out of scope
- <one sentence per bullet, from the ledger's scope boundaries and rejected alternatives>

## Open questions
- <one sentence per bullet; every ledger question still open, none dropped. Write "- None." if all were resolved>
```

## Quality bar

- A reader who knows nothing about the exploration conversation must understand the feature from this document alone.
- Every "Why" bullet must be falsifiable: someone can check the code later and prove it wrong.
- Every acceptance criterion names observable behavior, not intent: "the CLI exits 1 on bad input" passes; "errors are handled well" fails.
- 10–30 bullets total across all sections. If you have more, you are padding; if fewer, the ledger was not mined.

Before finishing, reread the document once and delete or tighten anything that fails the rules above. Zinsser: "the secret of good writing is to strip every sentence to its cleanest components."
