/**
 * Shared types for the Playwright-backed web-research tools.
 *
 * Providers receive their I/O as injected `ProviderDeps` so the search logic
 * stays pure and unit-testable without a real browser or network.
 */

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchOptions {
	maxResults: number;
}

/** Injected I/O. Providers declare what they need via `SearchProvider.needs`. */
export interface ProviderDeps {
	/** Render a URL in the headless browser and return the page HTML. */
	renderHtml?: (url: string) => Promise<string>;
	/** POST a form (e.g. the DuckDuckGo search form) and return response text. */
	postForm?: (url: string, fields: Record<string, string>) => Promise<string>;
	/** Plain HTTP GET returning response text (no browser). */
	fetchText?: (url: string) => Promise<string>;
	/** HTTP request returning parsed JSON (for API providers). */
	fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
	/** Provider-specific options (API keys, hosts) resolved from config. */
	options?: Record<string, string | undefined>;
}

export interface SearchProvider {
	name: string;
	/** Dep keys this provider requires; used for a clear "not configured" error. */
	needs: Array<keyof ProviderDeps>;
	search(query: string, opts: SearchOptions, deps: ProviderDeps): Promise<SearchResult[]>;
}
