/**
 * Resolve web-research configuration from environment variables overlaid on an
 * optional `~/.pi/web-research.json` file. Pure: callers pass the env object and
 * the parsed file object, so this is unit-testable with no filesystem access.
 *
 * Precedence: env var > config file > built-in default.
 */

export interface BrowserConfig {
	/** Playwright launch channel (default "chrome" → brew-installed Google Chrome). */
	channel?: string;
	/** Explicit browser executable path; overrides channel when set. */
	executablePath?: string;
	headless: boolean;
}

export interface WebResearchConfig {
	provider: string;
	maxResults: number;
	browser: BrowserConfig;
	/** Provider-specific options (API keys, hosts). */
	providerOptions: Record<string, string | undefined>;
}

export const DEFAULT_PROVIDER = "ddg";
export const DEFAULT_MAX_RESULTS = 8;

type Env = Record<string, string | undefined>;
type FileCfg = Record<string, unknown> | null | undefined;

function pick(env: Env, file: FileCfg, envKey: string, fileKey: string): string | undefined {
	if (env[envKey] != null && env[envKey] !== "") return env[envKey];
	const v = file?.[fileKey];
	if (typeof v === "string" && v !== "") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return undefined;
}

export function resolveConfig(env: Env = {}, file: FileCfg = null): WebResearchConfig {
	const provider = (pick(env, file, "WEB_SEARCH_PROVIDER", "provider") ?? DEFAULT_PROVIDER).toLowerCase();

	const maxRaw = pick(env, file, "WEB_SEARCH_MAX_RESULTS", "maxResults");
	const maxParsed = maxRaw ? Number.parseInt(maxRaw, 10) : DEFAULT_MAX_RESULTS;
	const maxResults = Number.isFinite(maxParsed) ? Math.max(1, Math.min(maxParsed, 20)) : DEFAULT_MAX_RESULTS;

	const executablePath = pick(env, file, "WEB_RESEARCH_BROWSER_PATH", "browserExecutablePath");
	const channel = pick(env, file, "WEB_RESEARCH_BROWSER_CHANNEL", "browserChannel") ?? "chrome";
	const headless = (pick(env, file, "WEB_RESEARCH_HEADLESS", "headless") ?? "true") !== "false";

	return {
		provider,
		maxResults,
		browser: { channel: executablePath ? undefined : channel, executablePath, headless },
		providerOptions: {
			perplexityApiKey: pick(env, file, "PERPLEXITY_API_KEY", "perplexityApiKey"),
			exaApiKey: pick(env, file, "EXA_API_KEY", "exaApiKey"),
			googleApiKey: pick(env, file, "GOOGLE_API_KEY", "googleApiKey"),
			googleCx: pick(env, file, "GOOGLE_SEARCH_CX", "googleCx"),
		},
	};
}
