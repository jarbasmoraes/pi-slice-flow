import { test } from "node:test";
import assert from "node:assert/strict";

// Node 24 strips types, so these .ts logic modules import directly with no build step.
import {
	assertPublicHttpUrl,
	assertResolvedPublic,
	isBlockedHost,
	isPrivateIpv4,
	isPrivateIpv6,
} from "../extensions/lib/web-research/net-guard.ts";
import { decodeEntities, formatSearchBlock, htmlToText, stripTags, truncate } from "../extensions/lib/web-research/format.ts";
import { ddgTargetUrl, DdgChallengeError, parseHtmlEndpoint, parseLiteEndpoint } from "../extensions/lib/web-research/ddg-parse.ts";
import { DEFAULT_MAX_RESULTS, DEFAULT_PROVIDER, resolveConfig } from "../extensions/lib/web-research/config.ts";
import { availableProviders, ddgProvider, googleProvider, perplexityProvider, selectProvider } from "../extensions/lib/web-research/providers.ts";
import { mapLimit } from "../extensions/lib/web-research/util.ts";

// ---------------------------------------------------------------- net-guard

test("isPrivateIpv4 flags loopback/private/link-local/CGNAT incl. metadata IP", () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
		assert.equal(isPrivateIpv4(ip), true, `${ip} should be private`);
	}
	for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "151.101.1.69"]) {
		assert.equal(isPrivateIpv4(ip), false, `${ip} should be public`);
	}
});

test("isPrivateIpv6 flags loopback/ULA/link-local and mapped v4", () => {
	for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:10.0.0.1"]) {
		assert.equal(isPrivateIpv6(ip), true, `${ip} should be private`);
	}
	assert.equal(isPrivateIpv6("2606:4700:4700::1111"), false);
	assert.equal(isPrivateIpv6("::ffff:8.8.8.8"), false);
});

test("isBlockedHost blocks localhost names and the GCP metadata name", () => {
	assert.equal(isBlockedHost("localhost"), true);
	assert.equal(isBlockedHost("foo.localhost"), true);
	assert.equal(isBlockedHost("metadata.google.internal"), true);
	assert.equal(isBlockedHost("example.com"), false);
});

test("assertPublicHttpUrl rejects bad schemes and private hosts, accepts public https", () => {
	assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), /scheme/);
	assert.throws(() => assertPublicHttpUrl("javascript:alert(1)"), /scheme/);
	assert.throws(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"), /private|loopback|metadata/);
	assert.throws(() => assertPublicHttpUrl("http://localhost:8080/admin"), /private|loopback|metadata/);
	assert.throws(() => assertPublicHttpUrl("not a url"), /valid URL/);
	const ok = assertPublicHttpUrl("https://example.com/docs?q=1");
	assert.equal(ok.host, "example.com");
});

test("assertResolvedPublic catches DNS rebinding to a private IP", () => {
	assert.throws(() => assertResolvedPublic("evil.example", "127.0.0.1"), /private address/);
	assert.doesNotThrow(() => assertResolvedPublic("good.example", "93.184.216.34"));
});

// ------------------------------------------------------------------- format

test("decodeEntities and stripTags clean markup", () => {
	assert.equal(decodeEntities("a &amp; b &lt;x&gt; &quot;q&quot;"), 'a & b <x> "q"');
	assert.equal(stripTags("<b>Hello</b> <i>world</i>"), "Hello world");
});

test("htmlToText keeps title and strips scripts/styles", () => {
	const out = htmlToText("<title>T</title><style>x{}</style><script>bad()</script><p>Body here</p>");
	assert.match(out, /^Title: T/);
	assert.match(out, /Body here/);
	assert.doesNotMatch(out, /bad\(\)/);
});

test("truncate marks oversized content and leaves small content intact", () => {
	assert.deepEqual(truncate("short", 100), { body: "short", truncated: false });
	const t = truncate("x".repeat(50), 10);
	assert.equal(t.truncated, true);
	assert.match(t.body, /TRUNCATED at 10 chars/);
});

