/**
 * Stack perception for the Tier-B check-pack: at workflow start, probe the repo
 * to infer which technologies are present, map that to the live *risk axes*, and
 * select the stack-templated checks that apply (filling their generic templates
 * with project-sensible params). Pure classification is separated from the disk
 * probe so it stays testable without a filesystem (mirrors codegraph.ts).
 *
 * Detection is a heuristic and can be wrong, so the caller surfaces a one-time
 * human confirm gate before any selected check becomes enforcing — "axis live but
 * unchecked" must be loud, never silently passed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The risk axes slice-flow reasons about. Kept in sync with the risk-taxonomy
 * skill (LLM-facing knowledge); this list is the machine-facing enum. */
export type RiskAxis =
	| "secrets"
	| "injection"
	| "multi-tenancy"
	| "authz"
	| "pii-logging"
	| "migration-lineage"
	| "money-idempotency"
	| "rate-limit"
	| "xss";

/** The technology categories we sniff. Each value is the list of matched markers
 * (e.g. `db: ["neo4j"]`), so presence is `signals[cat].length > 0` and the exact
 * marker drives check selection. */
export interface StackSignals {
	db: string[];
	orm: string[];
	auth: string[];
	queue: string[];
	payments: string[];
	web: string[];
	markdown: string[];
}

/** One selected Tier-B check, ready to persist in the manifest and dispatch to a
 * scanner in checks.ts. `scanner` names the pure function; `params` are the filled
 * template holes. `pending` marks a check that needs human input before it can
 * enforce (e.g. tenant labels the probe cannot infer) — surfaced as a skip until
 * filled, never silently dropped. */
export interface StackCheck {
	id: string;
	axis: RiskAxis;
	scanner: "tenant-predicate" | "banned-tokens";
	params: Record<string, unknown>;
	pending?: boolean;
}

/** The persisted check-pack manifest (`.slice-flow/checks/manifest.json`). Lives
 * in the project repo (committed), not the plugin. The engine stamps `detectedAt`
 * and flips `confirmed` once a human signs off the detected profile. */
export interface CheckManifest {
	version: 1;
	detectedAt: string;
	signals: StackSignals;
	axes: RiskAxis[];
	checks: StackCheck[];
	confirmed: boolean;
}

/** Marker tables: a category's key is detected when ANY of its marker package
 * names appears among the repo's dependencies (db also consults compose services).
 * One entry per technology keeps adding a stack a one-line change. */
const MARKERS: Record<keyof StackSignals, Record<string, string[]>> = {
	db: { neo4j: ["neo4j-driver"], postgres: ["pg", "postgres", "@neondatabase/serverless"], mysql: ["mysql2", "mysql"], mongo: ["mongodb"], sqlite: ["better-sqlite3", "sqlite3"] },
	orm: { prisma: ["@prisma/client", "prisma"], drizzle: ["drizzle-orm"], typeorm: ["typeorm"], sequelize: ["sequelize"], knex: ["knex"], mongoose: ["mongoose"] },
	auth: { clerk: ["@clerk/nextjs", "@clerk/backend", "@clerk/clerk-sdk-node"], auth0: ["@auth0/auth0-react", "express-openid-connect"], "next-auth": ["next-auth"], lucia: ["lucia"], passport: ["passport"] },
	queue: { bullmq: ["bullmq"], "bee-queue": ["bee-queue"], kafkajs: ["kafkajs"] },
	payments: { stripe: ["stripe", "@stripe/stripe-js"], paddle: ["@paddle/paddle-js"], braintree: ["braintree"] },
	web: { next: ["next"], express: ["express"], fastify: ["fastify"], nest: ["@nestjs/core"], hono: ["hono"] },
	markdown: { "react-markdown": ["react-markdown"], marked: ["marked"], "markdown-it": ["markdown-it"] },
};

/** Compose service-name fragments that imply a database, for repos that run the
 * DB as a container rather than depending on a client (or do both). */
const DB_COMPOSE_HINTS: Record<string, string[]> = { neo4j: ["neo4j"], postgres: ["postgres", "pgvector"], mysql: ["mysql", "mariadb"], mongo: ["mongo"] };

