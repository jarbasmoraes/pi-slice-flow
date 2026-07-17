import { test } from "node:test";
import assert from "node:assert/strict";

import {
	computeTaskMetrics,
	aggregate,
	gatherOverrideCases,
	overrideRate,
	renderReport,
	verdictPassRate,
	groupByCohort,
	renderCohortComparison,
	GATE_ORDER,
} from "../extensions/lib/metrics.ts";

/** Build a minimal State-shaped object from a list of event strings. */
function stateWith(slug, events, extra = {}) {
	return {
		slug,
		phase: extra.phase ?? "done",
		tokensSpent: extra.tokensSpent ?? 0,
		realCost: extra.realCost ?? 0,
		cohort: extra.cohort ?? "baseline",
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

test("computeTaskMetrics carries cohort and realCost, defaulting to pre-cohort-tracking/0 when absent", () => {
	const tagged = computeTaskMetrics(stateWith("a", [], { cohort: "opus-tiering-v2", realCost: 1.5 }));
	assert.equal(tagged.cohort, "opus-tiering-v2");
	assert.equal(tagged.realCost, 1.5);
	const untagged = computeTaskMetrics({ slug: "b", phase: "done", tokensSpent: 0, log: [] });
	assert.equal(untagged.cohort, "pre-cohort-tracking");
	assert.equal(untagged.realCost, 0);
});

test("verdictPassRate is the fraction of non-null verdicts that PASS", () => {
	assert.equal(verdictPassRate({ frame: "PASS", plan: "FAIL", verify: "PASS" }), 2 / 3);
	assert.equal(verdictPassRate({ frame: null, plan: null }), 0);
	assert.equal(verdictPassRate({}), 0);
	assert.equal(verdictPassRate({ frame: "PASS" }), 1);
});

test("groupByCohort partitions tasks by cohort in first-seen order", () => {
	const a1 = computeTaskMetrics(stateWith("a1", [], { cohort: "baseline" }));
	const b1 = computeTaskMetrics(stateWith("b1", [], { cohort: "v2" }));
	const a2 = computeTaskMetrics(stateWith("a2", [], { cohort: "baseline" }));
	const groups = groupByCohort([a1, b1, a2]);
	assert.deepEqual([...groups.keys()], ["baseline", "v2"]);
	assert.deepEqual(groups.get("baseline").map((t) => t.slug), ["a1", "a2"]);
	assert.deepEqual(groups.get("v2").map((t) => t.slug), ["b1"]);
});

test("renderCohortComparison is empty when there is only one cohort", () => {
	const t = computeTaskMetrics(stateWith("a", [], { cohort: "baseline" }));
	assert.equal(renderCohortComparison(groupByCohort([t])), "");
	assert.equal(renderCohortComparison(groupByCohort([])), "");
});

test("renderCohortComparison renders a comparison row per cohort with pooled stats", () => {
	const base1 = computeTaskMetrics(stateWith("base1", ["gate plan: revise"], { tokensSpent: 100, realCost: 1 }), { verify: "FAIL" });
	const base2 = computeTaskMetrics(stateWith("base2", ["gate plan: approve"], { tokensSpent: 200, realCost: 2 }), { verify: "PASS" });
	const v2 = computeTaskMetrics(stateWith("v2run", ["gate plan: approve"], { tokensSpent: 50, realCost: 0.5, cohort: "v2" }), { verify: "PASS" });
	const report = renderCohortComparison(groupByCohort([base1, base2, v2]));
	assert.match(report, /## Cohort comparison/);
	// baseline: 2 tasks, avg tokens 150, avg cost $1.5000, override rate 1/2=50%, verdict pass rate 1/2=50%
	assert.match(report, /\| baseline \| 2 \| 150 \| \$1\.5000 \| 50% \| 50% \| 0 \|/);
	// v2: 1 task, avg tokens 50, avg cost $0.5000, override rate 0%, verdict pass rate 100%
	assert.match(report, /\| v2 \| 1 \| 50 \| \$0\.5000 \| 0% \| 100% \| 0 \|/);
});
