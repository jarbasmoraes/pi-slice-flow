# Changelog

## [0.7.0](https://github.com/jarbasmoraes/pi-slice-flow/compare/slice-flow-v0.6.0...slice-flow-v0.7.0) (2026-07-21)


### Features

* **feature:** accept optional easy|medium|hard tier prefix in /feature command ([17a3ac9](https://github.com/jarbasmoraes/pi-slice-flow/commit/17a3ac98cc8857af2af31c0fd8d65b7ee13be42d))

## [0.6.0](https://github.com/jarbasmoraes/pi-slice-flow/compare/slice-flow-v0.5.0...slice-flow-v0.6.0) (2026-07-21)


### Features

* **frame:** add per-task model tiers and cross-family attack fusion ([d9a84a4](https://github.com/jarbasmoraes/pi-slice-flow/commit/d9a84a44c0558c3feaba15a1adfbc4caabfe3356))

## [0.5.0](https://github.com/jarbasmoraes/pi-slice-flow/compare/slice-flow-v0.4.0...slice-flow-v0.5.0) (2026-07-17)


### Features

* **observability:** emit run attributes as Langfuse trace tags ([54530c5](https://github.com/jarbasmoraes/pi-slice-flow/commit/54530c5704019836f4d8654a4b21a436b4fb7e8c))

## [0.4.0](https://github.com/jarbasmoraes/pi-slice-flow/compare/slice-flow-v0.3.0...slice-flow-v0.4.0) (2026-07-17)


### Features

* **observability:** tag Langfuse traces and observations with cohort ([bd81f25](https://github.com/jarbasmoraes/pi-slice-flow/commit/bd81f2584c7c3f8ee53cb76f015a91f1d019e8f0))

## [0.3.0](https://github.com/jarbasmoraes/pi-slice-flow/releases/tag/slice-flow-v0.3.0) (2026-07-17)

First release of slice-flow as its own standalone repository, split out of
the harnes monorepo with full commit history preserved (see
`backup/harnes-pre-split` for the pre-split state). Includes everything
delivered through the monorepo's 0.2.0, plus:

### Features

* **observability:** enforce codegraph usage, tag telemetry by phase, track release cohorts
* **repo:** split into a standalone repository with its own single-package release-please pipeline

### Bug Fixes

* **slice-flow:** make `npm run check` portable (no machine-specific paths)
* **test:** make agent-bundle tests hermetic instead of assuming an ambient `.pi/agents/`

### Previously released as part of the harnes monorepo (0.1.0 → 0.2.0)

* **architecture:** enforce decision legibility with deterministic lint
* **slice-flow:** add `/feature-init` command for project profile initialization
* **slice-flow:** add deterministic check-pack with cross-family biases mitigation
* **slice-flow:** add scalable template scanners for tenant predicates and banned tokens
* **slice-flow:** add web-research module with readable-content extraction, headless browser layer, and pluggable search providers
* **slice-flow:** global config layer + agent×model audit fixes
* **slice-flow:** implement remaining 11 audit findings (observability, cost, design)
* **slice-flow:** introduce risk-taxonomy and check-generator skills
* **slice-flow:** replace decorative loop token budget with deterministic spawn-cost budget
* **slice-flow:** Tier 2 — per-gate autonomy, plan judge, architecture attack panel, prototype gate
* **slice-flow:** Tier 3 — cross-run observability + self-improving reflection
* **todoist:** add `listTasks` for active tasks and integrate task picker
* assorted verifier-finding fixes across code-quality, evals, security, and tests dimensions
