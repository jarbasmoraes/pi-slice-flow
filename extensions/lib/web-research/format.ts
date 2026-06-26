/**
 * Pure text helpers: HTML entity decoding, tag stripping, a readable-text
 * fallback for when structured extraction is unavailable, output truncation,
 * and search-result formatting. No runtime dependencies — fully unit-testable.
 */

import type { SearchResult } from "./types.ts";

export function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

export function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Best-effort plain-text extraction used when readability is unavailable. */
export function htmlToText(html: string): string {
	const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
	const titleMatch = noScripts.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const body = decodeEntities(
		noScripts.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
	return titleMatch ? `Title: ${stripTags(titleMatch[1])}\n\n${body}` : body;
}

export interface Truncated {
	body: string;
	truncated: boolean;
}

export function truncate(text: string, maxChars: number): Truncated {
	if (text.length <= maxChars) return { body: text, truncated: false };
	return {
		body: `${text.slice(0, maxChars)}\n\n[TRUNCATED at ${maxChars} chars — full content was ${text.length} chars]`,
		truncated: true,
	};
}

export function formatSearchBlock(query: string, results: SearchResult[]): string {
	const lines = results.map(
		(r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
	);
	return [`## Results for: ${query}`, ...lines].join("\n");
}

export function formatSearchFailure(query: string, reason: string): string {
	return `## SEARCH FAILED for: ${query}\nReason: ${reason}`;
}
