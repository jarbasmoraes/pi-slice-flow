import { test } from "node:test";
import assert from "node:assert/strict";

import {
	computeTaskMetrics,
	aggregate,
	gatherOverrideCases,
	overrideRate,
	renderReport,
	GATE_ORDER,
} from "../extensions/lib/metrics.ts";

/** Build a minimal State-shaped object from a list of event strings. */
function stateWith(slug, events, extra = {}) {
	return {
		slug,
		phase: extra.phase ?? "done",
		tokensSpent: extra.tokensSpent ?? 0,
		log: events.map((event, i) => ({ ts: `2026-01-01T00:00:0${i}.000Z`, event })),
	};
}

test("computeTaskMetrics counts gate decisions per gate", () => {
	const m = computeTaskMetrics(
		stateWith("feat", [
			"gate frame: approve",
			"gate architect: approve",
			"gate architect: revise",
			"gate plan: abort",
			"gate verify: pause",
		]),
	);
	const arch = m.gates.find((g) => g.gate === "architect");
	assert.equal(arch.approve, 1);
	assert.equal(arch.revise, 1);
	assert.equal(arch.abort, 0);
	const plan = m.gates.find((g) => g.gate === "plan");
	assert.equal(plan.abort, 1);
	const verify = m.gates.find((g) => g.gate === "verify");
	assert.equal(verify.pause, 1);
});

test("overrideRate is (revise + abort) / total decisions", () => {
	// 1 approve, 1 revise, 1 abort, 1 pause => (1 + 1) / 4 = 0.5
	const m = computeTaskMetrics(
		stateWith("feat", [
			"gate plan: approve",
			"gate plan: revise",
			"gate plan: abort",
			"gate plan: pause",
		]),
	);
	const plan = m.gates.find((g) => g.gate === "plan");
	assert.equal(plan.overrideRate, 0.5);
	// the pure helper agrees
	assert.equal(overrideRate({ approve: 1, revise: 1, abort: 1, pause: 1 }), 0.5);
	// no decisions => 0, never NaN
	assert.equal(overrideRate({ approve: 0, revise: 0, abort: 0, pause: 0 }), 0);
});

test("computeTaskMetrics tallies retry rounds by kind", () => {
	const m = computeTaskMetrics(
		stateWith("feat", [
			"frame validation failed (lint ok, judge FAIL) -> recompile 1",
			"plan validation failed (lint fail, judge PASS) -> replan 1/2",
			"plan validation failed (lint fail, judge PASS) -> replan 2/2",
			"architecture lint failed -> re-judge 1/2",
			"arch attack RECONSIDER -> full re-run (regenerate hypotheses) 1/2",
			"001-x review FAIL -> fix-up round 1",
			"loop iteration 1: FAIL on tests",
		]),
	);
	assert.equal(m.retries.recompile, 1);
	assert.equal(m.retries.replan, 2);
	assert.equal(m.retries["re-judge"], 1);
	assert.equal(m.retries.reconsider, 1);
	assert.equal(m.retries.fixup, 1);
	assert.equal(m.retries.loop, 1);
});

test("computeTaskMetrics carries the supplied verdict summary and token spend", () => {
	const m = computeTaskMetrics(stateWith("feat", ["gate frame: approve"], { tokensSpent: 4242, phase: "verify" }), {
		frame: "PASS",
		plan: "FAIL",
	});
	assert.equal(m.tokensSpent, 4242);
	assert.equal(m.phase, "verify");
	assert.deepEqual(m.verdicts, { frame: "PASS", plan: "FAIL" });
});

test("gates are returned in canonical pipeline order", () => {
	const m = computeTaskMetrics(
		stateWith("feat", ["gate verify: approve", "gate frame: approve", "gate plan: approve"]),
	);
	const order = m.gates.map((g) => g.gate);
	assert.deepEqual(order, ["frame", "plan", "verify"]);
});

test("aggregate sums per gate across tasks and recomputes override rate", () => {
	const t1 = computeTaskMetrics(stateWith("a", ["gate architect: approve", "gate architect: revise"], { tokensSpent: 100 }));
	const t2 = computeTaskMetrics(stateWith("b", ["gate architect: approve", "gate architect: approve"], { tokensSpent: 200 }));
	const agg = aggregate([t1, t2]);
	const arch = agg.gates.find((g) => g.gate === "architect");
	assert.equal(arch.approve, 3);
	assert.equal(arch.revise, 1);
	// (1 + 0) / 4 = 0.25
	assert.equal(arch.overrideRate, 0.25);
	assert.equal(agg.totals.tasks, 2);
	assert.equal(agg.totals.tokensSpent, 300);
	assert.equal(agg.totals.decisions, 4);
	assert.equal(agg.totals.overrides, 1);
	// every canonical gate is present even when it has no decisions
	for (const gate of GATE_ORDER) assert.ok(agg.gates.some((g) => g.gate === gate), `missing gate ${gate}`);
});

test("aggregate sums retries across tasks", () => {
	const t1 = computeTaskMetrics(stateWith("a", ["plan validation failed -> replan 1/2"]));
	const t2 = computeTaskMetrics(stateWith("b", ["plan validation failed -> replan 1/2", "loop iteration 1: FAIL on tests"]));
	const agg = aggregate([t1, t2]);
	assert.equal(agg.totals.retries.replan, 2);
	assert.equal(agg.totals.retries.loop, 1);
});

test("gatherOverrideCases selects only tasks where the gate was overridden", () => {
	const overridden = computeTaskMetrics(stateWith("over", ["gate plan: approve", "gate plan: revise"]));
	const clean = computeTaskMetrics(stateWith("clean", ["gate plan: approve", "gate plan: approve"]));
	const aborted = computeTaskMetrics(stateWith("abort", ["gate plan: abort"]));
	const cases = gatherOverrideCases([overridden, clean, aborted], "plan");
	const slugs = cases.map((c) => c.slug).sort();
	assert.deepEqual(slugs, ["abort", "over"]);
	const over = cases.find((c) => c.slug === "over");
	assert.equal(over.revise, 1);
	assert.equal(over.overrideRate, 0.5);
});

test("gatherOverrideCases is empty for a gate with no decisions anywhere", () => {
	const t = computeTaskMetrics(stateWith("a", ["gate plan: approve"]));
	assert.deepEqual(gatherOverrideCases([t], "verify"), []);
});

test("renderReport produces a markdown table and a per-task section", () => {
	const t1 = computeTaskMetrics(stateWith("a", ["gate architect: revise", "loop iteration 1: FAIL on tests"], { tokensSpent: 100 }));
	const report = renderReport(aggregate([t1]), [t1]);
	assert.match(report, /# slice-flow metrics — 1 task/);
	assert.match(report, /\| gate \| approve \| revise \| abort \| pause \| override rate \|/);
	assert.match(report, /## Retries/);
	assert.match(report, /## Per-task/);
	assert.match(report, /\| a \| done \| 100 \| 1 \|/);
});

test("renderReport handles the empty-tasks case without crashing", () => {
	const report = renderReport(aggregate([]), []);
	assert.match(report, /No tasks found/);
});
