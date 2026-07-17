/**
 * Cross-run observability over the artifacts the workflow already records.
 * Pure analysis: it derives, per gate/phase, how often a judge's verdict was
 * overridden by the human (the signal that decides whether a gate has earned
 * `autonomy: "auto"`), retry tallies, and the best-effort token spend — all
 * from `State.log` and a verdict summary the caller supplies. This module does
 * no IO of its own beyond the data passed in, mirroring config.ts so it stays
 * unit-testable; the read-only `metrics` action wires it to disk via listTasks.
 */

import type { State } from "./workspace.ts";

export type GateDecision = "approve" | "revise" | "abort" | "pause";

/** The human-approval gates, in pipeline order. Mirrors GateName in config.ts;
 * kept local so the metrics core depends only on the domain model. */
export const GATE_ORDER = ["frame", "architect", "prototype", "plan", "verify"] as const;

/** Retry kinds parsed from the `-> ...` event trail. The spec names
 * replan / re-judge / RECONSIDER / fix-up round; recompile and loop are the
 * remaining bounded-retry markers the engine emits, counted for completeness. */
export const RETRY_KINDS = ["recompile", "re-judge", "reconsider", "replan", "fixup", "loop"] as const;
export type RetryKind = (typeof RETRY_KINDS)[number];

export interface GateStat {
	gate: string;
	approve: number;
	revise: number;
	abort: number;
	pause: number;
	/** (revise + abort) / total decisions — the fraction of times a human did
	 * NOT accept the judged artifact as-is. 0 when there were no decisions. */
	overrideRate: number;
}

export interface TaskMetrics {
	slug: string;
	phase: string;
	tokensSpent: number;
	/** Real USD cost summed from subagent usage (0 when unavailable, e.g. async
	 * mode) — a truer efficiency signal than tokensSpent's chars/4 estimate. */
	realCost: number;
	/** cfg.cohort at the time this task started (see config.ts). Tasks persisted
	 * before cohort tracking existed back-fill to "baseline" (loadState). */
	cohort: string;
	gates: GateStat[];
	retries: Record<string, number>;
	/** Verdict files for this task, keyed by name, supplied by the caller's
	 * thin disk adapter (verdictOf). Empty when no adapter is provided. */
	verdicts: Record<string, "PASS" | "FAIL" | null>;
}

export interface Aggregate {
	gates: GateStat[];
	totals: {
		tasks: number;
		tokensSpent: number;
		decisions: number;
		overrides: number;
		retries: Record<string, number>;
	};
}

const GATE_LINE = /^gate (\S+): (approve|revise|abort|pause)$/;

/** Classify a retry/loop event into its kind, or null when the event is not a
 * bounded-retry marker. Matches the exact `-> ...` phrases logEvent emits. */
function classifyRetry(event: string): RetryKind | null {
	if (/-> recompile\b/.test(event)) return "recompile";
	if (/RECONSIDER -> full re-run/.test(event)) return "reconsider";
	if (/-> re-judge\b/.test(event)) return "re-judge";
	if (/-> replan\b/.test(event)) return "replan";
	if (/fix-up round\b/.test(event)) return "fixup";
	if (/^loop iteration \d+:/.test(event)) return "loop";
	return null;
}

/** A zeroed GateStat for a gate. */
function emptyGate(gate: string): GateStat {
	return { gate, approve: 0, revise: 0, abort: 0, pause: 0, overrideRate: 0 };
}

/** (revise + abort) / total; 0 when there are no decisions. */
export function overrideRate(g: Pick<GateStat, "approve" | "revise" | "abort" | "pause">): number {
	const total = g.approve + g.revise + g.abort + g.pause;
	return total === 0 ? 0 : (g.revise + g.abort) / total;
}

/**
 * Derive per-gate decision counts, retry tallies, and token spend for one task
 * from its persisted state. Pure: it reads only `state` plus an optional
 * verdict summary the caller assembled from disk, so it is fully unit-testable.
 */
