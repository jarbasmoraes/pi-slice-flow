---
name: risk-taxonomy
description: The catalog of security/correctness risk axes slice-flow enforces — each axis's stable key, when a stack makes it live, when a plan or diff touches it, and the deterministic check that closes it. Use to classify which axes a plan/diff TOUCHES but leaves UNCOVERED, or to generate a concrete check for a live, uncovered axis. Per-project live axes live in .slice-flow/checks/manifest.json; this skill is the generic knowledge behind that data.
---

# Risk Taxonomy

A **risk axis** is a class of defect that is high-cost when it escapes AND catchable by a *deterministic* check — a test, scanner, or static rule that runs with no model in the loop. Determinism is the point: a same-family judge panel shares the blind spots of the code it reviews; `grep`, `semgrep`, and a type-checker do not.

Each axis has a stable **key** (matching the `RiskAxis` enum in `extensions/lib/detect-stack.ts` — keep them in sync) and three fields tuned for this skill's two consumers:

- **Live when** — the stack condition that puts the axis in play at all. Used to decide a project's live axes.
- **Touched when** — the signal that a specific plan or diff exercises the axis. Used by the coverage critic.
- **Check** — the deterministic enforcement. Used by the check-generator.

**Produce checks, not cautions.** A live, touched, uncovered axis must yield a *check* (a scanner, rule, or test) or a slice that adds one — never a paragraph warning about the risk. Narrating a risk you could have gated is the failure mode this taxonomy exists to prevent.

<!-- ============================================================
  OWNER'S RULES BLOCK
  Edit between the BEGIN/END markers to add, remove, or retune
  axes for your project's threat model. The defaults cover the
  common web-backend stack; an on-device, embedded, or
  data-pipeline project should adjust this block and the manifest.
  Keep each axis's `key:` in sync with the RiskAxis enum.
  ============================================================ -->
<!-- BEGIN OWNER RULES -->

## The axes

### secrets — credentials committed to source
- **Live when:** always.
- **Touched when:** a diff adds config, env handling, client init, or any literal that could be a key/token.
- **Check:** secret scanner (`gitleaks`) over the tree — Tier-A universal oracle, zero config.

### injection — untrusted input reaching an interpreter
- **Live when:** the code builds queries or shells out (any DB, ORM, or `exec`/`eval` sink).
- **Touched when:** a diff assembles a SQL/Cypher/shell/template string from variables instead of binding parameters.
- **Check:** SAST rules (`semgrep p/owasp-top-ten`) for injection sinks; a lint that query literals parameterize their inputs.

### multi-tenancy — one tenant reading another's data
- **Live when:** a shared store is partitioned by tenant (an auth provider + a database). The classic escaped P0: a query omits the tenant predicate and returns *everyone's* rows.
- **Touched when:** a diff adds or edits a query against a tenant-scoped entity, or a search/index call that cannot pre-filter.
- **Check:** a predicate-presence scanner — every query touching a tenant-scoped label/table binds the tenant key (`externalUserId`/`ownerId`/`userId`) in the same statement, or carries a justified opt-out annotation. (Ships as the `tenant-predicate` Tier-B template.)

### authz — missing or wrong authorization (IDOR)
- **Live when:** an auth provider is present.
- **Touched when:** a diff adds/edits a handler that looks up or mutates an object by a request-supplied id.
- **Check:** a route-coverage lint (every handler asserts an authz check) or an integration test that a non-owner is denied.

### pii-logging — sensitive data written to logs/telemetry
- **Live when:** user data flows through the system (an auth provider or user store).
- **Touched when:** a diff adds a log/telemetry/error-report call near user or request objects.
- **Check:** a banned-field scanner over log call sites; a redaction assertion in the logger.

### migration-lineage — schema drift between code and database
- **Live when:** an ORM/migration tool is present.
- **Touched when:** a diff edits a model/schema definition.
- **Check:** a drift/pending-migration check (`prisma migrate diff` or equivalent) against the live schema.

### money-idempotency — double-charges and non-replayable money ops
- **Live when:** a payment provider is present.
- **Touched when:** a diff adds/edits a charge, refund, or balance mutation.
- **Check:** a lint that every provider charge passes an idempotency key; a retry/replay test asserting no double effect.

### rate-limit — unbounded work from one caller
- **Live when:** a public web surface or a job queue is present.
- **Touched when:** a diff adds a public mutating route or a queue consumer.
- **Check:** a coverage lint that flagged routes/consumers are wrapped by a limiter or concurrency bound.

### xss — untrusted HTML rendered into the DOM
- **Live when:** a markdown/HTML renderer is present.
- **Touched when:** a diff edits a renderer component or adds a raw-HTML render path.
- **Check:** a banned-token scanner over guarded renderer files (`dangerouslySetInnerHTML`, `rehype-raw`, `skipHtml`, …). (Ships as the `banned-tokens` Tier-B template.)

<!-- END OWNER RULES -->

## Classification rules

- **Gap = live ∧ touched ∧ uncovered.** Report only axes meeting all three; a live axis a diff never touches is not a gap.
- **Conservative on "touched".** A false touch costs one human "no"; a missed touch ships a blind spot. When unsure, mark it touched.
- **Reference axes by `key`.** Structured output (e.g. `{ "axis": "multi-tenancy", "covered": false }`) must use the stable keys above, not prose names.

## Check tiers (for the generator)

- **Tier A — universal oracle:** any repo, zero config (secrets, dep CVEs, generic SAST). A missing tool is a graceful skip, never a failure.
- **Tier B — stack-templated:** a generic pattern with project-filled holes (e.g. `tenant-predicate` needs the project's tenant-scoped labels). Enforced after a human confirms the profile.
- **Tier C — bespoke:** a generated check for a one-off invariant, admitted only after it goes RED on a planted-violation fixture and GREEN on the clean tree.
