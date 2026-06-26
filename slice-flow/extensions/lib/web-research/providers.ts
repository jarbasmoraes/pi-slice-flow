/**
 * Pluggable search providers. Each provider receives injected I/O (browser
 * render / fetch) so the logic is unit-testable with fakes. Default is `ddg`
 * (free, browser-rendered). API providers (Perplexity, Google CSE) activate
 * when their key is configured. Add new engines by registering here.
 */

import { DdgChallengeError, parseHtmlEndpoint, parseLiteEndpoint } from "./ddg-parse.ts";
import type { ProviderDeps, SearchOptions, SearchProvider, SearchResult } from "./types.ts";

const ddgProvider: SearchProvider = {
	name: "ddg",
	needs: ["postForm"],
	async search(query, opts, deps): Promise<SearchResult[]> {
		// DuckDuckGo's html/lite endpoints require a POST form submission; a GET is
		// bounced to the homepage as an anomaly. POST returns clean result markup.
		if (!deps.postForm) throw new Error("ddg provider needs postForm");
		try {
			return parseHtmlEndpoint(await deps.postForm("https://html.duckduckgo.com/html/", { q: query }), opts.maxResults);
		} catch (err) {
			if (err instanceof DdgChallengeError) {
				// Fall back to the lite endpoint, challenged less aggressively.
				return parseLiteEndpoint(await deps.postForm("https://lite.duckduckgo.com/lite/", { q: query }), opts.maxResults);
			}
			throw err;
		}
	},
};

const perplexityProvider: SearchProvider = {
	name: "perplexity",
	needs: ["fetchJson"],
	async search(query, opts, deps): Promise<SearchResult[]> {
		const key = deps.options?.perplexityApiKey;
		if (!key) throw new Error("perplexity provider requires PERPLEXITY_API_KEY (or perplexityApiKey in config)");
		if (!deps.fetchJson) throw new Error("perplexity provider needs fetchJson");
		const data = (await deps.fetchJson("https://api.perplexity.ai/chat/completions", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "sonar",
				messages: [{ role: "user", content: query }],
				return_related_questions: false,
			}),
		})) as { citations?: string[]; choices?: Array<{ message?: { content?: string } }> };
		const answer = data.choices?.[0]?.message?.content ?? "";
		const citations = data.citations ?? [];
		const results: SearchResult[] = citations.slice(0, opts.maxResults).map((url, i) => ({
			title: `Citation ${i + 1}`,
			url,
			snippet: i === 0 ? answer.slice(0, 400) : "",
		}));
		if (results.length === 0 && answer) results.push({ title: "Perplexity answer", url: "", snippet: answer.slice(0, 800) });
		return results;
	},
};

const googleProvider: SearchProvider = {
	name: "google",
	needs: ["fetchJson"],
	async search(query, opts, deps): Promise<SearchResult[]> {
		const key = deps.options?.googleApiKey;
		const cx = deps.options?.googleCx;
		if (!key || !cx) throw new Error("google provider requires GOOGLE_API_KEY and GOOGLE_SEARCH_CX");
		if (!deps.fetchJson) throw new Error("google provider needs fetchJson");
		const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(opts.maxResults, 10)}`;
		const data = (await deps.fetchJson(url)) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
		return (data.items ?? []).slice(0, opts.maxResults).map((it) => ({
			title: it.title ?? "",
			url: it.link ?? "",
			snippet: it.snippet ?? "",
		}));
	},
};

const REGISTRY: Record<string, SearchProvider> = {
	ddg: ddgProvider,
	perplexity: perplexityProvider,
	google: googleProvider,
};

export function availableProviders(): string[] {
	return Object.keys(REGISTRY);
}

export function selectProvider(name: string): SearchProvider {
	const p = REGISTRY[name.toLowerCase()];
	if (!p) throw new Error(`unknown search provider "${name}"; available: ${availableProviders().join(", ")}`);
	return p;
}

export { ddgProvider, googleProvider, perplexityProvider };
export type { ProviderDeps, SearchOptions };
