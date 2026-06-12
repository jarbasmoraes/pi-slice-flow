/**
 * web-research — free web access tools for Pi agents, no API keys, no bash.
 *
 * Registers `web_search` (DuckDuckGo HTML endpoint) and `fetch_content`
 * (Jina Reader with a direct-fetch fallback), implemented with Node's native
 * fetch. The tool names deliberately match what pi-subagents' builtin
 * `researcher` agent allowlists (`tools: read, write, web_search,
 * fetch_content, ...`), so installing this package makes that agent work
 * out of the box — and keeps the names compatible with pi-web-access if you
 * ever swap to it for richer backends.
 *
 * Failure policy: loud. A rate-limited search or a blocked page returns an
 * explicit error message, never silently empty results, so research agents
 * can record "source unavailable" instead of hallucinating findings.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_CHARS = 20_000;

// --- Shared plumbing ----------------------------------------------------------

/** Combine the tool-call abort signal with a hard timeout (no AbortSignal.any dependency). */
function timeoutSignal(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${ms}ms`)), ms);
	const onParentAbort = () => ctrl.abort(parent?.reason);
	parent?.addEventListener("abort", onParentAbort, { once: true });
	return {
		signal: ctrl.signal,
		done: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// --- web_search: DuckDuckGo HTML endpoint --------------------------------------

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Resolve DDG's `/l/?uddg=<encoded>` redirect links to the real target URL. */
function ddgTargetUrl(href: string): string {
	const match = href.match(/[?&]uddg=([^&]+)/);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			/* fall through to raw href */
		}
	}
	return href.startsWith("//") ? `https:${href}` : href;
}

async function ddgSearch(query: string, maxResults: number, parentSignal: AbortSignal | undefined): Promise<SearchResult[]> {
	const t = timeoutSignal(parentSignal, SEARCH_TIMEOUT_MS);
	let html: string;
	try {
		const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
			headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
			signal: t.signal,
		});
		if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
		html = await res.text();
	} finally {
		t.done();
	}

	const anchors = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
	if (anchors.length === 0) {
		const blocked = /challenge|captcha|anomaly|too many requests/i.test(html);
		throw new Error(
			blocked
				? "DuckDuckGo rate-limited or challenged this request; retry later or rephrase the query"
				: "DuckDuckGo returned a page with no parseable results; the endpoint markup may have changed",
		);
	}
	return anchors.slice(0, maxResults).map((a, i) => ({
		title: stripTags(a[2]),
		url: ddgTargetUrl(a[1]),
		snippet: snippets[i] ? stripTags(snippets[i][1]) : "",
	}));
}

// --- fetch_content: Jina Reader, then direct fetch -----------------------------

function htmlToText(html: string): string {
	const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
	const titleMatch = noScripts.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const body = decodeEntities(
		noScripts
			.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
	return titleMatch ? `Title: ${stripTags(titleMatch[1])}\n\n${body}` : body;
}

async function fetchViaJina(url: string, parentSignal: AbortSignal | undefined): Promise<string> {
	const t = timeoutSignal(parentSignal, FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: "text/plain" }, signal: t.signal });
		if (!res.ok) throw new Error(`Jina Reader returned HTTP ${res.status}`);
		const text = (await res.text()).trim();
		if (text.length < 40) throw new Error("Jina Reader returned an empty extraction");
		return text;
	} finally {
		t.done();
	}
}

async function fetchDirect(url: string, parentSignal: AbortSignal | undefined): Promise<string> {
	const t = timeoutSignal(parentSignal, FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: t.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const contentType = res.headers.get("content-type") ?? "";
		const raw = await res.text();
		return /html/i.test(contentType) ? htmlToText(raw) : raw.trim();
	} finally {
		t.done();
	}
}

// --- Extension entry ------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web (DuckDuckGo, free, no API key). Accepts multiple queries to cover a topic from several angles; " +
			"returns title, URL, and snippet per result. Use fetch_content to read the full text of promising URLs.",
		parameters: Type.Object({
			queries: Type.Array(Type.String({ description: "A search query" }), {
				minItems: 1,
				maxItems: 5,
				description: "1-5 search queries; use distinct angles instead of one generic query",
			}),
			maxResults: Type.Optional(Type.Number({ description: `Max results per query (default ${DEFAULT_MAX_RESULTS})` })),
		}),
		async execute(_toolCallId, params, signal) {
			const maxResults = Math.max(1, Math.min(params.maxResults ?? DEFAULT_MAX_RESULTS, 20));
			const blocks: string[] = [];
			let failures = 0;
			// Sequential on purpose: parallel hits get the DDG endpoint rate-limited.
			for (const query of params.queries) {
				try {
					const results = await ddgSearch(query, maxResults, signal);
					blocks.push(
						[`## Results for: ${query}`, ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)].join(
							"\n",
						),
					);
				} catch (err) {
					failures += 1;
					blocks.push(`## SEARCH FAILED for: ${query}\nReason: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (failures === params.queries.length) {
				throw new Error(`All ${failures} searches failed.\n\n${blocks.join("\n\n")}`);
			}
			return { content: [{ type: "text", text: blocks.join("\n\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch a URL and return its content as readable text (free, no API key). Tries Jina Reader for clean markdown, " +
			"falls back to a direct fetch with HTML stripped. Output is truncated to a character cap.",
		parameters: Type.Object({
			url: Type.String({ description: "The http(s) URL to fetch" }),
			maxChars: Type.Optional(Type.Number({ description: `Truncate the content to this many characters (default ${DEFAULT_MAX_CHARS})` })),
		}),
		async execute(_toolCallId, params, signal) {
			if (!/^https?:\/\//i.test(params.url)) throw new Error(`fetch_content requires an http(s) URL, got: ${params.url}`);
			const maxChars = Math.max(1000, Math.min(params.maxChars ?? DEFAULT_MAX_CHARS, 100_000));

			let text: string;
			let via: string;
			try {
				text = await fetchViaJina(params.url, signal);
				via = "jina-reader";
			} catch (jinaErr) {
				try {
					text = await fetchDirect(params.url, signal);
					via = "direct-fetch";
				} catch (directErr) {
					throw new Error(
						`Could not fetch ${params.url}. Jina Reader: ${jinaErr instanceof Error ? jinaErr.message : jinaErr}. ` +
							`Direct fetch: ${directErr instanceof Error ? directErr.message : directErr}. Record this source as unavailable.`,
					);
				}
			}

			const truncated = text.length > maxChars;
			const body = truncated ? `${text.slice(0, maxChars)}\n\n[TRUNCATED at ${maxChars} chars — full page was ${text.length} chars]` : text;
			return {
				content: [{ type: "text", text: `Source: ${params.url} (via ${via})\n\n${body}` }],
				details: { via, truncated },
			};
		},
	});
}
