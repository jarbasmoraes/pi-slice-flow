---
name: verify-rubrics
description: One rubric per slice-flow verification dimension (code-quality, simplicity, security, evals, tests). Verifiers are told their dimension and must REFUTE, not confirm, using only that rubric. Use during phase 5 verification and phase 6 loop re-verification.
---

# Verification Rubrics

You are an adversarial verifier assigned exactly ONE dimension. Use only that rubric. Your stance is refutation: start from "this implementation fails my dimension" and try to prove it with evidence from the diff, the docs, and execution. PASS only when your honest attempts to refute come up empty.

Common rules for every dimension:

- Judge the full diff against the frame (01-frame.md), architecture (02-architecture.md), and plan (03-plan.md).
- Every finding needs file, line, reason, and severity (blocker|major|minor). Any blocker or major ⇒ FAIL.
- First line of output: `VERDICT: PASS` or `VERDICT: FAIL`. Nothing before it.
- Findings must be reproducible by a stranger: include the command or the cited code.
- Workflow metadata (the feature-work/ directory) is out of scope.

## Rubric: code-quality

Refute the claim "this code is well-made."
- Hunt for: dead code, unused exports, swallowed errors, missing error paths, inconsistent naming against repo conventions, type holes (`any`, unchecked casts), broken or missing doc comments on public surfaces, copy-paste drift between similar blocks.
- Run the repo's linter/typechecker if present; a new warning introduced by the diff is a finding.

## Rubric: simplicity

Refute the claim "this is the simplest implementation that satisfies the plan."
- Hunt for: abstractions with one caller, configuration for needs nobody stated, layers that only forward calls, cleverness where a plain loop would do, new dependencies that replicate stdlib or existing repo utilities, speculative generality ("we might need...").
- Compare against the architecture document: complexity the winning hypothesis did not call for must justify itself or it is a finding.

## Rubric: security

Refute the claim "this change introduces no security weaknesses."
- Hunt for: unvalidated external input reaching interpreters (shell, SQL, HTML/DOM, eval, path resolution), secrets or tokens in code/logs/commits, injection via string-built commands, missing authz checks on new surfaces, unsafe deserialization, path traversal, new dependencies with broad permissions, weakened crypto or TLS settings.
- Trace data flow for every new input the diff accepts: source → validation → sink.

## Rubric: evals

Refute the claim "the implemented behavior actually serves the framed problem."
- This is end-to-end empirical evaluation: exercise the feature the way the frame says a user/system will. Run the program, call the API, drive the CLI.
- Hunt for: acceptance criteria that pass their unit tests but fail in real composition, behavior that contradicts a frame bullet, missing handling of the obvious second scenario (empty input, repeat invocation, concurrent use where relevant), regressions in adjacent behavior the frame said must keep working.
- Record the exact commands/inputs you used and their outputs.

## Rubric: tests

Refute the claim "the test suite would catch this feature breaking."
- Run the full test suite; any failure is a blocker.
- Hunt for: acceptance criteria with no test, assertions that cannot fail (tautologies, snapshot-everything), tests coupled to implementation details instead of behavior, mutation-vulnerable spots (flip a condition mentally — would a test fail?), missing negative/error-path tests, tests that pass in isolation but depend on order.
- Per slice, spot-check that the memo's claimed tests exist and assert what the memo says.
