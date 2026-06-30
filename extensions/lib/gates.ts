/**
 * Human approval gates. Depends only on the narrow slice of the extension
 * context it actually uses (hasUI + ui dialogs), so the engine stays testable
 * and decoupled from Pi's full ExtensionContext.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GateName, SliceFlowConfig } from "./config.ts";

export type GateContext = Pick<ExtensionContext, "hasUI" | "ui">;

export type GateResult = { decision: "approve" | "revise" | "abort" | "pause"; notes?: string };

/**
 * Run a human approval gate. The autonomy policy is consulted first: a gate set
 * to "auto" trusts the phase's own judges/verifiers and advances without asking,
 * even when a UI is present — this is the per-gate path to zero-touch. `frame`
 * is never auto-trusted here (intent is owned by the human). When the gate is
 * still "human", behavior is unchanged: ask if a UI is present, else fall back
 * to `autoApprove` (approve unattended) or pause.
 *
 * `clean` is the trust contract: an automated path (autonomy "auto" OR
 * `autoApprove`) may approve ONLY when the artifact passed its judges/lints.
 * A known-failing artifact (`clean=false`, after retries exhausted) is never
 * rubber-stamped — it falls back to a human, or pauses when none is present, so
 * "FAIL" can never silently ship. This is what makes the autonomy map safe to
 * flip to "auto".
 */
export async function gate(ctx: GateContext, cfg: SliceFlowConfig, title: string, artifact: string, gateId?: GateName, clean = true): Promise<GateResult> {
	const trusted = gateId !== undefined && gateId !== "frame" && cfg.autonomy?.[gateId] === "auto";
	if (trusted && clean) return { decision: "approve" };
	if (!ctx.hasUI) {
		return cfg.autoApprove && clean ? { decision: "approve" } : { decision: "pause" };
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

/**
 * One-time confirm for the detected check-pack risk profile. Deliberately does
 * NOT honor `autoApprove`/`autonomy`: detection is a heuristic and a security
 * profile must only be enabled by an explicit human "yes". A headless run leaves
 * it unconfirmed (checks stay quarantined as warnings); a project enables
 * headless enforcement by committing a manifest with `"confirmed": true`.
 * Returns false when there is no UI or the dialog is dismissed.
 */
export async function askCheckPackConfirm(ctx: GateContext, profile: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	ctx.ui.notify("Review the detected risk profile before enabling check-pack gates.", "info");
	const choice = await ctx.ui.select(`Check-pack risk profile detected. ${profile} Enable these deterministic gates for this project?`, ["Enable check-pack", "Not now"]);
	return choice === "Enable check-pack";
}

export const PAUSE_MSG = (artifact: string, slug?: string) =>
	`PAUSED awaiting human approval of ${artifact}. No approval was captured (no interactive UI, or the dialog was dismissed). ` +
	`Tell the user to review the document and then either call slice_flow({"action":"next"${slug ? `,"slug":"${slug}"` : ""}}) again in an interactive session, ` +
	`or set "autoApprove": true in slice-flow.json for unattended runs. End your turn now.`;
