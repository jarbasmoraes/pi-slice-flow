import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintSlices, workPaths } from "../extensions/lib/workspace.ts";

const GOOD_SLICE = (deps = "none") => `# Slice: title

## Objective
One capability.

## Depends on
${deps}

## Scope
- create src/x.ts

## Out of scope
- everything else

## Acceptance criteria
- the thing works

## Hints
- see src/y.ts
`;

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-lint-slices-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	mkdirSync(p.slices, { recursive: true });
	return p;
}

test("a well-formed contiguous slice set passes", () => {
	const p = setup();
	writeFileSync(join(p.slices, "001-mvp.md"), GOOD_SLICE("none"));
	writeFileSync(join(p.slices, "002-next.md"), GOOD_SLICE("001"));
	const r = lintSlices(p);
	assert.equal(r.ok, true, r.findings.join("; "));
});

test("empty slice dir fails", () => {
	const p = setup();
	const r = lintSlices(p);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /no slice files/);
});

test("non-contiguous numbering is caught", () => {
	const p = setup();
	writeFileSync(join(p.slices, "001-a.md"), GOOD_SLICE("none"));
	writeFileSync(join(p.slices, "003-c.md"), GOOD_SLICE("001"));
	const r = lintSlices(p);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /not contiguous/);
});

test("forward dependency is the load-bearing catch", () => {
	const p = setup();
	writeFileSync(join(p.slices, "001-a.md"), GOOD_SLICE("none"));
	writeFileSync(join(p.slices, "002-b.md"), GOOD_SLICE("003")); // depends on a later slice
	writeFileSync(join(p.slices, "003-c.md"), GOOD_SLICE("002"));
	const r = lintSlices(p);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /forward dependency/);
});

test("a slice depending on itself is a forward dependency", () => {
	const p = setup();
	writeFileSync(join(p.slices, "001-a.md"), GOOD_SLICE("none"));
	writeFileSync(join(p.slices, "002-b.md"), GOOD_SLICE("002"));
	const r = lintSlices(p);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /forward dependency/);
});

test("slice 001 must depend on none", () => {
	const p = setup();
	writeFileSync(join(p.slices, "001-a.md"), GOOD_SLICE("002"));
	writeFileSync(join(p.slices, "002-b.md"), GOOD_SLICE("001"));
	const r = lintSlices(p);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /slice 001 must depend on "none"/);
});

test("missing required section is caught", () => {
	const p = setup();
	writeFileSync(join(p.slices, "001-a.md"), "# Slice\n\n## Objective\nx\n\n## Depends on\nnone\n");
	const r = lintSlices(p);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /missing required section "## Scope"/);
});

test("empty Scope / Acceptance criteria are caught", () => {
	const p = setup();
	const emptyBody = `# Slice

## Objective
x

## Depends on
none

## Scope

## Out of scope
- none

## Acceptance criteria

## Hints
- none
`;
	writeFileSync(join(p.slices, "001-a.md"), emptyBody);
	const r = lintSlices(p);
	assert.equal(r.ok, false);
	assert.match(r.findings.join(" "), /"## Scope" has no items/);
	assert.match(r.findings.join(" "), /"## Acceptance criteria" has no items/);
});
