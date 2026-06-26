/**
 * SSRF guard: reject non-http(s) schemes and URLs whose host is a loopback,
 * private, link-local, CGNAT, or cloud-metadata address. Literal-IP and
 * known-name checks are pure and unit-tested here; DNS-rebinding (a public
 * name resolving to a private IP) needs a connect-time resolve, done in the
 * browser layer via `assertResolvedPublic`.
 */

function ipv4ToParts(ip: string): number[] | null {
	const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const parts = m.slice(1).map(Number);
	if (parts.some((p) => p > 255)) return null;
	return parts;
}

export function isPrivateIpv4(ip: string): boolean {
	const p = ipv4ToParts(ip);
	if (!p) return false;
	const [a, b] = p;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // 10/8
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
	if (a === 192 && b === 168) return true; // 192.168/16
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
	if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0/24
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
	if (a === 255 && b === 255 && p[2] === 255 && p[3] === 255) return true; // broadcast
	return false;
}

export function isPrivateIpv6(ip: string): boolean {
	const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "::1" || h === "::") return true; // loopback / unspecified
	if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true; // link-local / ULA
	const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (mapped) return isPrivateIpv4(mapped[1]);
	return false;
}

export function isBlockedHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h === "metadata.google.internal") return true;
	if (h.includes(":")) return isPrivateIpv6(h);
	if (ipv4ToParts(h)) return isPrivateIpv4(h);
	return false; // a normal hostname; resolution checked at connect time
}

export interface SafeUrl {
	url: string;
	host: string;
}

/** Validate scheme + host. Throws on a blocked or malformed URL. */
export function assertPublicHttpUrl(raw: string): SafeUrl {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`not a valid URL: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`blocked non-http(s) URL scheme: ${parsed.protocol}`);
	}
	if (isBlockedHost(parsed.hostname)) {
		throw new Error(`blocked private/loopback/metadata host: ${parsed.hostname}`);
	}
	return { url: parsed.toString(), host: parsed.hostname };
}

/** Connect-time check for a resolved IP (guards DNS rebinding). */
export function assertResolvedPublic(host: string, resolvedIp: string): void {
	const blocked = resolvedIp.includes(":") ? isPrivateIpv6(resolvedIp) : isPrivateIpv4(resolvedIp);
	if (blocked) throw new Error(`host ${host} resolved to a private address ${resolvedIp}`);
}
