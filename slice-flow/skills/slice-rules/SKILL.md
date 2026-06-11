---
name: slice-rules
description: The binding slice contract for slice-flow builders, planners, and fix-up agents — slice file format, fresh-context discipline, read-only memos, TDD-first, LOC budgets, commit policy, and the required post-build memo. Use whenever planning, building, or fixing a slice.
---

# Slice Rules

<!-- ============================================================
  OWNER'S RULES BLOCK
  Replace the section between the BEGIN/END markers with your
  verbatim rules block. The text below reconstructs it from the
  spec ("slice is the contract, fresh context, read-only memos,
  TDD-first, one commit per slice with auto_commit flag, ~100/150
  LOC escalation, scope discipline, one-component-per-file
  override, required post-build Memo") so the workflow runs
  end-to-end until you paste the original.
  ============================================================ -->
<!-- BEGIN OWNER RULES -->

## The contract

1. **The slice is the contract.** The slice file is the complete and only specification of your task. If it is not in the slice, it is not your job. If the slice is ambiguous or impossible, say so in the memo and implement the unambiguous part — never invent requirements.
2. **Fresh context.** You start with no conversation history, by design. Do not try to reconstruct "what the team probably meant" — the slice plus the memos are the whole truth.
3. **Memos are read-only.** Prior slices' memos tell you what already exists and why. Never modify a prior memo, never rework a prior slice's scope unless your slice explicitly says to.
4. **TDD-first.** Write the failing test(s) for the slice's acceptance criteria before the implementation. Then implement until green. A slice with untestable acceptance criteria gets a memo note explaining what was verified manually and how.
5. **One commit per slice** when `auto_commit` is enabled: a single commit containing tests, implementation, and nothing else. Message: `slice NNN: <slice title>`. Never push. When `auto_commit` is disabled, leave the working tree dirty and say so in the memo.
6. **~100 LOC budget, 150 escalation.** Target roughly 100 changed lines of implementation (tests excluded). At ~150 you must stop, implement the most valuable coherent subset, and record the cut in the memo's Deviations section — the planner sized it wrong, and that signal matters more than heroics.
7. **Scope discipline.** No drive-by refactors, no dependency upgrades, no formatting sweeps, no fixing unrelated bugs (note them in the memo instead).
8. **One-component-per-file override.** When a slice requires a new UI component, it goes in its own file even if that exceeds the LOC budget slightly — splitting a component across slices is worse than a mildly oversized slice.

## Required post-build Memo

Every build or fix-up ends by writing/appending the memo. Format:

```markdown
# Memo: <slice id> — <slice title>

## What exists now
- <one sentence per bullet: behavior added, where it lives>

## Changed files
- <path> — <why>

## Commit
<hash, or "not committed (auto_commit off)">

## Tests
- <test file / case> — <what it proves>

## Deviations
- <anything cut, escalated, or interpreted; "none" if none>

## Notes for later slices
- <load-bearing facts the next builder must know; "none" if none>
```

<!-- END OWNER RULES -->

## Slice file format (used by the planner, consumed by builders)

Every slice file is `NNN-<slug>.md` and must be a self-sufficient contract:

```markdown
# Slice NNN: <title>

## Objective
<one paragraph: the user-visible or system-visible capability this slice adds>

## Depends on
<prior slice ids, or "none">

## Scope
- <exact changes: files to create/modify, functions to add>

## Out of scope
- <the tempting adjacent work this slice must NOT do>

## Acceptance criteria
- <testable statements; these become the TDD tests>

## Hints
- <relevant existing code paths, patterns to follow, snippets from the plan>
```

Slice 001 is the smallest change that yields a WORKING end-to-end MVP of the feature. Every later slice keeps the system working — no slice may end in a broken state.
