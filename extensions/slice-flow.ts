/**
 * slice-flow — six-phase feature development workflow orchestrator.
 *
 * This entry file is the composition root: it registers the `slice_flow`
 * tool, the observability hooks, and the slash commands, and wires them to
 * the modules that do the work:
 *
 *   lib/config.ts      defaults + slice-flow.json overlay
 *   lib/workspace.ts   domain state, paths, and all .pi/task/<slug>/ IO
 *   lib/briefs.ts      every spawned agent's prompt text (pure strings)
 *   lib/directives.ts  exact `subagent` tool arguments per workflow step
 *   lib/gates.ts       TUI approval gates (narrow GateContext dependency)
 *   lib/engine.ts      the phase state machine (start/next)
 *
 * Thin by design: all judgment lives in skills, all spawning in pi-subagents
 * (chains for sequential phases, parallel mode for fan-outs). Every spawned
 * agent is a fresh Pi instance; every prompt is inspectable under
 * .pi/task/<slug>/logs/; all state persists to .pi/task/<slug>/state.json so
 * the workflow survives restarts and /reload. Several tasks can be active at
 * once — each in its own slug folder — and actions target one via the `slug`
 * parameter (or, when only one task is active, by default).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { applyTier, DEFAULT_CONFIG, loadConfig } from "./lib/config.ts";
import { getTelemetry } from "./lib/telemetry.ts";
import { getTodoist } from "./lib/todoist.ts";
import type { SliceFlowConfig } from "./lib/config.ts";
import { converge, nextStep, provisionCheckPack, setupTodoistStart, setupWorktree, startAttack, startReflect, startResearch, startWorkflow, stopped, syncBundledAgents } from "./lib/engine.ts";
import { hasProjectProfile, profileStaleNudge, runInit } from "./lib/init.ts";
import { detectCodegraph } from "./lib/codegraph.ts";
import { detectJudgeFamilies } from "./lib/judge-family.ts";
import { REFLECT_RUBRICS } from "./lib/directives.ts";
import { aggregate, computeTaskMetrics, groupByCohort, renderCohortComparison, renderReport } from "./lib/metrics.ts";
import {
	allocateSlug,
	ensureGitignored,
	appendTelemetryDebug,
	inferTaskSlug,
	isActive,
	listTasks,
	loadState,
	logEvent,
	observeSubagentCall,
	observeSubagentResult,
	sumUsage,
	resolveActiveTask,
	statusSummary,
	taskVerdictSummary,
	workPaths,
} from "./lib/workspace.ts";
import type { Paths, State } from "./lib/workspace.ts";

interface Workspace {
	cfg: SliceFlowConfig;
	p: Paths | null;
	state: State | null;
	slug: string | null;
}

/**
 * Resolve which task an action operates on. An explicit slug targets that task;
 * otherwise the single active task is used. Throws a directive-friendly error
 * when the slug is unknown or several tasks are active at once. Returns a
 * null-path workspace when there is no task at all (callers handle that).
 */
