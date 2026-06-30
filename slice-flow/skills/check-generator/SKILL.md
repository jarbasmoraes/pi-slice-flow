---
name: check-generator
description: How to author a deterministic check (scanner config, static rule, or test) plus a planted-violation fixture for a live, uncovered risk axis — so an escaped blind spot becomes a gate that runs with no model in the loop. Use when a slice's job is to add a check for a risk axis the shipped check-pack does not yet cover. The check is admitted only if it goes RED on the fixture and GREEN on the clean tree.
---

# Check Generator

You are authoring an **oracle**, not a caution. The deliverable is a deterministic check that *fails when the risk is present and passes when it is not* — plus the planted-violation fixture that proves it discriminates. A check you cannot demonstrate failing on a real violation is theater; it will be quarantined, never enforced.

This is the productive form of "expert review": instead of a model narrating what *might* be wrong (which shares the blind spots of the model that wrote the code), you encode the invariant once, deterministically, where it will catch every future violation for free.

## When this applies

A slice points you here when an axis from the **risk-taxonomy** skill is *live* (the stack exposes it) and *uncovered* (no Tier-A oracle or shipped Tier-B template enforces it). Your job is to close exactly that gap — not to re-cover an axis the check-pack already gates.

## What you produce

Two artifacts, together:

1. **The check.** Prefer, in order:
   - **An existing scanner with new params** — if the axis fits `tenant-predicate` (a query must bind a key) or `banned-tokens` (a file must not contain a token), emit a `.slice-flow/checks/manifest.json` entry filling that scanner's params. Cheapest and already validated machinery.
   - **A semgrep rule** — for an AST/pattern invariant semgrep expresses well. Commit it under `.slice-flow/checks/rules/` and run it via the SAST oracle.
   - **A test** — when the invariant is behavioral (e.g. "a retried charge does not double-bill"). A focused, fast test in the project's own runner.
2. **The fixture.** A minimal planted violation the check must catch, plus (if not obvious) the clean counterpart. Without a fixture there is nothing to admit the check against.

## The contract (non-negotiable)

- **RED on the fixture, GREEN on the clean tree.** The check must produce ≥1 finding on the planted violation and 0 on clean code. This is verified mechanically (`validateCheck`); a check that fails either half is rejected and quarantined as a warning — it never becomes a blocker.
- **One invariant per check.** A check that asserts two things gives an ambiguous finding. Split them.
- **Specific over clever.** A narrow regex/rule with a clear message beats a broad one that fires on edge cases — false positives on clean code get the whole check disabled. When unsure, tighten and add an explicit, documented opt-out annotation (as `tenant-predicate` does with `@tenant-safe: <reason>`).
- **Deterministic only.** No network, no clock, no randomness, no model call. The check must give the same verdict on the same tree every time.
- **Actionable message.** Every finding states the file, the line, the violated invariant, and how to fix or opt out — the same shape the shipped scanners emit (`<check-id>: <path>:<line> — <what and why>`).

## Output format

State, in order:
1. **Axis** — the stable risk-taxonomy key you are covering.
2. **Invariant** — one sentence: what must always be true.
3. **Check** — the kind (scanner-params / semgrep / test) and its exact content.
4. **Fixture** — the planted violation, and the clean counterpart.
5. **Admission** — confirm the check is RED on the fixture and GREEN on clean; if you could not make it discriminate, say so plainly and stop — a quarantined honest "I couldn't" beats a green-on-everything fake.