export function computeTaskMetrics(state: State, verdicts: Record<string, "PASS" | "FAIL" | null> = {}): TaskMetrics {
	const byGate = new Map<string, GateStat>();
	const retries: Record<string, number> = {};
	for (const entry of state.log ?? []) {
		// Prefer the structured kind/payload (typed logging); fall back to regex
		// over the human string for entries persisted before typed logging existed.
		if (entry.kind === "gate" && entry.payload) {
			const { gate, decision } = entry.payload as { gate?: string; decision?: string };
			if (gate && (decision === "approve" || decision === "revise" || decision === "abort" || decision === "pause")) {
				const stat = byGate.get(gate) ?? emptyGate(gate);
				stat[decision] += 1;
				byGate.set(gate, stat);
				continue;
			}
		}
		if (entry.kind === "retry" && entry.payload) {
			const { retryKind } = entry.payload as { retryKind?: string };
			if (retryKind && (RETRY_KINDS as readonly string[]).includes(retryKind)) {
				retries[retryKind] = (retries[retryKind] ?? 0) + 1;
				continue;
			}
		}
		const event = entry.event;
		const gm = GATE_LINE.exec(event);
		if (gm) {
			const [, gate, decision] = gm;
			const stat = byGate.get(gate) ?? emptyGate(gate);
			stat[decision as GateDecision] += 1;
			byGate.set(gate, stat);
			continue;
		}
		const rk = classifyRetry(event);
		if (rk) retries[rk] = (retries[rk] ?? 0) + 1;
	}
	for (const stat of byGate.values()) stat.overrideRate = overrideRate(stat);

	// Stable ordering: canonical gates first (in pipeline order), then any
	// unexpected gate id, so a report column never reshuffles between runs.
	const order = (g: string): number => {
		const i = (GATE_ORDER as readonly string[]).indexOf(g);
		return i === -1 ? GATE_ORDER.length : i;
	};
	const gates = [...byGate.values()].sort((a, b) => order(a.gate) - order(b.gate) || a.gate.localeCompare(b.gate));

	return {
		slug: state.slug,
		phase: state.phase,
		tokensSpent: state.tokensSpent ?? 0,
		realCost: state.realCost ?? 0,
		cohort: state.cohort ?? "pre-cohort-tracking",
		gates,
		retries,
		verdicts,
	};
}

/** Fraction of this task's non-null verdicts that are PASS — 0 when every
 * verdict is null (no verify/review artifact found yet) or there are none. */
export function verdictPassRate(verdicts: Record<string, "PASS" | "FAIL" | null>): number {
	const decided = Object.values(verdicts).filter((v): v is "PASS" | "FAIL" => v !== null);
	if (decided.length === 0) return 0;
	return decided.filter((v) => v === "PASS").length / decided.length;
}

/** Partition tasks by `cohort` (see config.ts), preserving first-seen order so
 * a comparison table reads oldest-cohort-first without re-sorting by name. */
export function groupByCohort(tasks: TaskMetrics[]): Map<string, TaskMetrics[]> {
	const groups = new Map<string, TaskMetrics[]>();
	for (const t of tasks) {
		const group = groups.get(t.cohort);
		if (group) group.push(t);
		else groups.set(t.cohort, [t]);
	}
	return groups;
}

/**
 * Sum per-gate decisions and retries across every task. The aggregated
 * override rate per gate is the number that decides an `auto` flip: a gate the
 * human accepted as-is on every run is a candidate; one the human keeps
 * overriding is not.
 */
export function aggregate(tasks: TaskMetrics[]): Aggregate {
	const byGate = new Map<string, GateStat>();
	for (const gate of GATE_ORDER) byGate.set(gate, emptyGate(gate));
	const retries: Record<string, number> = {};
	let tokensSpent = 0;

	for (const t of tasks) {
		tokensSpent += t.tokensSpent;
		for (const g of t.gates) {
			const stat = byGate.get(g.gate) ?? emptyGate(g.gate);
			stat.approve += g.approve;
			stat.revise += g.revise;
			stat.abort += g.abort;
			stat.pause += g.pause;
			byGate.set(g.gate, stat);
		}
		for (const [kind, n] of Object.entries(t.retries)) retries[kind] = (retries[kind] ?? 0) + n;
	}

	let decisions = 0;
	let overrides = 0;
	for (const stat of byGate.values()) {
		stat.overrideRate = overrideRate(stat);
		decisions += stat.approve + stat.revise + stat.abort + stat.pause;
		overrides += stat.revise + stat.abort;
	}

	return {
		gates: [...byGate.values()],
		totals: { tasks: tasks.length, tokensSpent, decisions, overrides, retries },
	};
}

/** Tasks where the given gate carries at least one human override (revise or
 * abort). Pure over the computed metrics — the selection logic the `reflect`
 * action mines for rubric-tuning cases. */
export interface OverrideCase {
	slug: string;
	gate: string;
	approve: number;
	revise: number;
	abort: number;
	pause: number;
	overrideRate: number;
}

