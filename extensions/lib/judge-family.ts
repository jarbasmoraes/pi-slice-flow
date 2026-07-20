/**
 * Cross-family judge routing. slice-flow is Claude-judging-Claude end to end, and
 * Claude carries a confirmed self-preference bias when scoring its own family's
 * output. Where a *different* model family is available, routing the judge to it
 * dodges that bias; where it is not (the true Claude-only case), we degrade
 * cleanly — keep the configured judge, attach a caveat, and rely on position-swap
 * for the comparative judges.
 *
 * Availability comes from the host's model registry (models with configured
 * provider auth), NOT from provider CLIs on PATH: pi runs non-Claude models
 * natively (e.g. openai-codex/gpt-5.5 through its own provider auth), so a
 * standalone CLI is neither required nor evidence of anything. Everything here
 * is pure so routing is testable without a live registry.
 */

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

/** Cost tier of the judge step being routed: `strong` for gate/verify judging,
 * `cheap` for regression re-checks whose whole point is a lower-cost model. */
export type JudgeTier = "strong" | "cheap";

/** Registry of non-host judge families and the model ids to route to — `model`
 * for strong judging, and an optional `cheapModel` for cost-sensitive judge
 * steps (regression re-checks), so cross-routing doesn't silently promote a
 * cheap tier to a strong one. A family counts as available when its `model` is
 * runnable per the host's model registry (auth is per-provider, so the cheap
 * sibling is available whenever the strong one is). Listed in preference order
 * PER TIER: `tiers` restricts an entry to specific tiers (absent = both), so a
 * weaker-but-free family can lead the cheap tier without ever being handed
 * strong judging. Extend with one entry per family. */
export const JUDGE_FAMILY_REGISTRY: Array<{ family: string; model: string; cheapModel?: string; tiers?: JudgeTier[] }> = [
	// Local LAN server (jarbass-macbook-pro, free marginal cost): trusted with
	// regression re-checks only — never with gate/verify judging. The *thinking
	// coder* is chosen over the faster a3b-instruct sibling on hard evidence: on
	// a realistic buried security regression (a loop fix that also weakened a
	// tenant check from `String(a) !== String(b)` to `a != b`), the instruct
	// model gave a false PASS 3/3 at temp 0 — a stable blind spot — while the
	// coder caught it and did not over-flag a benign refactor (4/4). A regression
	// re-check exists precisely to catch a fix that regressed a passing
	// dimension, so reliability beats the instruct model's ~25x lower latency:
	// re-checks run in parallel and the loop is bounded to a few iterations. The
	// deterministic check-pack remains the non-model security backstop.
	{ family: "qwen", model: "ollama/qwen3.6-coder:latest", tiers: ["cheap"] },
	// gpt-5.6-sol is the current codex frontier (5.5's successor); terra is the
	// same-generation workhorse tier — both ride the ChatGPT-subscription OAuth.
	{ family: "gpt", model: "openai-codex/gpt-5.6-sol", cheapModel: "openai-codex/gpt-5.6-terra" },
];

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
 *   - another family is available: route the judge to it (at the requested tier).
 *   - host family only (e.g. Claude-only): keep configured + caveat.
 */
export function resolveJudge(configuredJudge: string | null, builderModel: string | null, availableFamilies: Set<string>, mode: JudgeFamilyMode, tier: JudgeTier = "strong"): JudgeResolution {
	const builderFam = modelFamily(builderModel);
	if (mode === "same") return { model: configuredJudge, crossed: modelFamily(configuredJudge) !== builderFam };
	if (modelFamily(configuredJudge) !== builderFam) return { model: configuredJudge, crossed: true };
	// Routable cross-family targets: the host family `claude` (via the session
	// default, model null) when the builder is NOT claude, then any registry
	// family whose CLI is present. First match wins (registry order is preference).
	const targets: Array<{ family: string; model: string | null }> = [];
	if (builderFam !== "claude" && availableFamilies.has("claude")) targets.push({ family: "claude", model: null });
	for (const r of JUDGE_FAMILY_REGISTRY) {
		if (r.family === builderFam || !availableFamilies.has(r.family)) continue;
		if (r.tiers && !r.tiers.includes(tier)) continue;
		targets.push({ family: r.family, model: tier === "cheap" ? (r.cheapModel ?? r.model) : r.model });
	}
	if (targets.length > 0) return { model: targets[0].model, crossed: true };
	return {
		model: configuredJudge,
		crossed: false,
		caveat: `only the ${builderFam} family is available; self-preference bias is not mitigated by family diversity (position-swap applied to comparative judges)`,
	};
}

/** Which judge families are available, derived from the host's model registry
 * (`modelRegistry.getAvailable()` — models whose provider auth is configured).
 * The host family `claude` is always present (builders run on the session
 * default); a registry family is present when its exact route model is
 * runnable. A plain-`http://` baseUrl marks a local/LAN server whose static
 * auth entry proves nothing about liveness — when a `probeEndpoint` is given,
 * such a family also needs its endpoint to answer, so an offline server drops
 * the family instead of feeding judges to a dead socket. Hosted (`https://`)
 * providers are taken on auth alone. */
export async function detectJudgeFamilies(
	availableModels: ReadonlyArray<{ provider: string; id: string; baseUrl?: string }>,
	probeEndpoint?: (baseUrl: string) => Promise<boolean>,
): Promise<string[]> {
	const byId = new Map(availableModels.map((m) => [`${m.provider}/${m.id}`, m]));
	const found = new Set<string>(["claude"]);
	for (const r of JUDGE_FAMILY_REGISTRY) {
		const m = byId.get(r.model);
		if (!m) continue;
		if (m.baseUrl?.startsWith("http://") && probeEndpoint) {
			try {
				if (!(await probeEndpoint(m.baseUrl))) continue;
			} catch {
				continue; /* unreachable = absent, never fatal */
			}
		}
		found.add(r.family);
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
