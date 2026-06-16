import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const skillPath = join(pkgDir, "skills", "codegraph", "SKILL.md");

function frontmatter(text) {
  const lines = text.split("\n");
  const first = lines.indexOf("---");
  const second = lines.indexOf("---", first + 1);
  assert.ok(first !== -1 && second !== -1, "file must have frontmatter delimited by ---");
  return lines.slice(first + 1, second);
}

function frontmatterValue(text, key) {
  for (const line of frontmatter(text)) {
    if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

function body(text) {
  const lines = text.split("\n");
  const first = lines.indexOf("---");
  const second = lines.indexOf("---", first + 1);
  return lines.slice(second + 1).join("\n");
}

test("codegraph SKILL.md exists", () => {
  assert.ok(existsSync(skillPath), "skills/codegraph/SKILL.md must exist");
});

test("frontmatter declares name: codegraph", () => {
  const text = readFileSync(skillPath, "utf8");
  assert.equal(frontmatterValue(text, "name"), "codegraph");
});

test("frontmatter has a description", () => {
  const text = readFileSync(skillPath, "utf8");
  const desc = frontmatterValue(text, "description");
  assert.ok(desc && desc.length > 0, "frontmatter must carry a non-empty description");
});

test("body documents all six query commands and the --json flag", () => {
  const b = body(readFileSync(skillPath, "utf8"));
  for (const cmd of ["query", "context", "callers", "callees", "impact", "files"]) {
    assert.ok(b.includes(cmd), `body must document the \`${cmd}\` command`);
  }
  assert.ok(b.includes("--json"), "body must mention the --json flag");
});

test("body instructs to use codegraph before grep/find/read", () => {
  const b = body(readFileSync(skillPath, "utf8"));
  assert.ok(b.includes("before grep"), 'body must instruct using codegraph "before grep"');
});

test("body states the grep fallback rule", () => {
  const b = body(readFileSync(skillPath, "utf8")).toLowerCase();
  assert.ok(b.includes("fall back") || b.includes("fallback"), "body must mention falling back");
  assert.ok(b.includes("grep"), "fallback must mention grep");
  assert.ok(
    b.includes("unavailable") || b.includes("no results") || b.includes("returns nothing") || b.includes("nothing"),
    "fallback must cover empty results / codegraph unavailable",
  );
});

test("package.json pi.skills still includes ./skills", () => {
  const cfg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.ok(cfg.pi.skills.includes("./skills"), "pi.skills must still include ./skills");
});
