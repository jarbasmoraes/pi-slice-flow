import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Criterion 10 (package independence): nothing under simple-flow/extensions/ may
// depend on slice-flow. This guard reads every extension source file and asserts
// no import/require resolves to a slice-flow path and no slice-flow type is
// referenced. Comments are stripped first so the file's own prose (which discusses
// how it deliberately differs from slice-flow) does not trip the guard.

const extDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|js|mjs|cjs)$/.test(entry)) out.push(p);
  }
  return out;
}

// Remove block comments and line comments (leaving "://" in URLs intact).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const files = walk(extDir);

test("extensions/ ships the expected source files (guard is looking at real code)", () => {
  assert.ok(files.length >= 4, `expected >= 4 extension source files, found ${files.length}`);
});

test("no extension file imports from slice-flow (criterion 10: package independence)", () => {
  const importRe =
    /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|(?:require|import)\(\s*["']([^"']+)["']\s*\)/g;
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    let m;
    while ((m = importRe.exec(code)) !== null) {
      const spec = m[1] ?? m[2];
      assert.ok(
        !/slice-flow/.test(spec),
        `${file} imports "${spec}" — simple-flow must not depend on slice-flow`,
      );
    }
  }
});

test("no extension file references SliceFlowConfig (criterion 10)", () => {
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(
      !/\bSliceFlowConfig\b/.test(code),
      `${file} references SliceFlowConfig — simple-flow must not depend on slice-flow types`,
    );
  }
});