test("formatSearchBlock renders numbered results", () => {
	const block = formatSearchBlock("hono", [{ title: "Hono", url: "https://hono.dev", snippet: "fast" }]);
	assert.match(block, /## Results for: hono/);
	assert.match(block, /1\. Hono\n   https:\/\/hono\.dev\n   fast/);
});

// --------------------------------------------------------------- ddg-parse

test("ddgTargetUrl resolves uddg redirect and protocol-relative hrefs", () => {
	assert.equal(ddgTargetUrl("/l/?uddg=https%3A%2F%2Fhono.dev%2Fdocs&rut=x"), "https://hono.dev/docs");
	assert.equal(ddgTargetUrl("//cdn.example.com/x"), "https://cdn.example.com/x");
	assert.equal(ddgTargetUrl("https://plain.example/y"), "https://plain.example/y");
});

test("parseHtmlEndpoint extracts aligned title/url/snippet", () => {
	const html = `
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fa.com">First &amp; Best</a>
    <a class="result__snippet">Snippet one</a>
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fb.com">Second</a>
    <a class="result__snippet">Snippet two</a>`;
	const r = parseHtmlEndpoint(html, 10);
	assert.equal(r.length, 2);
	assert.deepEqual(r[0], { title: "First & Best", url: "https://a.com", snippet: "Snippet one" });
	assert.equal(r[1].url, "https://b.com");
});

test("parseHtmlEndpoint respects maxResults", () => {
	const one = `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fa.com">A</a>`;
	const html = one.repeat(5);
	assert.equal(parseHtmlEndpoint(html, 2).length, 2);
});

test("parseHtmlEndpoint throws DdgChallengeError on a challenge page", () => {
	assert.throws(() => parseHtmlEndpoint("<html>too many requests, please solve the captcha</html>", 5), DdgChallengeError);
});

test("parseHtmlEndpoint throws a markup error when there are no results and no challenge", () => {
	assert.throws(() => parseHtmlEndpoint("<html><body>nothing here</body></html>", 5), /markup may have changed/);
});

test("parseLiteEndpoint parses the lite table markup", () => {
	const html = `
    <a class="result-link" href="/l/?uddg=https%3A%2F%2Fc.com">C site</a>
    <td class="result-snippet">lite snippet</td>`;
	const r = parseLiteEndpoint(html, 10);
	assert.deepEqual(r[0], { title: "C site", url: "https://c.com", snippet: "lite snippet" });
});

// ------------------------------------------------------------------ config

test("resolveConfig defaults with empty env/file", () => {
	const c = resolveConfig({}, null);
	assert.equal(c.provider, DEFAULT_PROVIDER);
	assert.equal(c.maxResults, DEFAULT_MAX_RESULTS);
	assert.equal(c.browser.channel, "chrome");
	assert.equal(c.browser.headless, true);
});

test("resolveConfig: env overrides file; executablePath disables channel", () => {
	const file = { provider: "google", maxResults: 5, browserChannel: "chrome" };
	const env = { WEB_SEARCH_PROVIDER: "perplexity", WEB_RESEARCH_BROWSER_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", WEB_RESEARCH_HEADLESS: "false" };
	const c = resolveConfig(env, file);
	assert.equal(c.provider, "perplexity"); // env wins
	assert.equal(c.maxResults, 5); // from file
	assert.equal(c.browser.channel, undefined); // disabled by explicit path
	assert.match(c.browser.executablePath, /Google Chrome/);
	assert.equal(c.browser.headless, false);
});

test("resolveConfig clamps maxResults into [1,20] and reads API keys", () => {
	assert.equal(resolveConfig({ WEB_SEARCH_MAX_RESULTS: "999" }).maxResults, 20);
	assert.equal(resolveConfig({ WEB_SEARCH_MAX_RESULTS: "0" }).maxResults, 1);
	assert.equal(resolveConfig({ PERPLEXITY_API_KEY: "pplx-x" }).providerOptions.perplexityApiKey, "pplx-x");
});

// --------------------------------------------------------------- providers

test("registry exposes ddg/perplexity/google and selectProvider validates", () => {
	assert.deepEqual(availableProviders().sort(), ["ddg", "google", "perplexity"]);
	assert.equal(selectProvider("DDG").name, "ddg");
	assert.throws(() => selectProvider("bing"), /unknown search provider/);
});

test("ddgProvider.search POSTs the html form then falls back to lite on challenge", async () => {
	// First POST (html endpoint) returns a challenge → provider retries lite.
	const calls = [];
	const postForm = async (url, fields) => {
		calls.push({ url, fields });
		if (url.includes("html.duckduckgo")) return "<html>captcha challenge</html>";
		return `<a class="result-link" href="/l/?uddg=https%3A%2F%2Ffallback.com">Fallback</a><td class="result-snippet">s</td>`;
	};
	const r = await ddgProvider.search("q", { maxResults: 5 }, { postForm });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].fields, { q: "q" }); // query submitted as a form field, not a GET param
	assert.equal(r[0].url, "https://fallback.com");
});

test("ddgProvider.search parses html-endpoint POST results and errors without postForm", async () => {
	const postForm = async () => `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fz.com">Z</a><a class="result__snippet">zs</a>`;
	const r = await ddgProvider.search("q", { maxResults: 5 }, { postForm });
	assert.equal(r[0].url, "https://z.com");
	await assert.rejects(() => ddgProvider.search("q", { maxResults: 5 }, {}), /postForm/);
});

test("perplexityProvider errors without a key, parses citations with a key", async () => {
	await assert.rejects(() => perplexityProvider.search("q", { maxResults: 5 }, { fetchJson: async () => ({}) }), /PERPLEXITY_API_KEY/);
	const fetchJson = async () => ({ citations: ["https://p1.com", "https://p2.com"], choices: [{ message: { content: "answer text" } }] });
	const r = await perplexityProvider.search("q", { maxResults: 5 }, { fetchJson, options: { perplexityApiKey: "k" } });
	assert.equal(r.length, 2);
	assert.equal(r[0].url, "https://p1.com");
	assert.match(r[0].snippet, /answer text/);
});

test("googleProvider errors without key/cx, maps items with them", async () => {
	await assert.rejects(() => googleProvider.search("q", { maxResults: 5 }, { fetchJson: async () => ({}) }), /GOOGLE_API_KEY/);
	const fetchJson = async () => ({ items: [{ title: "G", link: "https://g.com", snippet: "gs" }] });
	const r = await googleProvider.search("q", { maxResults: 5 }, { fetchJson, options: { googleApiKey: "k", googleCx: "cx" } });
	assert.deepEqual(r[0], { title: "G", url: "https://g.com", snippet: "gs" });
});

// ---------------------------------------------------------------- util

test("mapLimit preserves order and respects concurrency", async () => {
	let active = 0;
	let peak = 0;
	const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 5));
		active--;
		return n * 10;
	});
	assert.deepEqual(out, [10, 20, 30, 40, 50]);
	assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed 2`);
});
