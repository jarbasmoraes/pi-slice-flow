/**
 * Human approval gates. Depends only on the narrow slice of the extension
 * context it actually uses (hasUI + ui dialogs), so the engine stays testable
 * and decoupled from Pi's full ExtensionContext.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SliceFlowConfig } from "./config.ts";

export type GateContext = Pick<ExtensionContext, "hasUI" | "ui">;

export type GateResult = { decision: "approve" | "revise" | "abort" | "pause"; notes?: string };

export async function gate(ctx: GateContext, cfg: SliceFlowConfig, title: string, artifact: string): Promise<GateResult> {
	if (!ctx.hasUI) {
		return cfg.autoApprove ? { decision: "approve" } : { decision: "pause" };
	}
	ctx.ui.notify(`Review ${artifact}`, "info");
	const choice = await ctx.ui.select(title, ["Approve and continue", "Request changes", "Abort workflow"]);
	if (choice === undefined) return { decision: "pause" };
	if (choice === "Approve and continue") return { decision: "approve" };
	if (choice === "Abort workflow") {
		const sure = await ctx.ui.confirm("Abort slice-flow?", "State stays on disk; /feature-resume cannot continue an aborted run.");
		return sure ? { decision: "abort" } : { decision: "pause" };
	}
	const notes = await ctx.ui.input("What should change?", "Describe the revisions you want");
	if (!notes || !notes.trim()) return { decision: "pause" };
	return { decision: "revise", notes: notes.trim() };
}

/** Ask which UI shape phase 3 should take; null when no answer was captured. */
export async function askUiShape(ctx: GateContext, cfg: SliceFlowConfig): Promise<"none" | "greenfield" | "existing" | null> {
	if (!ctx.hasUI) return cfg.autoApprove ? "none" : null;
	const choice = await ctx.ui.select("Does this feature involve UI work?", [
		"No UI",
		"New UI (greenfield) — run prototype fan-out",
		"Existing UI — conform to current design patterns",
	]);
	if (choice === undefined) return null;
	return choice.startsWith("No UI") ? "none" : choice.startsWith("New UI") ? "greenfield" : "existing";
}

export const PAUSE_MSG = (artifact: string) =>
	`PAUSED awaiting human approval of ${artifact}. No approval was captured (no interactive UI, or the dialog was dismissed). ` +
	`Tell the user to review the document and then either call slice_flow({"action":"next"}) again in an interactive session, ` +
	`or set "autoApprove": true in slice-flow.json for unattended runs. End your turn now.`;
