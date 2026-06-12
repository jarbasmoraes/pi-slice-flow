/**
 * slice-flow — six-phase feature development workflow orchestrator.
 *
 * This entry file is the composition root: it registers the `slice_flow`
 * tool, the observability hooks, and the slash commands, and wires them to
 * the modules that do the work:
 *
 *   lib/config.ts      defaults + slice-flow.json overlay
 *   lib/workspace.ts   domain state, paths, and all ./feature-work/ IO
 *   lib/briefs.ts      every spawned agent's prompt text (pure strings)
 *   lib/directives.ts  exact `subagent` tool arguments per workflow step
 *   lib/gates.ts       TUI approval gates (narrow GateContext dependency)
 *   lib/engine.ts      the phase state machine (start/next)
 *
 * Thin by design: all judgment lives in skills, all spawning in pi-subagents
 * (chains for sequential phases, parallel mode for fan-outs). Every spawned
 * agent is a fresh Pi instance; every prompt is inspectable under
 * ./feature-work/logs/; all state persists to ./feature-work/state.json so
 * the workflow survives restarts and /reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadConfig } from "./lib/config.ts";
import type { SliceFlowConfig } from "./lib/config.ts";
import { nextStep, startWorkflow, stopped } from "./lib/engine.ts";
import {
	ensureGitignored,
	isActive,
	loadState,
	logEvent,
	observeSubagentCall,
	observeSubagentResult,
	statusSummary,
	workPaths,
} from "./lib/workspace.ts";
import type { Paths, State } from "./lib/workspace.ts";

interface Workspace {
	cfg: SliceFlowConfig;
	p: Paths;
	state: State | null;
}

function openWorkspace(cwd: string): Workspace {
	const cfg = loadConfig(cwd);
	const p = workPaths(cwd, cfg.workDir);
	return { cfg, p, state: loadState(p) };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "slice_flow",
		label: "Slice Flow",
		description:
			"Orchestrates the slice-flow feature workflow (frame -> architect -> plan -> implement -> verify -> loop). " +
			"Actions: 'start' (requires description) begins a workflow; 'next' validates the last step, runs approval gates, and returns the next directive; " +
			"'status' reports state; 'abort' stops the workflow. Directives contain exact `subagent` tool arguments that MUST be invoked verbatim.",
		promptSnippet: "Drive the slice-flow feature workflow (start/next/status/abort)",
		promptGuidelines: [
			"When a slice_flow directive provides subagent arguments, call the subagent tool with that JSON verbatim, then call slice_flow with action 'next'. Never implement workflow steps yourself.",
		],
		parameters: Type.Object({
			action: StringEnum(["start", "next", "status", "abort"] as const),
			description: Type.Optional(Type.String({ description: "Feature description (required for action 'start')" })),
			note: Type.Optional(Type.String({ description: "Optional context to record in the workflow log" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { cfg, p, state } = openWorkspace(ctx.cwd);

			switch (params.action) {
				case "status": {
					if (!state) {
						return {
							content: [{ type: "text", text: "No slice-flow workflow in this directory. Start one with /feature <description>." }],
							details: {},
						};
					}
					return { content: [{ type: "text", text: statusSummary(p, state) }], details: { state } };
				}

				case "abort": {
					if (!state) throw new Error("No slice-flow workflow to abort.");
					return { content: [{ type: "text", text: stopped(p, state, params.note ?? "aborted via slice_flow tool") }], details: {} };
				}

				case "start": {
					if (!params.description?.trim()) throw new Error("action 'start' requires a non-empty description.");
					if (isActive(state)) {
						throw new Error(
							`A slice-flow workflow is already active (phase: ${state.phase}). Use /feature-resume to continue, ` +
								`slice_flow({"action":"abort"}) to stop it, or delete ${p.root} to start over.`,
						);
					}
					const baseline = await gitBaseline(pi);
					if (cfg.gitignoreWorkDir && baseline !== null) ensureGitignored(ctx.cwd, cfg.workDir);
					const text = startWorkflow(p, cfg, params.description.trim(), baseline);
					return { content: [{ type: "text", text }], details: { phase: "frame" } };
				}

				case "next": {
					if (!state) throw new Error("No slice-flow workflow in this directory. Start one with /feature <description>.");
					if (params.note) logEvent(state, `note: ${params.note}`);
					const text = await nextStep(ctx, p, cfg, state);
					return { content: [{ type: "text", text }], details: { phase: state.phase } };
				}
			}
		},
	});

	// --- Observability hooks: log every actual subagent invocation, and keep a
	// best-effort token estimate for the loop budget. Both no-op when no
	// workflow is active in this cwd, and must never block the workflow.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		try {
			const { p, state } = openWorkspace(ctx.cwd);
			if (isActive(state)) observeSubagentCall(p, event.input);
		} catch {
			/* observability only */
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		try {
			const { p, state } = openWorkspace(ctx.cwd);
			if (isActive(state)) observeSubagentResult(p, state, event.input, event.content);
		} catch {
			/* best-effort accounting only */
		}
	});

	// --- Slash commands --------------------------------------------------------
	pi.registerCommand("feature-status", {
		description: "Show the current slice-flow phase and slice",
		handler: async (_args, ctx) => {
			const { p, state } = openWorkspace(ctx.cwd);
			if (!state) {
				ctx.ui.notify("No slice-flow workflow here. Start one with /feature <description>.", "info");
				return;
			}
			ctx.ui.notify(statusSummary(p, state), "info");
		},
	});

	pi.registerCommand("feature-resume", {
		description: "Resume the slice-flow workflow from persisted state",
		handler: async (_args, ctx) => {
			const { p, state } = openWorkspace(ctx.cwd);
			if (!state) {
				ctx.ui.notify("Nothing to resume: no slice-flow state in this directory.", "warning");
				return;
			}
			if (state.phase === "done") {
				ctx.ui.notify("Workflow already complete. Start a new one with /feature.", "info");
				return;
			}
			if (state.phase === "stopped") {
				ctx.ui.notify(`Workflow was stopped. Inspect ${p.report} or delete ${p.root} to start over.`, "warning");
				return;
			}
			pi.sendUserMessage(
				`Resume the slice-flow feature workflow from persisted state. Call slice_flow({"action":"next"}) now and follow its directives exactly: ` +
					`invoke the subagent tool with the JSON it provides verbatim, then call slice_flow({"action":"next"}) again after each run. ` +
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
