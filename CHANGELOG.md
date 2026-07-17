# Changelog

## [0.4.0](https://github.com/jarbasmoraes/pi-slice-flow/compare/slice-flow-v0.3.0...slice-flow-v0.4.0) (2026-07-17)


### Features

* **architecture:** enforce decision legibility with deterministic lint ([55c2b20](https://github.com/jarbasmoraes/pi-slice-flow/commit/55c2b2000fe696499b14b9a1795321b1fcd095eb))
* **observability:** enforce codegraph usage, tag telemetry by phase, track release cohorts ([d876065](https://github.com/jarbasmoraes/pi-slice-flow/commit/d8760653fc44f768332f836d5ddf465c4d6b4f9e))
* **slice-flow:** add `/feature-init` command for project profile initialization ([21df854](https://github.com/jarbasmoraes/pi-slice-flow/commit/21df854a5947e15e972de1caa4231669723ae286))
* **slice-flow:** add deterministic check-pack with cross-family biases mitigation ([b5e0e6d](https://github.com/jarbasmoraes/pi-slice-flow/commit/b5e0e6dcd9aa93fec4537799a92ea3c9ff3d1af5))
* **slice-flow:** add scalable template scanners for tenant predicates and banned tokens ([e785bc2](https://github.com/jarbasmoraes/pi-slice-flow/commit/e785bc2f390e4469f46423202ae98a4714c044ed))
* **slice-flow:** Add web-research module with readable-content extraction, headless browser layer, and pluggable search providers ([8ed6342](https://github.com/jarbasmoraes/pi-slice-flow/commit/8ed6342e2f147fc1b0a7dc968dd7c75953c68dfe))
* **slice-flow:** global config layer + agent×model audit fixes ([d37668e](https://github.com/jarbasmoraes/pi-slice-flow/commit/d37668e63d666fd48a6208fd957b37697c224339))
* **slice-flow:** implement remaining 11 audit findings (observability, cost, design) ([de910bb](https://github.com/jarbasmoraes/pi-slice-flow/commit/de910bb20b684d5b5ae47346af0e8feb6bccd0ef))
* **slice-flow:** introduce risk-taxonomy and check-generator skills ([1397a0b](https://github.com/jarbasmoraes/pi-slice-flow/commit/1397a0bea8380972470509163731685aa80ff468))
* **slice-flow:** replace decorative loop token budget with deterministic spawn-cost budget ([9431031](https://github.com/jarbasmoraes/pi-slice-flow/commit/9431031722042354b8c2f68e38cdea275216a49e))
* **slice-flow:** Tier 2 — per-gate autonomy, plan judge, architecture attack panel, prototype gate ([8464ce6](https://github.com/jarbasmoraes/pi-slice-flow/commit/8464ce6663e9bce338283fd142fc427558ecc0d7))
* **slice-flow:** Tier 3 — cross-run observability + self-improving reflection ([fb91534](https://github.com/jarbasmoraes/pi-slice-flow/commit/fb91534c725bef110347ff7b198284bcfebb5cc7))
* **todoist:** add `listTasks` for active tasks and integrate task picker ([e0f2213](https://github.com/jarbasmoraes/pi-slice-flow/commit/e0f22136b3161bc30d608f7d2d9981f862fa96b2))


### Bug Fixes

* **code-quality:** address verifier findings (loop 1) ([0d1bde1](https://github.com/jarbasmoraes/pi-slice-flow/commit/0d1bde155406e57db005f0188d1062ef02297b54))
* **evals:** address verifier findings (loop 1) ([5672a71](https://github.com/jarbasmoraes/pi-slice-flow/commit/5672a712382fd030a68b7f6f4ae9f92c29c7d3c2))
* **evals:** address verifier findings (loop 1) ([3d28ee4](https://github.com/jarbasmoraes/pi-slice-flow/commit/3d28ee4c7067b9c5767a7d27791ef4e254b1e009))
* **evals:** address verifier findings (loop 3) ([47c70d4](https://github.com/jarbasmoraes/pi-slice-flow/commit/47c70d4095b1fadc54ac20257cfdc75b396d3da4))
* **evals:** address verifier findings (loop 4) ([edf66e1](https://github.com/jarbasmoraes/pi-slice-flow/commit/edf66e10577b27e4a8ac48e00c9fc865180da5d0))
* **security:** address verifier findings (loop 1) ([8526cc7](https://github.com/jarbasmoraes/pi-slice-flow/commit/8526cc714e8a4d95dfd7e50eada9d6423cd35b24))
* **slice-flow:** make npm run check portable (no machine-specific paths) ([7768156](https://github.com/jarbasmoraes/pi-slice-flow/commit/7768156f98ea6dbd64145106a29f0e29a56ba0b2))
* **slice-flow:** read-only judge/adversary/reviewer agents set completionGuard: false ([2e57258](https://github.com/jarbasmoraes/pi-slice-flow/commit/2e5725851035a52fb8ba9dc5093ae53e83a1ebdf))
* **test:** make agent-bundle tests hermetic instead of assuming ambient .pi/agents/ ([6a3c931](https://github.com/jarbasmoraes/pi-slice-flow/commit/6a3c9319641453946a85117a388c801642357cc5))
* **tests:** address verifier findings (loop 1) ([46bd387](https://github.com/jarbasmoraes/pi-slice-flow/commit/46bd3877f24492d237d43ed025fef06deede823b))
* **tests:** address verifier findings (loop 1) ([1326563](https://github.com/jarbasmoraes/pi-slice-flow/commit/13265633a9e5cdea8aae098878dbb7d7c88d6ff7))
* **tests:** address verifier findings (loop 2) ([0822d90](https://github.com/jarbasmoraes/pi-slice-flow/commit/0822d902c75d9344002d05685f3ba995f71fbc65))

## [0.3.0](https://github.com/jarbasmoraes/pi-slice-flow/releases/tag/v0.3.0) (2026-07-17)

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