/** XSS escape-vector tokens that must never appear in a markdown renderer source
 * (the banned-tokens template's default fill). */
const MARKDOWN_BANNED_TOKENS = ["dangerouslySetInnerHTML", "rehype-raw", "urlTransform", "unwrapDisallowed", "skipHtml"];

/** Pure: classify a dependency/service corpus into per-category markers. `deps`
 * is the set of dependency names; `composeText` is the concatenated compose-file
 * text (lowercased by the caller is not required — matched case-insensitively). */
export function classifySignals(deps: Set<string>, composeText = ""): StackSignals {
	const compose = composeText.toLowerCase();
	const matchCat = (table: Record<string, string[]>, useCompose: Record<string, string[]> | null): string[] => {
		const found: string[] = [];
		for (const [key, markers] of Object.entries(table)) {
			const inDeps = markers.some((m) => deps.has(m));
			const inCompose = useCompose?.[key]?.some((h) => compose.includes(h)) ?? false;
			if (inDeps || inCompose) found.push(key);
		}
		return found;
	};
	return {
		db: matchCat(MARKERS.db, DB_COMPOSE_HINTS),
		orm: matchCat(MARKERS.orm, null),
		auth: matchCat(MARKERS.auth, null),
		queue: matchCat(MARKERS.queue, null),
		payments: matchCat(MARKERS.payments, null),
		web: matchCat(MARKERS.web, null),
		markdown: matchCat(MARKERS.markdown, null),
	};
}

/** Pure: which risk axes are live for these signals. `secrets` is universal; the
 * rest are implied by the presence of the relevant technology. Conservative on
 * purpose — a false "live" axis costs one human "no" at the confirm gate, while a
 * missed axis costs a silent blind spot. */
export function classifyAxes(s: StackSignals): RiskAxis[] {
	const axes = new Set<RiskAxis>(["secrets"]);
	const has = (cat: keyof StackSignals) => s[cat].length > 0;
	if (has("db")) axes.add("injection");
	if (has("db") && has("auth")) axes.add("multi-tenancy");
	if (has("auth")) {
		axes.add("authz");
		axes.add("pii-logging");
	}
	if (has("orm")) axes.add("migration-lineage");
	if (has("payments")) axes.add("money-idempotency");
	if (has("queue") || has("web")) axes.add("rate-limit");
	if (has("markdown")) axes.add("xss");
	return [...axes];
}

/** Pure: which Tier-B checks apply, with their templates filled. The tenant-
 * predicate scanner is Cypher-shaped, so it ships only for a graph DB and starts
 * `pending` (its tenant labels cannot be inferred from deps — a human fills them).
 * The banned-tokens scanner ships ready, pre-filled with the XSS token list. */
export function selectChecks(s: StackSignals): StackCheck[] {
	const checks: StackCheck[] = [];
	if (s.db.includes("neo4j")) {
		checks.push({
			id: "tenant-predicate",
			axis: "multi-tenancy",
			scanner: "tenant-predicate",
			// labels left empty: detection cannot know a project's tenant-scoped node
			// labels, so the check is quarantined until a human (or Tier-C) fills them.
			params: { labels: [], predicateFields: ["externalUserId", "ownerId", "userId"], safeAnnotation: "@tenant-safe", glob: "**/*.ts" },
			pending: true,
		});
	}
	if (s.markdown.length > 0) {
		checks.push({
			id: "banned-tokens",
			axis: "xss",
			scanner: "banned-tokens",
			params: { tokens: MARKDOWN_BANNED_TOKENS, guardedSuffixes: [".tsx", ".jsx"], glob: "**/*.{tsx,jsx}" },
		});
	}
	return checks;
}

/** Collect dependency names from a package.json's four dependency maps. */
function depsOf(pkgText: string): string[] {
	try {
		const pkg = JSON.parse(pkgText) as Record<string, Record<string, string> | undefined>;
		return [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((m) => (m ? Object.keys(m) : []));
	} catch {
		return [];
	}
}

/** Read a file, returning "" on any error (absent/unreadable). */
function readSafe(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : "";
	} catch {
		return "";
	}
}

