#!/usr/bin/env node
/**
 * web:doctor — verify the Playwright-backed web-research toolchain is installed
 * and working: npm libraries resolvable, a launchable Chrome present, and a
 * live headless render + extract round-trip. Exits 0 (all green) or 1.
 *
 *   npm run web:doctor
 */

const checks = [];
function ok(name, detail = "") { checks.push({ name, pass: true, detail }); }
function bad(name, detail = "") { checks.push({ name, pass: false, detail }); }

async function canImport(spec) {
	try { await import(spec); return true; } catch { return false; }
}

// 1. npm libraries
for (const spec of ["playwright-core", "@mozilla/readability", "linkedom", "turndown"]) {
	(await canImport(spec)) ? ok(`import ${spec}`) : bad(`import ${spec}`, "run: npm install");
}

// 2. Chrome binary + live render round-trip
try {
	const { chromium } = await import("playwright-core");
	const env = process.env;
	const executablePath = env.WEB_RESEARCH_BROWSER_PATH || undefined;
	const channel = executablePath ? undefined : env.WEB_RESEARCH_BROWSER_CHANNEL || "chrome";
	const browser = await chromium.launch({ headless: true, channel, executablePath });
	ok("launch Chrome", executablePath ? `executablePath=${executablePath}` : `channel=${channel}`);
	try {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
		const html = await page.content();
		await ctx.close();
		html.includes("Example Domain")
			? ok("render https://example.com")
			: bad("render https://example.com", "page loaded but expected text missing");
	} finally {
		await browser.close();
	}
} catch (err) {
	bad("launch Chrome", `${err?.message || err}\n   → install with: brew install --cask google-chrome`);
}

// 3. extraction round-trip (pure libs)
try {
	const { extractReadable } = await import("../extensions/lib/web-research/extract.ts");
	const md = extractReadable("<html><body><article><h1>Hi</h1><p>" + "word ".repeat(20) + "</p></article></body></html>", "https://x.test");
	md.length > 0 ? ok("extract Markdown") : bad("extract Markdown", "empty output");
} catch (err) {
	bad("extract Markdown", `${err?.message || err}`);
}

// Report
let failed = 0;
console.log("\nweb-research doctor\n===================");
for (const c of checks) {
	console.log(`${c.pass ? "✅" : "❌"} ${c.name}${c.detail ? `  — ${c.detail}` : ""}`);
	if (!c.pass) failed++;
}
console.log(`\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}`);
process.exit(failed === 0 ? 0 : 1);
