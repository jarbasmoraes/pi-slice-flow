import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setProjectModelMode } from "../extensions/lib/model-mode.ts";

test("setProjectModelMode creates a project config with the selected mode", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-model-mode-"));
	const path = setProjectModelMode(cwd, "gpt");
	assert.equal(path, join(cwd, "slice-flow.json"));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { modelMode: "gpt" });
});

test("setProjectModelMode preserves unrelated project settings", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-model-mode-"));
	const path = join(cwd, "slice-flow.json");
	writeFileSync(path, JSON.stringify({ telemetry: { enabled: true }, planCount: 4 }));
	setProjectModelMode(cwd, "anthropic");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		telemetry: { enabled: true },
		planCount: 4,
		modelMode: "anthropic",
	});
});

test("setProjectModelMode refuses to overwrite malformed project config", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-model-mode-"));
	const path = join(cwd, "slice-flow.json");
	writeFileSync(path, "not json");
	assert.throws(() => setProjectModelMode(cwd, "mixed"), /cannot be updated/);
	assert.equal(readFileSync(path, "utf8"), "not json");
});
