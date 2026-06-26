import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTelemetry } from "../extensions/lib/telemetry.ts";
import { createState, observeSubagentResult, sumUsage, workPaths, ensureWorkTree } from "../extensions/lib/workspace.ts";

/** A telemetry instance with a capturing transport. */
function capturing() {
	const batches = [];
	const tel = createTelemetry({ enabled: true, send: async (batch) => { batches.push(batch); } });
	return { tel, batches };
}

test("disabled telemetry is a no-op (no events, flush resolves)", async () => {
	let sent = 0;
	const tel = createTelemetry({ enabled: false, send: async () => { sent++; } });
	assert.equal(tel.enabled, false);
	tel.trace({ id: "t" });
	tel.observation({ id: "o", traceId: "t", startTime: "now" });
	tel.score({ id: "s", traceId: "t", name: "g", value: 1 });
	await tel.flush();
	assert.equal(sent, 0);
});

test("trace/observation/score map to the right ingestion event types and upsert by body.id", async () => {
	const { tel, batches } = capturing();
	tel.trace({ id: "trace-1", name: "feat", sessionId: "slug" });
	tel.observation({ id: "slug:1:architect", traceId: "trace-1", name: "Phase 2", startTime: "2026-01-01T00:00:00.000Z", input: { a: 1 } });
	tel.observation({ id: "slug:1:architect", traceId: "trace-1", endTime: "2026-01-01T00:01:00.000Z", output: "done", usageDetails: { input: 10, output: 5, total: 15 }, costDetails: { total: 0.02 } });
	tel.score({ id: "slug:gate:architect:1", traceId: "trace-1", name: "gate-architect", value: 1, comment: "approve" });
	await tel.flush();

	const batch = batches[0];
	const types = batch.map((e) => e.type);
	assert.deepEqual(types, ["trace-create", "generation-create", "generation-update", "score-create"]);
	// open and close share the SAME body.id (resumable upsert)
	assert.equal(batch[1].body.id, "slug:1:architect");
	assert.equal(batch[2].body.id, "slug:1:architect");
	// envelope ids are unique per event (server-side dedup)
	assert.notEqual(batch[1].id, batch[2].id);
	// close carries usage/cost
	assert.deepEqual(batch[2].body.usageDetails, { input: 10, output: 5, total: 15 });
	assert.deepEqual(batch[2].body.costDetails, { total: 0.02 });
	// undefined fields are stripped
	assert.ok(!("output" in batch[1].body));
});

test("flush clears the buffer; a second flush sends nothing", async () => {
	const { tel, batches } = capturing();
	tel.trace({ id: "t" });
	await tel.flush();
	await tel.flush();
	assert.equal(batches.length, 1);
});

test("a failing transport never throws out of flush", async () => {
	const tel = createTelemetry({ enabled: true, send: async () => { throw new Error("langfuse down"); } });
	tel.trace({ id: "t" });
	await tel.flush(); // must resolve, not reject
});

test("sumUsage sums real per-agent usage from foreground details", () => {
	const u = sumUsage({ results: [{ usage: { input: 100, output: 40, cost: 0.01 } }, { usage: { input: 50, output: 10, cost: 0.005 } }] });
	assert.deepEqual(u, { input: 150, output: 50, cost: 0.015 });
});

test("sumUsage returns null for an async receipt (empty results) or missing details", () => {
	assert.equal(sumUsage({ asyncId: "x", results: [] }), null);
	assert.equal(sumUsage({}), null);
	assert.equal(sumUsage(undefined), null);
});

test("observeSubagentResult accumulates real usage when present, else chars/4 only", () => {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-usage-"));
	const p = workPaths(cwd, ".pi/task", "feat");
	ensureWorkTree(p);

	const real = createState("feat", "feat", null);
	observeSubagentResult(p, real, { task: "x" }, [{ type: "text", text: "ok" }], { results: [{ usage: { input: 200, output: 80, cost: 0.03 } }] });
	assert.equal(real.realInputTokens, 200);
	assert.equal(real.realOutputTokens, 80);
	assert.equal(real.realCost, 0.03);

	const async_ = createState("feat", "feat", null);
	observeSubagentResult(p, async_, { task: "x" }, [{ type: "text", text: "ok" }], { asyncId: "a", results: [] });
	assert.equal(async_.realCost, 0);
	assert.ok(async_.log.some((e) => e.kind === "note" && /async/.test(e.event)), "an async-mode note is logged");
	assert.ok(async_.tokensSpent > 0, "chars/4 fallback still runs");
});