export function gatherOverrideCases(tasks: TaskMetrics[], gate: string): OverrideCase[] {
	const cases: OverrideCase[] = [];
	for (const t of tasks) {
		const g = t.gates.find((x) => x.gate === gate);
		if (!g) continue;
		if (g.revise + g.abort === 0) continue;
		cases.push({ slug: t.slug, gate, approve: g.approve, revise: g.revise, abort: g.abort, pause: g.pause, overrideRate: g.overrideRate });
	}
	return cases;
}

const pct = (r: number): string => `${(r * 100).toFixed(0)}%`;

/** A one-row-per-cohort comparison: tasks, avg tokens, avg real cost, overall
 * gate-override rate, pooled verdict pass rate, and total retries. Reuses
 * `aggregate` per group so the per-gate math stays in one place — this adds
 * only the side-by-side framing a single global `aggregate` can't give. Empty
 * string when there is only one cohort (nothing to compare yet), so callers
 * can unconditionally append it without an extra branch. Cohorts render in
 * first-seen order, matching `groupByCohort`. */
export function renderCohortComparison(tasksByCohort: Map<string, TaskMetrics[]>): string {
	if (tasksByCohort.size <= 1) return "";
	const lines: string[] = [];
	lines.push("## Cohort comparison");
	lines.push("");
	lines.push("Did the last change to slice-flow help or hurt? Cohorts default to slice-flow's released version (package.json) — bumping it at each release starts a new one automatically. Override `cohort` in slice-flow.json only for a finer-grained tag within one version.");
	lines.push("");
	lines.push("| cohort | tasks | avg tokens | avg real cost | override rate | verdict pass rate | retries |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- |");
	for (const [cohort, tasks] of tasksByCohort) {
		const agg = aggregate(tasks);
		const avgTokens = Math.round(agg.totals.tokensSpent / tasks.length);
		const avgCost = tasks.reduce((sum, t) => sum + t.realCost, 0) / tasks.length;
		const allVerdicts = tasks.flatMap((t) => Object.values(t.verdicts)).filter((v): v is "PASS" | "FAIL" => v !== null);
		const passRate = allVerdicts.length === 0 ? "n/a" : pct(allVerdicts.filter((v) => v === "PASS").length / allVerdicts.length);
		const overrideRatePooled = agg.totals.decisions === 0 ? "n/a" : pct(agg.totals.overrides / agg.totals.decisions);
		const totalRetries = Object.values(agg.totals.retries).reduce((n, c) => n + c, 0);
		lines.push(`| ${cohort} | ${tasks.length} | ${avgTokens} | $${avgCost.toFixed(4)} | ${overrideRatePooled} | ${passRate} | ${totalRetries} |`);
	}
	return lines.join("\n");
}

/** A compact markdown report: per-gate aggregated decisions + override rate,
 * aggregated retries, and a per-task token/phase line. */
export function renderReport(agg: Aggregate, perTask: TaskMetrics[]): string {
	const lines: string[] = [];
	lines.push(`# slice-flow metrics — ${agg.totals.tasks} task${agg.totals.tasks === 1 ? "" : "s"}`);
	lines.push("");
	if (agg.totals.tasks === 0) {
		lines.push("No tasks found under the work directory yet.");
		return lines.join("\n");
	}

	lines.push("## Per-gate decisions (aggregated across all tasks)");
	lines.push("");
	lines.push("| gate | approve | revise | abort | pause | override rate |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const g of agg.gates) {
		lines.push(`| ${g.gate} | ${g.approve} | ${g.revise} | ${g.abort} | ${g.pause} | ${pct(g.overrideRate)} |`);
	}
	lines.push("");
	lines.push(`Totals: ${agg.totals.decisions} gate decision(s), ${agg.totals.overrides} override(s), ~${agg.totals.tokensSpent} tokens across ${agg.totals.tasks} task(s).`);
	lines.push("");

	const retryKinds = Object.keys(agg.totals.retries).sort();
	lines.push("## Retries (aggregated)");
	lines.push("");
	if (retryKinds.length === 0) {
		lines.push("No bounded-retry rounds recorded.");
	} else {
		lines.push("| kind | count |");
		lines.push("| --- | --- |");
		for (const kind of retryKinds) lines.push(`| ${kind} | ${agg.totals.retries[kind]} |`);
	}
	lines.push("");

	lines.push("## Per-task");
	lines.push("");
	lines.push("| slug | phase | tokens (est) | overrides |");
	lines.push("| --- | --- | --- | --- |");
	for (const t of perTask) {
		const overrides = t.gates.reduce((n, g) => n + g.revise + g.abort, 0);
		lines.push(`| ${t.slug} | ${t.phase} | ${t.tokensSpent} | ${overrides} |`);
	}

	return lines.join("\n");
}
