import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sliceFlowText = readFileSync(join(here, "..", "extensions", "slice-flow.ts"), "utf8");

// Acceptance criterion 18: the seed passed to startWorkflow (and thus
// state.feature) is content+description+comments concatenated, blanks
// dropped. setupTodoistStart/todoist.ts's engine-level behavior for this is
// covered by test/setup-todoist.test.js and test/todoist.test.js; this file
// covers the composition-root wiring in slice-flow.ts's `start` action, which
// (like the flush call sites in test/buffer-flush-transport.test.js) can only
// be checked at the source-text level without a full Pi ExtensionContext.

test("the start action seeds `feature` from todoist?.seed, falling back to the raw description", () => {
	const start = sliceFlowText.indexOf('if (params.action === "start")');
	const next = sliceFlowText.indexOf('if (params.action === "metrics")');
	const body = sliceFlowText.slice(start, next);
	assert.match(body, /const feature = todoist\?\.seed\?\.trim\(\) \|\| params\.description\.trim\(\);/);
});

test("the start action passes `feature` (not params.description.trim()) into startWorkflow", () => {
	const start = sliceFlowText.indexOf('if (params.action === "start")');
	const next = sliceFlowText.indexOf('if (params.action === "metrics")');
	const body = sliceFlowText.slice(start, next);
	assert.match(body, /startWorkflow\(p, cfg, feature, slug, baseline, ctx\.cwd, codegraphState, isolation, judgeFamilies, todoist \?\? undefined\)/);
});

test("slug allocation still uses the raw params.description.trim(), independent of the seed", () => {
	const start = sliceFlowText.indexOf('if (params.action === "start")');
	const next = sliceFlowText.indexOf('if (params.action === "metrics")');
	const body = sliceFlowText.slice(start, next);
	assert.match(body, /const slug = allocateSlug\(ctx\.cwd, cfg\.workDir, params\.description\.trim\(\)\);/);
});