/**
 * Disk probe: gather dependency names from the root package.json AND from the
 * lockfile text (the lockfile names every workspace package by string, so a
 * pnpm/npm/yarn monorepo whose root package.json is thin is still detected). Read
 * compose files for containerized databases. Returns the classified signals.
 */
export function detectStack(cwd: string): StackSignals {
	const deps = new Set<string>(depsOf(readSafe(join(cwd, "package.json"))));
	// The lockfile lists every resolved package name; a substring scan over its
	// text catches workspace deps the root package.json omits. We test marker
	// membership against this text, not just exact deps, below.
	const lockText = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].map((f) => readSafe(join(cwd, f))).join("\n");
	// Fold any marker that appears as a quoted/pathed token in the lockfile into
	// the dep set, so classifySignals' exact-match stays the single source of truth.
	for (const table of Object.values(MARKERS)) {
		for (const markers of Object.values(table)) {
			for (const m of markers) {
				if (lockText.includes(`/${m}@`) || lockText.includes(`"${m}"`) || lockText.includes(` ${m}:`)) deps.add(m);
			}
		}
	}
	const composeText = ["docker-compose.yml", "docker-compose.yaml", "docker-compose.prod.yml", "compose.yml"].map((f) => readSafe(join(cwd, f))).join("\n");
	return classifySignals(deps, composeText);
}

/** Where the check-pack manifest lives in the project repo (committed). */
export function manifestPath(cwd: string): string {
	return join(cwd, ".slice-flow", "checks", "manifest.json");
}

/** Load the persisted manifest, or null when absent/unreadable/malformed (the
 * caller treats "no manifest" as "no Tier-B checks", never an error). */
export function loadManifest(cwd: string): CheckManifest | null {
	const file = manifestPath(cwd);
	try {
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, "utf8")) as CheckManifest;
	} catch {
		return null;
	}
}

/** Write the manifest, creating `.slice-flow/checks/` as needed. */
export function writeManifest(cwd: string, manifest: CheckManifest): void {
	const file = manifestPath(cwd);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Build a manifest from a fresh disk probe, preserving prior human edits: if a
 * manifest already exists, its filled params and `confirmed` flag win over the
 * freshly-detected defaults for checks of the same id (so re-running detection
 * never clobbers tenant labels a human typed in). `detectedAt` is injected (the
 * caller stamps it — scripts cannot read the clock).
 */
export function buildManifest(cwd: string, detectedAt: string): CheckManifest {
	const signals = detectStack(cwd);
	const axes = classifyAxes(signals);
	const fresh = selectChecks(signals);
	const prior = loadManifest(cwd);
	const checks = fresh.map((c) => {
		const kept = prior?.checks.find((p) => p.id === c.id);
		// Preserve a human's filled params (e.g. tenant labels) across re-detection.
		return kept ? { ...c, params: { ...c.params, ...kept.params }, pending: hasUnfilled(kept) } : c;
	});
	return { version: 1, detectedAt, signals, axes, checks, confirmed: prior?.confirmed ?? false };
}

/** A check is still pending if its required holes are unfilled. Today only the
 * tenant-predicate scanner has a required hole (a non-empty `labels` list). */
function hasUnfilled(check: StackCheck): boolean {
	if (check.scanner === "tenant-predicate") return !(Array.isArray(check.params.labels) && check.params.labels.length > 0);
	return false;
}

/** Pure: the one-time startup line summarizing the detected profile, or "" when
 * nothing risk-bearing was detected (stay quiet, like codegraph's silent state). */
export function stackPreamble(axes: RiskAxis[], checks: StackCheck[]): string {
	const enforcing = checks.filter((c) => !c.pending).map((c) => c.id);
	const pending = checks.filter((c) => c.pending).map((c) => c.id);
	if (axes.length <= 1 && checks.length === 0) return ""; // only the universal `secrets` axis, no Tier-B checks
	const parts = [`Check-pack risk profile: live axes — ${axes.join(", ")}.`];
	if (enforcing.length) parts.push(`Stack checks enabled: ${enforcing.join(", ")}.`);
	if (pending.length) parts.push(`Pending configuration (quarantined until filled): ${pending.join(", ")}.`);
	return parts.join(" ");
}
