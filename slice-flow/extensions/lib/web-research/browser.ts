/**
 * Headless browser layer (playwright-core + a brew-managed Chrome). A single
 * browser is launched lazily and reused; each call gets a fresh, ephemeral
 * context (no shared cookies, no persistent profile). Requests to private /
 * loopback / metadata hosts are blocked, and heavy resources are skipped.
 *
 * playwright-core does NOT bundle a browser — it drives the system Chrome via
 * `channel: "chrome"` (install with: brew install --cask google-chrome).
 *
 * KNOWN DEBT (DEBT-001): one browser per extension process; see TECH-DEBT.md.
 */

import { lookup } from "node:dns/promises";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import type { BrowserConfig } from "./config.ts";
import { assertPublicHttpUrl, assertResolvedPublic, isBlockedHost } from "./net-guard.ts";

const BLOCK_RESOURCES = new Set(["image", "media", "font"]);
const NAV_TIMEOUT_MS = 30_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(cfg: BrowserConfig): Promise<Browser> {
	if (!browserPromise) {
		browserPromise = chromium.launch({
			headless: cfg.headless,
			channel: cfg.executablePath ? undefined : cfg.channel,
			executablePath: cfg.executablePath,
		});
	}
	return browserPromise;
}

export async function closeBrowser(): Promise<void> {
	if (browserPromise) {
		const b = await browserPromise.catch(() => null);
		browserPromise = null;
		await b?.close().catch(() => {});
	}
}

/** Render a URL and return its HTML, applying the SSRF + resource guards. */
export async function renderHtml(rawUrl: string, cfg: BrowserConfig): Promise<string> {
	const { url, host } = assertPublicHttpUrl(rawUrl);
	// Connect-time resolve guard (DNS rebinding to a private IP).
	try {
		const { address } = await lookup(host);
		assertResolvedPublic(host, address);
	} catch (err) {
		if (err instanceof Error && /private address/.test(err.message)) throw err;
		// lookup failure: let navigation surface the real network error.
	}

	const browser = await getBrowser(cfg);
	const context = await browser.newContext({ acceptDownloads: false, javaScriptEnabled: true, userAgent: UA, viewport: { width: 1280, height: 900 } });
	try {
		await context.route("**/*", (route) => {
			const req = route.request();
			let blocked = false;
			try {
				blocked = isBlockedHost(new URL(req.url()).hostname);
			} catch {
				blocked = true;
			}
			if (blocked || BLOCK_RESOURCES.has(req.resourceType())) return route.abort();
			return route.continue();
		});
		const page = await context.newPage();
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
		await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
		return await page.content();
	} finally {
		await context.close().catch(() => {});
	}
}

/** POST a form and return the response body text (used for the DDG search form). */
export async function postForm(rawUrl: string, fields: Record<string, string>, cfg: BrowserConfig): Promise<string> {
	assertPublicHttpUrl(rawUrl);
	const browser = await getBrowser(cfg);
	const context = await browser.newContext({ userAgent: UA });
	try {
		const resp = await context.request.post(rawUrl, {
			form: fields,
			headers: { "content-type": "application/x-www-form-urlencoded" },
			timeout: NAV_TIMEOUT_MS,
		});
		if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
		return await resp.text();
	} finally {
		await context.close().catch(() => {});
	}
}
