/**
 * web-research — Playwright-backed web tools for Pi agents (registerTool only,
 * no bash). Registers `web_search`, `fetch_content`, and `get_search_content`,
 * the trio the pi-subagents `researcher` agent allowlists.
 *
 * Engine split:
 *   - search  → pluggable provider (default `ddg`, rendered through the browser;
 *               `perplexity`/`google` activate when their API key is configured).
 *   - content → always rendered locally with playwright-core + a brew-managed
 *               Chrome, then extracted with Readability. No third-party proxy.
 *
 * Browser binary is system/brew-managed (channel: "chrome"), NOT downloaded by
 * npm. Verify the toolchain with: npm run web:doctor.
 *
 * Failure policy: loud. A challenged search or a blocked page returns an
 * explicit error so research agents record "source unavailable" rather than
 * hallucinate. Security: SSRF guard, ephemeral contexts, no stored credentials.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { postForm, renderHtml } from "./lib/web-research/browser.ts";
import { resolveConfig, type WebResearchConfig } from "./lib/web-research/config.ts";
import { extractReadable } from "./lib/web-research/extract.ts";
import { formatSearchBlock, formatSearchFailure, truncate } from "./lib/web-research/format.ts";
import { assertPublicHttpUrl } from "./lib/web-research/net-guard.ts";
import { selectProvider } from "./lib/web-research/providers.ts";
import type { ProviderDeps, SearchResult } from "./lib/web-research/types.ts";
import { mapLimit } from "./lib/web-research/util.ts";

const DEFAULT_MAX_CHARS = 20_000;
const GET_CONTENT_CONCURRENCY = 3;

function loadConfig(): WebResearchConfig {
	let file: Record<string, unknown> | null = null;
	try {
		file = JSON.parse(readFileSync(join(homedir(), ".pi", "web-research.json"), "utf8"));
	} catch {
		/* no config file — env + defaults */
	}
	return resolveConfig(process.env, file);
}

function providerDeps(cfg: WebResearchConfig): ProviderDeps {
	return {
		renderHtml: (url) => renderHtml(url, cfg.browser),
		postForm: (url, fields) => postForm(url, fields, cfg.browser),
		fetchText: async (url) => {
			assertPublicHttpUrl(url);
			const res = await fetch(url, { headers: { Accept: "text/html" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res.text();
		},
		fetchJson: async (url, init) => {
			assertPublicHttpUrl(url);
			const res = await fetch(url, init);
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300));
			return res.json();
		},
		options: cfg.providerOptions,
	};
}

async function runSearch(query: string, maxResults: number, cfg: WebResearchConfig): Promise<SearchResult[]> {
	const provider = selectProvider(cfg.provider);
	return provider.search(query, { maxResults }, providerDeps(cfg));
}

async function fetchOne(url: string, maxChars: number, cfg: WebResearchConfig): Promise<string> {
	assertPublicHttpUrl(url);
	const html = await renderHtml(url, cfg.browser);
	const text = extractReadable(html, url);
	const { body } = truncate(text, maxChars);
	return body;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via a configurable provider (default DuckDuckGo, rendered headlessly; Perplexity/Google when keyed). " +
			"Accepts multiple queries to cover a topic from several angles; returns title, URL, and snippet per result. " +
			"Use fetch_content to read the full text of promising URLs.",
		parameters: Type.Object({
			queries: Type.Array(Type.String({ description: "A search query" }), {
				minItems: 1,
				maxItems: 5,
				description: "1-5 search queries; use distinct angles instead of one generic query",
			}),
			maxResults: Type.Optional(Type.Number({ description: "Max results per query (default from config, capped at 20)" })),
		}),
		async execute(_id, params) {
			const cfg = loadConfig();
			const maxResults = Math.max(1, Math.min(params.maxResults ?? cfg.maxResults, 20));
			const blocks: string[] = [];
			let failures = 0;
			for (const query of params.queries) {
				try {
					blocks.push(formatSearchBlock(query, await runSearch(query, maxResults, cfg)));
				} catch (err) {
					failures += 1;
					blocks.push(formatSearchFailure(query, err instanceof Error ? err.message : String(err)));
				}
			}
			if (failures === params.queries.length) throw new Error(`All ${failures} searches failed.\n\n${blocks.join("\n\n")}`);
			return { content: [{ type: "text", text: blocks.join("\n\n") }], details: { provider: cfg.provider } };
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch a URL and return its main content as readable Markdown. Renders the page in a headless browser (handles JS) " +
			"and extracts the article with Readability. Output is truncated to a character cap. Private/loopback/metadata hosts are blocked.",
		parameters: Type.Object({
			url: Type.String({ description: "The http(s) URL to fetch" }),
			maxChars: Type.Optional(Type.Number({ description: `Truncate content to this many characters (default ${DEFAULT_MAX_CHARS})` })),
		}),
		async execute(_id, params) {
			const cfg = loadConfig();
			const maxChars = Math.max(1000, Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, 100_000));
			const body = await fetchOne(params.url, maxChars, cfg);
			return { content: [{ type: "text", text: `Source: ${params.url}\n\n${body}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Search + Fetch Content",
		description:
			"Search the web and fetch the readable content of the top results in one step. Returns each source's content as Markdown. " +
			"Use when you want the actual page text behind search hits, not just snippets.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			maxResults: Type.Optional(Type.Number({ description: "How many top results to fetch (default 3, capped at 8)" })),
			maxChars: Type.Optional(Type.Number({ description: `Per-page character cap (default ${DEFAULT_MAX_CHARS})` })),
		}),
		async execute(_id, params) {
			const cfg = loadConfig();
			const n = Math.max(1, Math.min(params.maxResults ?? 3, 8));
			const maxChars = Math.max(1000, Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, 100_000));
			const results = await runSearch(params.query, n, cfg);
			const sources = results.filter((r) => r.url);
			if (sources.length === 0) throw new Error(`No results with fetchable URLs for: ${params.query}`);
			const sections = await mapLimit(sources, GET_CONTENT_CONCURRENCY, async (r) => {
				try {
					const body = await fetchOne(r.url, maxChars, cfg);
					return `## ${r.title || r.url}\nSource: ${r.url}\n\n${body}`;
				} catch (err) {
					return `## ${r.title || r.url}\nSource: ${r.url}\n\n[FETCH FAILED: ${err instanceof Error ? err.message : String(err)}]`;
				}
			});
			return { content: [{ type: "text", text: sections.join("\n\n---\n\n") }], details: { provider: cfg.provider, fetched: sources.length } };
		},
	});
}
