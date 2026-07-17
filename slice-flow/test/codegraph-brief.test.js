import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBrief, codegraphClause, fixupBrief, hypothesisBrief, intakeBrief } from "../extensions/lib/briefs.ts";

const p = { intake: "/i", arch: "/a", frame: "/f", root: "/r" };
const artifacts = { sliceId: "001-x", slicePath: "/s/001-x.md", memoPath: "/m/001-x.md" };
const angle = { id: 1, angle: "minimal-change", brief: "x" };

test("codegraphClause is empty when not ready", () => {
  assert.equal(codegraphClause(false), "");
});

test("codegraphClause documents all six commands, --json, and the hard-requirement/fallback wording", () => {
  const c = codegraphClause(true);
  for (const cmd of ["query", "context", "callers", "callees", "impact", "files"]) {
    assert.ok(c.includes(cmd), `clause must document the \`${cmd}\` command`);
  }
  assert.ok(c.includes("--json"));
  assert.ok(c.includes("hard requirement"));
  assert.ok(c.toLowerCase().includes("fall back"));
});

// --- codegraphReady === true: the mandatory clause reaches every eligible brief ---

test("intakeBrief embeds the codegraph clause when ready", () => {
  assert.match(intakeBrief(p, "feature", true), /Code discovery: use codegraph first/);
});

test("hypothesisBrief embeds the codegraph clause when ready", () => {
  assert.match(hypothesisBrief(p, angle, true), /Code discovery: use codegraph first/);
});

test("buildBrief embeds the codegraph clause when ready", () => {
  assert.match(buildBrief(p, artifacts, true, true), /Code discovery: use codegraph first/);
});

test("fixupBrief embeds the codegraph clause when ready", () => {
  assert.match(fixupBrief(artifacts, 1, true, true), /Code discovery: use codegraph first/);
});

// --- codegraphReady === false: briefs are byte-identical to the pre-clause text ---

test("intakeBrief has no codegraph clause when not ready", () => {
  assert.doesNotMatch(intakeBrief(p, "feature", false), /codegraph/i);
});

test("hypothesisBrief has no codegraph clause when not ready", () => {
  assert.doesNotMatch(hypothesisBrief(p, angle, false), /codegraph/i);
});

test("buildBrief has no codegraph clause when not ready", () => {
  assert.doesNotMatch(buildBrief(p, artifacts, true, false), /codegraph/i);
});

test("fixupBrief has no codegraph clause when not ready", () => {
  assert.doesNotMatch(fixupBrief(artifacts, 1, true, false), /codegraph/i);
});
