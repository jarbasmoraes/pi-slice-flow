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

const PRIORITY_WORDS: Record<string, number> = { high: 4, medium: 3, low: 2, none: 1 };

/** Maps /simple-update's flags to a fields object with only the flags that
 * were actually present. Pure and exported so it is testable without a UI.
 * `--priority` accepts high/medium/low/none (mapped to Todoist's 1-4 scale,
 * 4 = highest) or a bare integer 1-4; anything else is treated as unset. */
export function parseUpdateArgs(argsStr: string): { content?: string; description?: string; due?: string; priority?: number } {
	const tokens = argsStr.trim().length ? argsStr.trim().split(/\s+/) : [];
	const flagNames = new Set(["--content", "--description", "--due", "--priority"]);
	const fields: { content?: string; description?: string; due?: string; priority?: number } = {};
	let i = 0;
	while (i < tokens.length) {
		const flag = tokens[i];
		if (!flagNames.has(flag)) {
			i++;
			continue;
		}
		i++;
		const valueTokens: string[] = [];
		while (i < tokens.length && !flagNames.has(tokens[i])) {
			valueTokens.push(tokens[i]);
			i++;
		}
		const value = valueTokens.join(" ");
		if (!value) continue;
		if (flag === "--priority") {
			const word = PRIORITY_WORDS[value];
			const num = Number(value);
			if (word !== undefined) fields.priority = word;
			else if (Number.isInteger(num) && num >= 1 && num <= 4) fields.priority = num;
		} else if (flag === "--content") fields.content = value;
		else if (flag === "--description") fields.description = value;
		else if (flag === "--due") fields.due = value;
	}
	return fields;
}

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

	pi.registerCommand("simple-update", {
		description: "Update the tracked task's content/description/due/priority without touching labels (/simple-update --due <text> --priority <high|medium|low|none|1-4>)",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx.cwd);
			if (!cfg.enabled) {
				ctx.ui.notify("simple-flow is disabled; enable it in simple-flow.json.", "warning");
				return;
			}
			const fields = parseUpdateArgs(args);
			if (Object.keys(fields).length === 0) {
				ctx.ui.notify("Usage: /simple-update --content <text> --description <text> --due <text> --priority <high|medium|low|none|1-4>", "warning");
				return;
			}
			const tracked = state.load(ctx.cwd);
			if (!tracked) {
				ctx.ui.notify("No tracked task. Run /simple-task or /simple-resume first.", "warning");
				return;
			}
			const client = createClient({ exec: (c, a, o) => pi.exec(c, a, o), debug: cfg.debug });
			try {
				await client.update(tracked.taskId, fields);
				ctx.ui.notify(`Updated Todoist task ${tracked.taskId}.`, "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});
}
