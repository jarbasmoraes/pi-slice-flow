import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allocateSlug } from "../extensions/lib/workspace.ts";

const WORK_DIR = ".pi/task";
const NOW = new Date(2026, 6, 1, 12, 0, 0); // local time, month index 6 = July

test("allocateSlug returns a timestamp-prefixed slug with no numeric suffix", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-allocate-slug-"));
  const slug = allocateSlug(cwd, WORK_DIR, "My feature", NOW);
  assert.equal(slug, "2026-07-01_120000_my-feature");
  assert.doesNotMatch(slug, /-\d+$/);
});

test("allocateSlug advances the timestamp by one second on a same-second clash", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-allocate-slug-"));
  mkdirSync(join(cwd, WORK_DIR, "2026-07-01_120000_my-feature"), { recursive: true });

  const slug = allocateSlug(cwd, WORK_DIR, "My feature", NOW);
  assert.equal(slug, "2026-07-01_120001_my-feature");
});

test("allocateSlug does not treat a bare legacy folder as a collision", () => {
  const cwd = mkdtempSync(join(tmpdir(), "slice-flow-allocate-slug-"));
  mkdirSync(join(cwd, WORK_DIR, "my-feature"), { recursive: true });

  const slug = allocateSlug(cwd, WORK_DIR, "My feature", NOW);
  assert.equal(slug, "2026-07-01_120000_my-feature");
  assert.ok(existsSync(join(cwd, WORK_DIR, "my-feature")));
});
