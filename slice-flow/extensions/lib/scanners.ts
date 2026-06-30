/**
 * Pure deterministic scanners — the Tier-B layer's engine. Each scanner takes a
 * list of already-read source files plus filled template params and returns
 * structured findings. No IO, no model, no subprocess: file collection lives in
 * the caller (checks.ts), so these stay trivially unit-testable and are the same
 * code path the newron backtest exercises.
 *
 * The two scanners shipped here are faithful ports of real, blind-spot-catching
 * gates from a sibling project:
 *   - scanTenantPredicate ← newron's scripts/check-tenant-scope.mjs (the gate
 *     that held the fix for a P0 cross-tenant data leak).
 *   - scanBannedTokens    ← newron's markdown.guard.test.ts (XSS escape-vector
 *     ban-list for markdown renderers).
 *
 * They are parameterized ("templates with holes"): the generic pattern ships
 * here; the project-specific params (tenant labels, banned tokens, file globs)
 * are filled by detect-stack and persisted in the check-pack manifest.
 */

/** One already-read source file. `path` is repo-relative for stable findings. */
export interface SourceFile {
	path: string;
	text: string;
}

/** A located finding. `line` is 1-indexed; `message` is human-readable. */
export interface ScanFinding {
	path: string;
	line: number;
	message: string;
}

// --- tenant-predicate scanner -------------------------------------------------

/** Filled holes for the tenant-predicate template. `labels` are the tenant-scoped
 * query labels (e.g. graph node labels) that MUST carry a tenant predicate in the
 * same query literal; an empty list disables the scanner (nothing to enforce).
 * `predicateFields` are the property names that count as a tenant predicate. The
 * remaining holes have generic defaults but can be overridden per project. */
export interface TenantPredicateParams {
	labels: string[];
	/** Property names accepted as a tenant predicate. */
	predicateFields?: string[];
	/** Comment marker (without `//`) that opts a literal out, e.g. "@tenant-safe". */
	safeAnnotation?: string;
}

const DEFAULT_PREDICATE_FIELDS = ["externalUserId", "ownerId", "userId"];
const DEFAULT_SAFE_ANNOTATION = "@tenant-safe";

/**
 * Walk a file character-by-character, extracting backtick template literals while
 * skipping JS line/block comments and quoted strings — so a backtick span inside
 * a `//` comment is never parsed as a query. Faithful port of newron's extractor.
 * Returns `{ body, startLine }` tuples (startLine 1-indexed at the opening tick).
 */
function extractTemplateLiterals(text: string): Array<{ body: string; startLine: number }> {
	const out: Array<{ body: string; startLine: number }> = [];
	const N = text.length;
	let i = 0;
	let line = 1;
	while (i < N) {
		const ch = text[i];
		const next = text[i + 1];
		// Line comment — skip to newline.
		if (ch === "/" && next === "/") {
			while (i < N && text[i] !== "\n") i++;
			continue;
		}
		// Block comment — skip to */ (counting newlines).
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < N && !(text[i] === "*" && text[i + 1] === "/")) {
				if (text[i] === "\n") line++;
				i++;
			}
			i += 2;
			continue;
		}
		// Quoted string — skip to matching quote (respecting escapes).
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			while (i < N && text[i] !== quote) {
				if (text[i] === "\\") {
					i += 2;
					continue;
				}
				if (text[i] === "\n") line++;
				i++;
			}
			i++;
			continue;
		}
		// Template literal — capture body until closing backtick.
		if (ch === "`") {
			const startLine = line;
			i++;
			let buf = "";
			while (i < N && text[i] !== "`") {
				if (text[i] === "\\") {
					buf += text[i];
					i++;
					if (i < N) {
						buf += text[i];
						if (text[i] === "\n") line++;
						i++;
					}
					continue;
				}
				if (text[i] === "\n") line++;
				buf += text[i];
				i++;
			}
			i++; // consume closing backtick
			out.push({ body: buf, startLine });
			continue;
		}
		if (ch === "\n") line++;
		i++;
	}
	return out;
}

/** True if any line in the window [startLine-2, startLine] carries the safe
 * annotation with a non-empty reason (`// <marker>: <reason>`). */
