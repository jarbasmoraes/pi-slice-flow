/**
 * Pure DuckDuckGo result parsing. We obtain the HTML of the `html.` or `lite.`
 * endpoint (rendered through the headless browser, or plain-fetched as a
 * fallback) and parse it here so the logic is unit-testable from fixtures.
 */

import { stripTags } from "./format.ts";
import type { SearchResult } from "./types.ts";

/** Resolve DDG's `/l/?uddg=<encoded>` redirect links to the real target URL. */
export function ddgTargetUrl(href: string): string {
	const match = href.match(/[?&]uddg=([^&]+)/);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			/* fall through */
		}
	}
	return href.startsWith("//") ? `https:${href}` : href;
}

export class DdgChallengeError extends Error {}

/** Parse the `html.duckduckgo.com/html/` markup. */
export function parseHtmlEndpoint(html: string, maxResults: number): SearchResult[] {
	const anchors = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
	if (anchors.length === 0) {
		if (/challenge|captcha|anomaly|too many requests/i.test(html)) {
			throw new DdgChallengeError("DuckDuckGo rate-limited or challenged this request");
		}
		throw new Error("DuckDuckGo returned a page with no parseable results; the markup may have changed");
	}
	return anchors.slice(0, maxResults).map((a, i) => ({
		title: stripTags(a[2]),
		url: ddgTargetUrl(a[1]),
		snippet: snippets[i] ? stripTags(snippets[i][1]) : "",
	}));
}

/** Parse the simpler `lite.duckduckgo.com/lite/` table markup (fallback). */
export function parseLiteEndpoint(html: string, maxResults: number): SearchResult[] {
	const anchors = [...html.matchAll(/<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)];
	if (anchors.length === 0) {
		if (/challenge|captcha|anomaly|too many requests/i.test(html)) {
			throw new DdgChallengeError("DuckDuckGo (lite) rate-limited or challenged this request");
		}
		throw new Error("DuckDuckGo lite returned no parseable results");
	}
	return anchors.slice(0, maxResults).map((a, i) => ({
		title: stripTags(a[2]),
		url: ddgTargetUrl(a[1]),
		snippet: snippets[i] ? stripTags(snippets[i][1]) : "",
	}));
}
