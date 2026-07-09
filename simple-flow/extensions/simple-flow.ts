/**
 * simple-flow — lightweight conversational Todoist task tracker, explicit
 * slash commands only. This entry file is the composition root: slice 001
 * registers `/simple-task`, the only command shipped so far.
 *
 *   lib/config.ts   own defaults + simple-flow.json overlay (never slice-flow's)
 *   lib/state.ts    the single tracked-task record (.simple-flow/state.json)
 *   lib/todoist.ts  fail-loud, unbuffered Composio CLI client
 *
 * Later slices add /simple-comment, /simple-finish, /simple-update,
 * /simple-resume, /simple-status.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./lib/config.ts";
import * as state from "./lib/state.ts";
import { createClient } from "./lib/todoist.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("simple-task", {
		description: "Create a Todoist task in a chosen project and track it (/simple-task <prompt>)",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			if (!cfg.enabled) {
				ctx.ui.notify("simple-flow is disabled; enable it in simple-flow.json.", "warning");
				return;
			}
			const content = args.trim();
			if (!content) {
				ctx.ui.notify("Usage: /simple-task <prompt>", "warning");
				return;
			}
			const client = createClient({ exec: (c, a, o) => pi.exec(c, a, o), debug: cfg.debug });
			try {
				const projects = await client.listProjects();
				if (projects.length === 0) {
					ctx.ui.notify("No Todoist projects found.", "warning");
					return;
				}
				const picked = await ctx.ui.select(
					"Todoist project?",
					projects.map((p) => p.name),
				);
				if (picked === undefined) return;
				const chosen = projects.find((p) => p.name === picked)!;
				let taskId = await client.createTask({ project: chosen.id, content });
				if (taskId === null) {
					const found = await client.findTask(content);
					taskId = found?.taskId ?? null;
				}
				if (taskId === null) {
					ctx.ui.notify("simple-flow: task was created but its id could not be determined; not tracking it. Check Todoist.", "error");
					return;
				}
				state.save(ctx.cwd, { taskId, project: chosen.name, content });
				ctx.ui.notify(`Created and tracking Todoist task ${taskId}.`, "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});

	pi.registerCommand("simple-status", {
		description: "Show the currently tracked Todoist task",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			if (!cfg.enabled) {
				ctx.ui.notify("simple-flow is disabled; enable it in simple-flow.json.", "warning");
				return;
			}
			const tracked = state.load(ctx.cwd);
			if (!tracked) {
				ctx.ui.notify("No tracked task. Run /simple-task or /simple-resume first.", "info");
				return;
			}
			ctx.ui.notify(`Tracking Todoist task ${tracked.taskId} in project "${tracked.project}": ${tracked.content}`, "info");
		},
	});

	pi.registerCommand("simple-comment", {
		description: "Add a comment to the tracked Todoist task (/simple-comment <text>)",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			if (!cfg.enabled) {
				ctx.ui.notify("simple-flow is disabled; enable it in simple-flow.json.", "warning");
				return;
			}
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /simple-comment <text>", "warning");
				return;
			}
			const tracked = state.load(ctx.cwd);
			if (!tracked) {
				ctx.ui.notify("No tracked task. Run /simple-task or /simple-resume first.", "warning");
				return;
			}
			const client = createClient({ exec: (c, a, o) => pi.exec(c, a, o), debug: cfg.debug });
			try {
				await client.comment(tracked.taskId, text);
				ctx.ui.notify(`Added comment to task ${tracked.taskId}.`, "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});

	pi.registerCommand("simple-finish", {
		description: "Close (complete) the tracked Todoist task",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			if (!cfg.enabled) {
				ctx.ui.notify("simple-flow is disabled; enable it in simple-flow.json.", "warning");
				return;
			}
			const tracked = state.load(ctx.cwd);
			if (!tracked) {
				ctx.ui.notify("No tracked task. Run /simple-task or /simple-resume first.", "warning");
				return;
			}
			const client = createClient({ exec: (c, a, o) => pi.exec(c, a, o), debug: cfg.debug });
			try {
				await client.close(tracked.taskId);
				ctx.ui.notify(`Closed Todoist task ${tracked.taskId}.`, "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});
}
