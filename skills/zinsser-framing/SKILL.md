---
name: zinsser-framing
description: How to write a slice-flow frame document — problem, current behavior, proposed solution, and rationale as single-sentence declarative bullets in the style of William Zinsser. Use when framing a feature before architecture.
---

# Zinsser Framing

You are writing the frame document: the single source of truth that every later phase (architecture, planning, building, verification) will be judged against. If the frame is mushy, everything downstream is mushy.

## The Zinsser rules (binding)

1. **One idea per sentence.** If a bullet contains "and", check whether it is two ideas; if so, split it.
2. **Every bullet is one complete declarative sentence.** Subject, verb, period. No fragments, no questions, no headers-as-bullets.
3. **Strip every word that does no work.** Forbidden: "simply", "basically", "in order to" (use "to"), "it should be noted", "essentially", "robust", "seamless", "leverage", "utilize" (use "use").
4. **Prefer concrete nouns and active verbs.** "The CLI prints the greeting" beats "the greeting functionality is handled".
5. **Claims about code cite code.** Name the file and, where useful, the function: `src/greet.js: format() lowercases all input.`
6. **No hedging.** If you are not sure, investigate until you are, or state the open question as its own bullet under Problem.
7. **No marketing.** The document persuades by being correct, not enthusiastic.

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
```

## Quality bar

- A reader who knows nothing about this conversation must understand the feature from this document alone.
- Every "Why" bullet must be falsifiable: someone could check the code later and prove it wrong.
- 8–25 bullets total. If you have more, you are padding; if fewer, you have not investigated.

Before finishing, reread the document once and delete or tighten anything that fails rules 1–7. Zinsser: "the secret of good writing is to strip every sentence to its cleanest components."
