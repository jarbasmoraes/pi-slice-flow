/**
 * Readable-content extraction. Parses page HTML with linkedom, runs Mozilla
 * Readability to isolate the main article, and converts it to Markdown with
 * Turndown. Falls back to the dependency-free `htmlToText` cleaner when
 * Readability finds no article (e.g. non-article pages).
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { htmlToText } from "./format.ts";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export function extractReadable(html: string, url: string): string {
	try {
		const { document } = parseHTML(html);
		// Readability needs a base URL to resolve relative links.
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();
		if (article?.content) {
			const md = turndown.turndown(article.content).trim();
			const title = article.title ? `# ${article.title}\n\n` : "";
			if (md.length >= 40) return `${title}${md}`;
		}
	} catch {
		/* fall through to plain-text */
	}
	return htmlToText(html);
}