function openTask(cwd: string, slug?: string): Workspace {
	const cfg = loadConfig(cwd);
	const res = resolveActiveTask(cwd, cfg.workDir, slug);
	switch (res.kind) {
		case "none":
			return { cfg, p: null, state: null, slug: null };
		case "ambiguous":
			throw new Error(
				`Multiple slice-flow tasks are active: ${res.active.join(", ")}. ` +
					`Add "slug" to target one, e.g. slice_flow({"action":"status","slug":"${res.active[0]}"}).`,
			);
		case "missing": {
			const known = listTasks(cwd, cfg.workDir).map((t) => t.slug);
			throw new Error(
				`No slice-flow task "${res.slug}" under ${cfg.workDir}/.` + (known.length ? ` Known tasks: ${known.join(", ")}.` : " Start one with /feature."),
			);
		}
		case "ok": {
			const p = workPaths(cwd, cfg.workDir, res.slug);
			const state = loadState(p);
			// Re-derive the task's tiered config so every action (next/attack/
			// research/converge) uses the models the task was started with. Falls
			// back to the config default for pre-tier tasks (state.tier undefined).
			return { cfg: applyTier(cfg, state?.tier ?? cfg.defaultTier), p, state, slug: res.slug };
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "slice_flow",
		label: "Slice Flow",
		description:
			"Orchestrates the slice-flow feature workflow (frame -> architect -> plan -> implement -> verify -> loop). " +
			"Each task lives in its own .pi/task/<slug>/ folder and several can be active at once. " +
			"Actions: 'start' (requires description, unless todoist:'pick' adopts a Todoist task whose title stands in) begins a new task and returns its slug (optional 'tier': easy|medium|hard scales the model used across every phase, fixed for the task's lifetime); 'next' validates the last step, runs approval gates, and returns the next directive; " +
			"'status' reports state; 'abort' stops the task. During frame exploration only: 'research' (requires questions) fans out web researchers, " +
			"'attack' spawns fresh adversaries against the draft framing, 'converge' compiles the decision ledger into the frame document. " +
			"Cross-run, read-only: 'metrics' aggregates per-gate override rates, retries, and token spend across all tasks, plus a per-cohort comparison table when more than one cohort exists — cohorts default to slice-flow's own released version (package.json), so each release is a comparable before/after group automatically; " +
			"'reflect' spawns a fresh judge to propose rubric-skill edits from real human-override cases (proposals only, never auto-applied). " +
			"Project setup: 'init' captures this repo's profile into .slice-flow/PROJECT.md (drafted by a fresh scout, human-confirmed) and finishes the check-pack manifest; run it once via /feature-init. " +
			"Pass 'slug' to target a specific task; it is required only when more than one task is active. " +
			"Directives contain exact `subagent` tool arguments that MUST be invoked verbatim.",
		promptSnippet: "Drive the slice-flow feature workflow (start/next/status/abort; research/attack/converge during frame exploration)",
		promptGuidelines: [
			"When a slice_flow directive provides subagent arguments, call the subagent tool with that JSON verbatim, then call slice_flow with action 'next'. Never implement workflow steps yourself.",
			"Each task has a slug (returned by 'start' and echoed in every directive). Pass that same \"slug\" on every follow-up call so the right task advances when several are active.",
			"During the frame explore stage you act as the framing partner (framing-partner skill): converse with the user, maintain the decision ledger, and use the research/attack/converge actions.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "next", "status", "abort", "research", "attack", "converge", "metrics", "reflect", "init"] as const),
			description: Type.Optional(Type.String({ description: "Feature description (required for action 'start')" })),
			slug: Type.Optional(
				Type.String({ description: "Task folder to target (.pi/task/<slug>/). Required when more than one task is active; ignored by 'start'." }),
			),
			questions: Type.Optional(
				Type.Array(Type.String(), { description: "Research questions, one per researcher agent (required for action 'research')" }),
			),
			note: Type.Optional(Type.String({ description: "Optional context to record in the workflow log" })),
			todoist: Type.Optional(
				StringEnum(["create", "pick"] as const, {
					description:
						"Todoist start mode (action 'start' only): 'create' creates a new Todoist task for this run (/feature-todo-create); " +
						"'pick' lists projects and their active tasks and adopts the chosen one (/feature-todo-start; description optional — the adopted task's text stands in).",
				}),
			),
			judge: Type.Optional(
				Type.String({ description: `Gate/judge to reflect on for action 'reflect' (one of ${Object.keys(REFLECT_RUBRICS).join(", ")}); omit to reflect on all.` }),
			),
			tier: Type.Optional(
				StringEnum(["easy", "medium", "hard"] as const, {
					description:
						"Capability tier for action 'start' (one task): scales the model used in every phase. " +
						"'easy' caps at a cheap workhorse (lowest cost); 'medium' is the balanced baseline; " +
						"'hard' fans SOTA flagship models across the pipeline (highest cost/quality). " +
						"Omit to use the configured defaultTier. Fixed for the task's lifetime once set.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// `start` allocates a brand-new slug folder, so it never resolves an
			// existing task; every other action targets one via openTask.
			if (params.action === "start") {
				const cfg = loadConfig(ctx.cwd);
				// /feature-todo-start ("pick") adopts an existing Todoist task FIRST so
				// its title can stand in for a missing description; every other start
				// requires an explicit description (it names the run and, on the
				// "create" path, titles the new Todoist task).
				let todoist: Awaited<ReturnType<typeof setupTodoistStart>> = null;
				if (params.todoist === "pick") {
					todoist = await setupTodoistStart(ctx, cfg, (c, a, o) => pi.exec(c, a, o), params.description?.trim() ?? "", "pick");
				}
				const description = params.description?.trim() || todoist?.title?.trim();
				if (!description) {
					throw new Error(
						params.todoist === "pick"
							? "No Todoist task was adopted and no description was given. Pick a task, or start with /feature <description>."
							: "action 'start' requires a non-empty description.",
					);
				}
				const baseline = await gitBaseline(pi);
				// Judge families come from pi's own model registry (provider auth), not
				// a CLI probe: pi runs e.g. openai-codex/gpt-5.5 natively. Local (http)
				// endpoints additionally need a liveness probe — /v1/models on the
				// OpenAI-compat surface — so an offline LAN server drops its family. A
				// registry failure degrades to Claude-only rather than blocking start.
				let judgeFamilies: string[];
				try {
					judgeFamilies = await detectJudgeFamilies(ctx.modelRegistry.getAvailable(), async (baseUrl) => {
						const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(1500) });
						return res.ok;
					});
				} catch {
					judgeFamilies = ["claude"];
				}
				if (cfg.gitignoreWorkDir && baseline !== null) ensureGitignored(ctx.cwd, cfg.workDir);
				const slug = allocateSlug(ctx.cwd, cfg.workDir, description);
				const p = workPaths(ctx.cwd, cfg.workDir, slug);
				const isolation = await setupWorktree(ctx, (c, a, o) => pi.exec(c, a, o), cfg, ctx.cwd, slug, baseline);
				// Provision the per-project check-pack against the tree the build/verify
				// will actually run in (the worktree when isolated), so the manifest and
				// any human-filled params land where the run reads them.
				const auditCwd = isolation?.worktree?.cwd ?? ctx.cwd;
				// Detect codegraph against that same run tree (not ctx.cwd): the worktree
				// has no checked-in .codegraph/, so reachability is an ancestor walk up to
				// the repo root — keeping the "ready" announcement honest about what the
				// build/scout agents can actually query.
				const codegraphState = await detectCodegraph(auditCwd, (c, a, o) => pi.exec(c, a, o), ctx.cwd);
				const checkLine = await provisionCheckPack(ctx, cfg, auditCwd, new Date().toISOString());
				// "pick" already adopted its task above (before slug allocation); the
				// other modes run the Todoist setup here — "create" pre-answers the
				// create/adopt question, undefined asks it as before.
				if (params.todoist !== "pick") {
					todoist = await setupTodoistStart(ctx, cfg, (c, a, o) => pi.exec(c, a, o), description, params.todoist);
				}
				// An adopted task's content+description+comments seeds the run's feature
				// description; the push path (or no Todoist) leaves it as the human's
				// literal description. Slug/paths above are allocated from the raw
				// description (or the adopted task's title), independent of this seed,
				// so folder naming stays stable.
				const feature = todoist?.seed?.trim() || description;
				const tier = params.tier ?? cfg.defaultTier;
				const text = startWorkflow(p, cfg, feature, slug, baseline, ctx.cwd, codegraphState, isolation, judgeFamilies, todoist ?? undefined, tier);
				await getTelemetry(cfg, ctx.cwd).flush();
				await getTodoist(cfg, (c, a, o) => pi.exec(c, a, o)).flush();
				// Profile affordance (UI banner, not the pure startWorkflow preamble):
				// no profile → first-run capture tip; a captured-but-drifted profile →
				// staleness nudge to refresh; a fresh profile → nothing.
				const initTip = hasProjectProfile(ctx.cwd)
					? await profileStaleNudge(ctx.cwd, baseline, cfg, (c, a, o) => pi.exec(c, a, o))
					: "Tip: run /feature-init once to capture this project's profile (domain, invariants, conventions) so every phase inherits it instead of rediscovering it.";
				const startText = [text, checkLine, initTip].filter((s) => s).join("\n");
				return { content: [{ type: "text", text: startText }], details: { phase: "frame", slug } };
			}

			// Cross-run actions aggregate over every task, so they bypass openTask
			// (which targets a single task and throws when several are active).
			if (params.action === "metrics") {
				const cfg = loadConfig(ctx.cwd);
				const tasks = listTasks(ctx.cwd, cfg.workDir);
				const perTask = tasks.map((t) => {
					const p = workPaths(ctx.cwd, cfg.workDir, t.slug);
					return computeTaskMetrics(t.state, taskVerdictSummary(p));
				});
				const cohortSection = renderCohortComparison(groupByCohort(perTask));
				const report = [renderReport(aggregate(perTask), perTask), cohortSection].filter((s) => s).join("\n\n");
				return { content: [{ type: "text", text: report }], details: { tasks: tasks.map((t) => t.slug) } };
			}

			if (params.action === "reflect") {
				const cfg = loadConfig(ctx.cwd);
				const text = startReflect(ctx.cwd, cfg, params.judge);
				return { content: [{ type: "text", text }], details: { judge: params.judge ?? "all" } };
			}

			// Project-level setup, not task-bound: draft + confirm the per-project
			// profile (.slice-flow/PROJECT.md) and finish the check-pack manifest.
			// Two-stage relay keyed off the draft file (see lib/init.ts).
			if (params.action === "init") {
				const cfg = loadConfig(ctx.cwd);
				// init can run before the first /feature, so provision the bundled
				// agents here too — the scout it dispatches must exist in .pi/agents/.
				syncBundledAgents(ctx.cwd);
				const baseline = await gitBaseline(pi);
				const text = await runInit(ctx, cfg, ctx.cwd, baseline);
				return { content: [{ type: "text", text }], details: {} };
			}

			const noTaskHint = "No slice-flow task here. Start one with /feature <description>.";
			const { cfg, p, state, slug } = openTask(ctx.cwd, params.slug);

			switch (params.action) {
				case "status": {
					if (!state || !p) {
						const tasks = listTasks(ctx.cwd, cfg.workDir);
						if (tasks.length === 0) return { content: [{ type: "text", text: noTaskHint }], details: {} };
						const lines = tasks.map((t) => `- ${t.slug}: ${t.state.phase}`).join("\n");
						return { content: [{ type: "text", text: `Tasks:\n${lines}\n\nPass "slug" to inspect one.` }], details: { tasks: tasks.map((t) => t.slug) } };
					}
					return { content: [{ type: "text", text: statusSummary(p, state) }], details: { state, slug } };
				}

				case "abort": {
					if (!state || !p) throw new Error("No slice-flow task to abort.");
					// Prime the memoized client with exec BEFORE stopped(), which calls
					// getTodoist(cfg) internally; otherwise a fresh process memoizes a
					// NOOP and the stopped label/comment are silently discarded.
					getTodoist(cfg, (c, a, o) => pi.exec(c, a, o));
					const text = stopped(p, state, params.note ?? "aborted via slice_flow tool", cfg);
					await getTelemetry(cfg, ctx.cwd).flush();
					await getTodoist(cfg, (c, a, o) => pi.exec(c, a, o)).flush();
					return { content: [{ type: "text", text }], details: { slug } };
				}

				case "next": {
					if (!state || !p) throw new Error(noTaskHint);
					if (params.note) logEvent(state, `note: ${params.note}`);
					const text = await nextStep(ctx, p, cfg, state, (c, a, o) => pi.exec(c, a, o), ctx.cwd);
					await getTelemetry(cfg, ctx.cwd).flush();
					await getTodoist(cfg, (c, a, o) => pi.exec(c, a, o)).flush();
					return { content: [{ type: "text", text }], details: { phase: state.phase, slug } };
				}

				// --- Frame explore-stage actions (the parent session is the framing partner) ---
				case "research": {
					if (!state || !p) throw new Error(noTaskHint);
					const questions = (params.questions ?? []).map((q) => q.trim()).filter((q) => q.length > 0);
					if (questions.length === 0) throw new Error(`action 'research' requires a non-empty "questions" array.`);
					if (params.note) logEvent(state, `note: ${params.note}`);
					return { content: [{ type: "text", text: startResearch(p, cfg, state, questions) }], details: { phase: state.phase, slug } };
				}

				case "attack": {
					if (!state || !p) throw new Error(noTaskHint);
					if (params.note) logEvent(state, `note: ${params.note}`);
					return { content: [{ type: "text", text: startAttack(p, cfg, state) }], details: { phase: state.phase, slug } };
				}

				case "converge": {
					if (!state || !p) throw new Error(noTaskHint);
					if (params.note) logEvent(state, `note: ${params.note}`);
					return { content: [{ type: "text", text: converge(p, cfg, state) }], details: { phase: state.phase, slug } };
				}
			}
		},
	});

	// --- Observability hooks: log every actual subagent invocation, and keep a
	// best-effort token estimate for the loop budget. Both no-op when no
	// workflow is active in this cwd, and must never block the workflow.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		// Resolve workDir once, defensively, so the error path can record without
		// re-running loadConfig (which is what may have thrown in the first place).
		let workDir = DEFAULT_CONFIG.workDir;
		try {
			const cfg = loadConfig(ctx.cwd);
			workDir = cfg.workDir;
			const slug = inferTaskSlug(ctx.cwd, cfg.workDir, event.input);
			if (!slug) {
				appendTelemetryDebug(ctx.cwd, workDir, { event: "unattributed-subagent-call" });
				return;
			}
			const p = workPaths(ctx.cwd, cfg.workDir, slug);
			const state = loadState(p);
			if (!isActive(state)) return;
			observeSubagentCall(p, event.input);
			// Open the Langfuse observation for this directive (no-op when telemetry
			// is off). Id derives from the persisted pending directive so the close
			// in tool_result resolves the same observation, even across a /reload.
			if (state.pending && state.telemetry?.traceId) {
				getTelemetry(cfg, ctx.cwd).observation({
					id: `${slug}:${state.pending.seq}:${state.pending.kind}`,
					traceId: state.telemetry.traceId,
					name: state.pending.label,
					startTime: new Date().toISOString(),
					input: event.input,
					metadata: { phase: state.phase, kind: state.pending.kind, seq: state.pending.seq, cohort: state.cohort },
				});
			}
		} catch (e) {
			// Observability only — never block the workflow, but no longer invisible.
			appendTelemetryDebug(ctx.cwd, workDir, { event: "hook-error", hook: "tool_call", error: String(e) });
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		let workDir = DEFAULT_CONFIG.workDir;
		try {
			const cfg = loadConfig(ctx.cwd);
			workDir = cfg.workDir;
			const slug = inferTaskSlug(ctx.cwd, cfg.workDir, event.input);
			if (!slug) {
				appendTelemetryDebug(ctx.cwd, workDir, { event: "unattributed-subagent-result" });
				return;
			}
			const p = workPaths(ctx.cwd, cfg.workDir, slug);
			const state = loadState(p);
			if (!isActive(state)) return;
			observeSubagentResult(p, state, event.input, event.content, event.details);
			if (state.pending && state.telemetry?.traceId) {
				const out = (event.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n").slice(0, 50_000);
				const usage = sumUsage(event.details);
				const tel = getTelemetry(cfg, ctx.cwd);
				tel.observation({
					id: `${slug}:${state.pending.seq}:${state.pending.kind}`,
					traceId: state.telemetry.traceId,
					endTime: new Date().toISOString(),
					output: out,
					...(usage
						? {
								usageDetails: { input: usage.input, output: usage.output, total: usage.input + usage.output },
								costDetails: { total: usage.cost },
							}
						: {}),
				});
				await tel.flush();
				await getTodoist(cfg, (c, a, o) => pi.exec(c, a, o)).flush();
			}
		} catch (e) {
			appendTelemetryDebug(ctx.cwd, workDir, { event: "hook-error", hook: "tool_result", error: String(e) });
		}
	});

	// --- Slash commands --------------------------------------------------------
	pi.registerCommand("feature-status", {
		description: "Show slice-flow tasks and their phase; copy a task's exact name to target it (optionally: /feature-status <name>)",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const want = args.trim();
			const tasks = listTasks(ctx.cwd, cfg.workDir);
			if (tasks.length === 0) {
				ctx.ui.notify("No slice-flow tasks here. Start one with /feature <description>.", "info");
				return;
			}
			const shown = want ? tasks.filter((t) => t.slug === want) : tasks;
			if (shown.length === 0) {
				ctx.ui.notify(`No task "${want}". Known: ${tasks.map((t) => t.slug).join(", ")}.`, "warning");
				return;
			}
			const summary = shown.map((t) => statusSummary(workPaths(ctx.cwd, cfg.workDir, t.slug), t.state)).join("\n");
			ctx.ui.notify(summary, "info");
		},
	});

	pi.registerCommand("feature-resume", {
		description: "Resume a slice-flow task from persisted state; copy the exact task name from /feature-status (optionally: /feature-resume <name>)",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			const want = args.trim();
			const tasks = listTasks(ctx.cwd, cfg.workDir);
			const resumable = tasks.filter((t) => isActive(t.state));
			if (tasks.length === 0) {
				ctx.ui.notify("Nothing to resume: no slice-flow tasks in this directory.", "warning");
				return;
			}
			let target = want ? tasks.find((t) => t.slug === want) : resumable.length === 1 ? resumable[0] : undefined;
			if (!target && !want) {
				ctx.ui.notify(
					resumable.length === 0
						? "No active task to resume. /feature-status lists all tasks."
						: `Several tasks are active: ${resumable.map((t) => t.slug).join(", ")}. Run /feature-resume <slug>.`,
					"warning",
				);
				return;
			}
			if (!target) {
				ctx.ui.notify(`No task "${want}". Known: ${tasks.map((t) => t.slug).join(", ")}.`, "warning");
				return;
			}
			const p = workPaths(ctx.cwd, cfg.workDir, target.slug);
			if (target.state.phase === "done") {
				ctx.ui.notify(`Task "${target.slug}" is already complete. Start a new one with /feature.`, "info");
				return;
			}
			if (target.state.phase === "stopped") {
				ctx.ui.notify(`Task "${target.slug}" was stopped. Inspect ${p.report} or delete ${p.root} to start over.`, "warning");
				return;
			}
			pi.sendUserMessage(
				`Resume the slice-flow task "${target.slug}" from persisted state. Call slice_flow({"action":"next","slug":"${target.slug}"}) now and follow its directives exactly: ` +
					`invoke the subagent tool with the JSON it provides verbatim, then call slice_flow({"action":"next","slug":"${target.slug}"}) again after each run. ` +
					`If artifacts from the interrupted step are missing, the tool will re-issue that step automatically.`,
			);
		},
	});
}

async function gitBaseline(pi: ExtensionAPI): Promise<string | null> {
	try {
		const res = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
		return res.code === 0 ? res.stdout.trim() : null;
	} catch {
		// Not a git repo — verifiers fall back to plain `git diff` / file reads.
		return null;
	}
}
