/**
 * Cross-family judge routing. slice-flow is Claude-judging-Claude end to end, and
 * Claude carries a confirmed self-preference bias when scoring its own family's
 * output. Where a *different* model family is available, routing the judge to it
 * dodges that bias; where it is not (the common Claude-only case), we degrade
 * cleanly — keep the configured judge, attach a caveat, and rely on position-swap
 * for the comparative judges.
 *
 * Pure classification (`modelFamily`, `resolveJudge`) is separated from the CLI
 * probe (`detectJudgeFamilies`) so routing is testable without a subprocess.
 */

/** A narrow command runner: only the exit code is consulted. */
type ExecProbe = (cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{ code: number }>;

export type JudgeFamilyMode = "cross" | "same";

/** Coarse model-family token from a model id, for self-preference reasoning.
 * `anthropic/claude-opus-4-8` → `claude`; `openai-codex/gpt-5.5` → `gpt`;
 * `google-gemini/...` → `gemini`; local `qwen`/`gemma` keep their name. A null
 * spec (session default) resolves to `claude`: this project's builders run on
 * Claude unless explicitly overridden, so the default judge IS same-family. */
export function modelFamily(id: string | null | undefined): string {
	if (!id) return "claude";
	const s = id.toLowerCase();
	if (s.includes("claude")) return "claude";
	if (s.includes("gpt")) return "gpt";
	if (s.includes("gemini")) return "gemini";
	if (s.includes("qwen")) return "qwen";
	if (s.includes("gemma")) return "gemma";
	return s.split("/")[0] || "unknown";
}

/** Registry of non-host judge families: the CLI whose presence signals the family
 * is usable, and the model id to route to. Mirrors codegraph's `which` probe.
 * Listed in preference order when several are available. Extend with one entry
 * per family as more provider CLIs are supported. */
export const JUDGE_FAMILY_REGISTRY: Array<{ family: string; cli: string; model: string }> = [{ family: "gpt", cli: "codex", model: "openai-codex/gpt-5.5" }];

export interface JudgeResolution {
	/** The resolved judge model (null = inherit the session default). */
	model: string | null;
	/** True when the judge's family differs from the builder's. */
	crossed: boolean;
	/** Set when cross-family was wanted but no other family was available. */
	caveat?: string;
}

/**
 * Pure: pick a judge model whose family differs from the builder's, when the mode
 * asks for it and a different family is available. Degradation order:
 *   - mode "same": configured model unchanged.
 *   - configured judge is already cross-family: keep it.
 *   - another family is available: route the judge to it.
 *   - host family only (e.g. Claude-only): keep configured + caveat.
 */
export function resolveJudge(configuredJudge: string | null, builderModel: string | null, availableFamilies: Set<string>, mode: JudgeFamilyMode): JudgeResolution {
	const builderFam = modelFamily(builderModel);
	if (mode === "same") return { model: configuredJudge, crossed: modelFamily(configuredJudge) !== builderFam };
	if (modelFamily(configuredJudge) !== builderFam) return { model: configuredJudge, crossed: true };
	// Routable cross-family targets: the host family `claude` (via the session
	// default, model null) when the builder is NOT claude, then any registry
	// family whose CLI is present. First match wins (registry order is preference).
	const targets: Array<{ family: string; model: string | null }> = [];
	if (builderFam !== "claude" && availableFamilies.has("claude")) targets.push({ family: "claude", model: null });
	for (const r of JUDGE_FAMILY_REGISTRY) if (r.family !== builderFam && availableFamilies.has(r.family)) targets.push({ family: r.family, model: r.model });
	if (targets.length > 0) return { model: targets[0].model, crossed: true };
	return {
		model: configuredJudge,
		crossed: false,
		caveat: `only the ${builderFam} family is available; self-preference bias is not mitigated by family diversity (position-swap applied to comparative judges)`,
	};
}

/** Probe which judge families are available (their CLI on PATH), mirroring
 * detectCodegraph. The host family `claude` is always present; any thrown error
 * on a probe is treated as "absent" so a hostile environment degrades to
 * Claude-only rather than crashing startup. */
export async function detectJudgeFamilies(exec: ExecProbe): Promise<string[]> {
	const found = new Set<string>(["claude"]);
	for (const r of JUDGE_FAMILY_REGISTRY) {
		try {
			const res = await exec("which", [r.cli], { timeout: 5000 });
			if (res.code === 0) found.add(r.family);
		} catch {
			/* absent */
		}
	}
	return [...found];
}

/** Deterministically rotate a candidate list so the first-presented candidate
 * varies run-to-run, cancelling a judge's first-position bias without randomness
 * (which would break resume). The rotation offset is the run `seq`, so the order
 * is stable within a run yet differs across runs and retries. */
export function positionSwap<T>(items: T[], seq: number): T[] {
	if (items.length <= 1) return items.slice();
	const off = ((seq % items.length) + items.length) % items.length;
	return [...items.slice(off), ...items.slice(0, off)];
}