function hasSafeAnnotation(lines: string[], startLine: number, marker: string): boolean {
	const re = new RegExp(`//\\s*${escapeRegExp(marker)}:\\s*\\S+`);
	const upper = Math.max(0, startLine - 3);
	for (let i = upper; i < startLine; i++) {
		if (re.test(lines[i] ?? "")) return true;
	}
	return false;
}

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tenant-predicate scanner: any query template literal that MATCH/MERGE/CREATEs a
 * tenant-scoped label (or calls a search procedure that cannot pre-filter) must
 * bind a tenant predicate in the SAME literal, or carry an explicit safe
 * annotation. A faithful, parameterized port of newron's check-tenant-scope.
 *
 * Disabled (returns []) when `labels` is empty: with no tenant labels configured
 * there is nothing to enforce, so the check-pack reports it as a skip upstream.
 */
export function scanTenantPredicate(files: SourceFile[], params: TenantPredicateParams): ScanFinding[] {
	const labels = params.labels ?? [];
	if (labels.length === 0) return [];
	const fields = params.predicateFields?.length ? params.predicateFields : DEFAULT_PREDICATE_FIELDS;
	const safeMarker = params.safeAnnotation ?? DEFAULT_SAFE_ANNOTATION;
	const fieldAlt = fields.map(escapeRegExp).join("|");

	// A MATCH/MERGE/CREATE clause naming a tenant-scoped label (group 1 = label).
	const matchRe = new RegExp(`\\b(?:MATCH|MERGE|CREATE)\\b[^\\n]*?:(${labels.map(escapeRegExp).join("|")})\\b`, "g");
	// Search procedures that match an index, not the graph, so cannot pre-filter.
	const procRe = /\bCALL\s+(db\.index\.(?:vector|fulltext)\.query(?:Nodes|Relationships))\s*\(\s*[^\s,)]+/i;
	// Tenant predicate forms accepted inside the same literal.
	const predicateRes = [
		new RegExp(`\\b(?:${fieldAlt})\\s*:\\s*\\$\\w+`), // { field: $param }
		new RegExp(`\\b(?:${fieldAlt})\\s*:\\s*\\w+\\.\\w+`), // { field: row.x }
		new RegExp(`\\.\\s*(?:${fieldAlt})\\s*=\\s*\\$\\w+`), // WHERE n.field = $param
		/:\s*User\s*\{\s*externalUserId\s*:/, // (:User { externalUserId: ... })
	];

	const findings: ScanFinding[] = [];
	for (const file of files) {
		const lines = file.text.split("\n");
		for (const { body, startLine } of extractTemplateLiterals(file.text)) {
			const hasPredicate = predicateRes.some((re) => re.test(body));
			if (hasPredicate || hasSafeAnnotation(lines, startLine, safeMarker)) continue;
			matchRe.lastIndex = 0;
			const m = matchRe.exec(body);
			if (m) {
				findings.push({ path: file.path, line: startLine, message: `MATCH on :${m[1]} without a tenant predicate (${fields.join("/")})` });
				continue; // one finding per literal is enough to flag it
			}
			procRe.lastIndex = 0;
			const proc = procRe.exec(body);
			if (proc) {
				findings.push({ path: file.path, line: startLine, message: `search procedure ${proc[1]} without a tenant predicate (${fields.join("/")})` });
			}
		}
	}
	return findings;
}

// --- banned-tokens scanner ----------------------------------------------------

/** Filled holes for the banned-tokens template. `tokens` are substrings that must
 * not appear in guarded source (e.g. XSS escape hatches like
 * `dangerouslySetInnerHTML`). `guardedSuffixes` restricts the scan to files whose
 * path ends with one of these (empty = scan every file). */
export interface BannedTokensParams {
	tokens: string[];
	guardedSuffixes?: string[];
}

/** Strip JS block and line comments so a doc-comment that merely mentions a
 * banned token is not a false positive (mirrors newron's markdown.guard). */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 1-indexed line of the first occurrence of `token` in `text`, or 1. */
function lineOf(text: string, token: string): number {
	const idx = text.indexOf(token);
	if (idx < 0) return 1;
	return text.slice(0, idx).split("\n").length;
}

/**
 * Banned-tokens scanner: flag any guarded file that contains a banned token
 * (outside comments). A parameterized port of newron's markdown.guard XSS ban.
 */
export function scanBannedTokens(files: SourceFile[], params: BannedTokensParams): ScanFinding[] {
	const tokens = params.tokens ?? [];
	if (tokens.length === 0) return [];
	const suffixes = params.guardedSuffixes ?? [];
	const findings: ScanFinding[] = [];
	for (const file of files) {
		if (suffixes.length && !suffixes.some((s) => file.path.endsWith(s))) continue;
		const stripped = stripComments(file.text);
		for (const token of tokens) {
			if (stripped.includes(token)) {
				findings.push({ path: file.path, line: lineOf(file.text, token), message: `banned token '${token}' present in guarded file` });
			}
		}
	}
	return findings;
}
