/**
 * `slice-flow init` — capture a project's specifics ONCE into a committed,
 * run-time-only, phase-scoped profile (`.slice-flow/PROJECT.md`) that every
 * fresh-context agent inherits through its brief. Mirrors `provisionCheckPack`
 * (manifest build + human confirm) and the `state.liveAxes` context channel:
 * the profile is loaded at workflow start and injected into the intake,
 * architect, build, and review briefs.
 *
 * The flow is a two-stage relay keyed off disk — no new persistent state
 * machine, no `State` phase, no task tree:
 *   1. no draft on disk  → write the scout brief, return a directive to spawn
 *      the read-only scout, which drafts the profile to PROJECT.draft.md.
 *   2. draft present      → fill the check-pack manifest holes, confirm the
 *      risk profile, approve the draft, and promote it to PROJECT.md.
 * This module owns the project-profile file format (parse + load) so briefs.ts
 * and workspace.ts depend only on the `ProjectProfile` type (in workspace.ts).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SliceFlowConfig } from "./config.ts";
import { buildManifest, manifestPath, stackPreamble, writeManifest } from "./detect-stack.ts";
import type { CheckManifest, StackCheck } from "./detect-stack.ts";
import { askCheckPackConfirm } from "./gates.ts";
import type { GateContext } from "./gates.ts";
import type { ProjectProfile } from "./workspace.ts";
import type { Exec } from "./worktree.ts";

const SF_DIR = ".slice-flow";

export function projectMdPath(cwd: string): string {
	return join(cwd, SF_DIR, "PROJECT.md");
}

/** Whether this project has a captured profile (drives the first-run nudge). */
export function hasProjectProfile(cwd: string): boolean {
	return existsSync(projectMdPath(cwd));
}
function projectDraftPath(cwd: string): string {
	return join(cwd, SF_DIR, "PROJECT.draft.md");
}
function initBriefPath(cwd: string): string {
	return join(cwd, SF_DIR, "init-brief.md");
}
/** Committed sidecar recording when/against-which-commit the profile was last
 * captured. Drives the staleness nudge; mirrors the manifest's committed status. */
function profileStampPath(cwd: string): string {
	return join(cwd, SF_DIR, "profile.json");
}

export interface ProfileStamp {
	capturedCommit: string | null;
	capturedAt: string;
}

function writeProfileStamp(cwd: string, headCommit: string | null): void {
	const stamp: ProfileStamp = { capturedCommit: headCommit, capturedAt: new Date().toISOString() };
	writeFileSync(profileStampPath(cwd), JSON.stringify(stamp, null, 2), "utf8");
}

export function readProfileStamp(cwd: string): ProfileStamp | null {
	const path = profileStampPath(cwd);
	if (!existsSync(path)) return null;
	try {
		const o = JSON.parse(readFileSync(path, "utf8"));
		return { capturedCommit: o.capturedCommit ?? null, capturedAt: String(o.capturedAt ?? "") };
	} catch {
		return null;
	}
}

/** The canonical section headings of a project profile. The scout drafts these;
 * `parseProfile` reads them back; `projectProfileClause` injects subsets. */
export const PROFILE_SECTIONS = [
	{ key: "domain", heading: "Domain & vocabulary" },
	{ key: "invariants", heading: "Architectural invariants & seams" },
	{ key: "conventions", heading: "Conventions" },
	{ key: "libs", heading: "Preferred libraries / banned patterns" },
	{ key: "riskNotes", heading: "Risk model notes" },
	{ key: "dod", heading: "Definition of done" },
] as const;

export const PROJECT_TEMPLATE = [
	"<!-- SLICE-FLOW PROJECT PROFILE (managed by `slice-flow init`; safe to hand-edit) -->",
	"# Project profile",
	"",
	...PROFILE_SECTIONS.flatMap((s) => [`## ${s.heading}`, "", "(none recorded)", ""]),
].join("\n");

// --- Profile parse / load ----------------------------------------------------

/** Split a PROJECT.md into its `## ` sections, mapping each canonical heading to
 * its body text. Unknown headings are ignored; missing ones map to "". */
export function parseProfile(text: string): ProjectProfile {
	const sections: Record<string, string> = {};
	let current: string | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (current) sections[current] = buf.join("\n").trim();
		buf = [];
	};
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^##\s+(.*)$/);
		if (m) {
			flush();
			const heading = m[1].trim().toLowerCase();
			current = PROFILE_SECTIONS.find((s) => heading.startsWith(s.heading.toLowerCase()))?.key ?? null;
		} else if (current) {
			buf.push(line);
		}
	}
	flush();
	const placeholder = (v: string) => (v === "(none recorded)" ? "" : v);
	return {
		domain: placeholder(sections.domain ?? ""),
		invariants: placeholder(sections.invariants ?? ""),
		conventions: placeholder(sections.conventions ?? ""),
		libs: placeholder(sections.libs ?? ""),
		riskNotes: placeholder(sections.riskNotes ?? ""),
		dod: placeholder(sections.dod ?? ""),
		raw: text,
	};
}

/** Load the project profile from `.slice-flow/PROJECT.md`, or null when absent.
 * Read from the main checkout cwd (not a worktree): the profile may be authored
 * but not yet committed, so a HEAD-branched worktree would not see it. */
export function loadProjectProfile(cwd: string): ProjectProfile | null {
	const path = projectMdPath(cwd);
	if (!existsSync(path)) return null;
	return parseProfile(readFileSync(path, "utf8"));
}

// --- Staleness (layer 1) -----------------------------------------------------

const headingOf = (key: string): string => PROFILE_SECTIONS.find((s) => s.key === key)?.heading ?? key;

/** Pure staleness decision. Stale when the profile is older than EITHER bound.
 * `commitsSince` is best-effort (null on a non-git repo / no stamp) — fall back to
 * days. No stamp at all → not stale (a profile from before stamping just won't
 * nudge until the next `/feature-init` writes the sidecar). */
export function isProfileStale(
	stamp: ProfileStamp | null,
	signals: { now: number; commitsSince: number | null },
	thresholds: { staleAfterDays: number; staleAfterCommits: number },
): { stale: boolean; reason: string } {
	if (!stamp) return { stale: false, reason: "" };
	if (signals.commitsSince !== null && signals.commitsSince >= thresholds.staleAfterCommits) {
		return { stale: true, reason: `${signals.commitsSince} commits since it was captured` };
	}
	const days = Math.floor((signals.now - Date.parse(stamp.capturedAt)) / 86_400_000);
	if (Number.isFinite(days) && days >= thresholds.staleAfterDays) {
		return { stale: true, reason: `captured ${days} days ago` };
	}
	return { stale: false, reason: "" };
}

/** A one-line `/feature` start nudge when the captured profile has drifted, or ""
 * when fresh / uncaptured. Best-effort commit count via `exec`. */
export async function profileStaleNudge(cwd: string, headCommit: string | null, cfg: SliceFlowConfig, exec?: Exec): Promise<string> {
	const stamp = readProfileStamp(cwd);
	if (!stamp) return "";
	let commitsSince: number | null = null;
	if (exec && headCommit && stamp.capturedCommit) {
		try {
			const res = await exec("git", ["rev-list", "--count", `${stamp.capturedCommit}..${headCommit}`], { timeout: 5000 });
			if (res.code === 0) {
				const n = Number.parseInt(res.stdout.trim(), 10);
				if (Number.isFinite(n)) commitsSince = n;
			}
		} catch {
			/* best-effort: fall back to days */
		}
	}
	const { stale, reason } = isProfileStale(stamp, { now: Date.now(), commitsSince }, cfg.profile);
	return stale
		? `Heads-up: this project's slice-flow profile may be stale (${reason}). Run /feature-init to review and refresh .slice-flow/PROJECT.md.`
		: "";
}

// --- Section diff (layer 2) --------------------------------------------------

/** Compare two parsed profiles section-by-section so a refresh can show WHAT
 * changed instead of the whole document. `added` = was empty, now has content;
 * `changed` = differing non-trivially (incl. content removed); `unchanged` = equal. */
export function diffProfiles(existing: ProjectProfile, draft: ProjectProfile): { changed: string[]; added: string[]; unchanged: string[] } {
	const changed: string[] = [];
	const added: string[] = [];
	const unchanged: string[] = [];
	for (const { key } of PROFILE_SECTIONS) {
		const a = (existing[key] ?? "").trim();
		const b = (draft[key] ?? "").trim();
		if (a === b) unchanged.push(key);
		else if (a === "") added.push(key);
		else changed.push(key);
	}
	return { changed, added, unchanged };
}

// --- The scout draft brief ---------------------------------------------------

function specModel(spec: string | string[] | null): string | null {
	if (Array.isArray(spec)) return spec[0] ?? null;
	return spec;
}

function initBrief(cwd: string, profileLine: string, existingProjectMd: string | null, notes?: string): string {
	const headings = PROFILE_SECTIONS.map((s) => `## ${s.heading}`).join("\n");
	return `# Draft the slice-flow project profile

You are reconnaissance for slice-flow. Scan THIS repository and compress what you find into a project profile that every later workflow agent (architect, builder, reviewer) will inherit as binding context. This is COMPRESSION of repo reality — cite real files; invent nothing.

Write your final answer as a Markdown document to ${projectDraftPath(cwd)} with EXACTLY these section headings, in this order (keep the leading HTML comment line):

<!-- SLICE-FLOW PROJECT PROFILE (managed by \`slice-flow init\`; safe to hand-edit) -->
# Project profile

${headings}

What each section captures:
- **Domain & vocabulary** — what this product/codebase is, and the domain terms an agent must use correctly.
- **Architectural invariants & seams** — the boundaries and rules that must not be crossed (module layering, where logic belongs, what stays pure, public contracts). Ground each in a real file or pattern.
- **Conventions** — naming, the test framework and the exact command to run tests, error-handling style, logging. Prefer the project's actual commands (package.json scripts, Makefile, etc.).
- **Preferred libraries / banned patterns** — what to reach for and what to avoid in this repo.
- **Risk model notes** — project-specific security/correctness concerns. ${profileLine ? `Stack detection reports: ${profileLine}` : "Note any tenancy, auth, PII, money, or injection concerns you can see."}
- **Definition of done** — what "done" means here beyond "it compiles": tests, docs, review expectations.

Rules:
- Keep each section tight and concrete (a few bullets). A profile an agent skims beats an essay it skips.
- Only claim what the repo supports; if a section has nothing real to say, write "(none recorded)" under it rather than padding.
- Do not edit any project files; write ONLY the profile document to the path above.${
		existingProjectMd
			? `\n\nThis is a REFRESH, not a first capture — the current profile is injected. Compare it against the repo as it stands today: preserve correct human-authored content VERBATIM, change ONLY sections that have genuinely drifted, and fill newly-relevant gaps. In your final run summary (the message you return, NOT the document), list which sections you changed and why so the human can review the deltas. Never discard human edits.`
			: ""
	}${notes ? `\n\nRegeneration notes from the user — address these:\n${notes}` : ""}`;
}

/** Build the single-agent scout invocation that drafts the profile. Mirrors
 * directives.ts `freshChain`, inlined because init is task-less. */
function draftDirective(cwd: string, cfg: SliceFlowConfig, briefPath: string, existingProjectMd: string | null): Record<string, unknown> {
	const model = specModel(cfg.models.intake);
	const reads = [briefPath];
	if (existingProjectMd) reads.push(projectMdPath(cwd));
	return {
		chain: [
			{
				agent: cfg.agents.intake, // slice-flow-scout (recon + single-artifact compression)
				task: `Your complete task brief is the injected file ${briefPath}. Execute it exactly. It overrides any conflicting default behavior.`,
				label: "Draft project profile",
				phase: "Init",
				reads,
				output: projectDraftPath(cwd),
				...(model ? { model } : {}),
			},
		],
		context: "fresh",
		clarify: false,
		chainDir: join(cwd, SF_DIR, "init-chain"),
	};
}

/** Keep init's transient files out of version control. PROJECT.md and the
 * check-pack manifest are intentionally committed; the draft, the scout brief,
 * and the scout's chain artifacts are not. Non-fatal: a stray committed draft is
 * sloppy, not broken. */
function ensureInitGitignored(cwd: string): void {
	try {
		const gi = join(cwd, ".gitignore");
		const entries = [`${SF_DIR}/PROJECT.draft.md`, `${SF_DIR}/init-brief.md`, `${SF_DIR}/init-chain/`];
		const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
		const present = new Set(current.split("\n").map((l) => l.trim().replace(/\/$/, "")));
		const missing = entries.filter((e) => !present.has(e.replace(/\/$/, "")));
		if (missing.length === 0) return;
		appendFileSync(gi, `${current === "" || current.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`, "utf8");
	} catch {
		/* non-fatal */
	}
}

/** Stage 1: write the brief and return the relay directive to spawn the scout. */
function issueDraft(cwd: string, cfg: SliceFlowConfig, notes?: string): string {
	mkdirSync(join(cwd, SF_DIR), { recursive: true });
	ensureInitGitignored(cwd);
	const manifest = buildManifest(cwd, new Date().toISOString());
	const profileLine = stackPreamble(manifest.axes, manifest.checks);
	const existing = existsSync(projectMdPath(cwd)) ? readFileSync(projectMdPath(cwd), "utf8") : null;
	const briefPath = initBriefPath(cwd);
	writeFileSync(briefPath, initBrief(cwd, profileLine, existing, notes), "utf8");
	const args = draftDirective(cwd, cfg, briefPath, existing);
	return [
		"slice-flow init: drafting a project profile via the read-only scout. This captures THIS repo's domain, invariants, and conventions into .slice-flow/PROJECT.md so every workflow phase inherits it instead of rediscovering it.",
		"",
		"## slice-flow init — draft the project profile",
		"",
		"Invoke the `subagent` tool now with EXACTLY this input. Do not modify, reorder, summarize, or omit any field:",
		"",
		"```json",
		JSON.stringify(args, null, 2),
		"```",
		"",
		`When the subagent run completes, call slice_flow({"action":"init"}) again to fill any check-pack holes and confirm the profile.`,
	].join("\n");
}

// --- Stage 2: confirm + promote ---------------------------------------------

/** Interactively fill a Tier-B check's required holes. Today only the
 * tenant-predicate scanner has one (a non-empty `labels` list). Mutates the
 * check in place; clears `pending` once filled. */
async function fillCheckHoles(ctx: GateContext, manifest: CheckManifest): Promise<void> {
	if (!ctx.hasUI) return;
	for (const check of manifest.checks as StackCheck[]) {
		if (!check.pending || check.scanner !== "tenant-predicate") continue;
		const ans = await ctx.ui.input(
			`Tenant-scoped node labels for the ${check.id} check (comma-separated; blank to leave quarantined)`,
			"e.g. Project, Task, Document",
		);
		const labels = (ans ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (labels.length > 0) {
			check.params.labels = labels;
			check.pending = false;
		}
	}
}

/** Stage 2: the draft exists. Fill manifest holes, confirm the risk profile,
 * approve the draft, and promote it to PROJECT.md. */
async function confirmDraft(ctx: GateContext, cfg: SliceFlowConfig, cwd: string, headCommit: string | null): Promise<string> {
	const draftPath = projectDraftPath(cwd);
	const projectMd = projectMdPath(cwd);

	// 1. Check-pack: fill holes + one-time confirm (reusing the provisionCheckPack contract).
	if (cfg.checks.enabled) {
		const manifest = buildManifest(cwd, new Date().toISOString());
		if (manifest.axes.length > 1 || manifest.checks.length > 0) {
			await fillCheckHoles(ctx, manifest);
			const profile = stackPreamble(manifest.axes, manifest.checks);
			if (!manifest.confirmed) manifest.confirmed = await askCheckPackConfirm(ctx, profile);
			writeManifest(cwd, manifest);
		}
	}

	// 2. Refresh-vs-first-capture: when a profile already exists, show WHAT changed
	// (section-level diff) so the human reviews deltas, not the whole document.
	const existingText = existsSync(projectMd) ? readFileSync(projectMd, "utf8") : null;
	const diff = existingText ? diffProfiles(parseProfile(existingText), parseProfile(readFileSync(draftPath, "utf8"))) : null;
	const changedHeadings = diff ? [...diff.added, ...diff.changed].map(headingOf) : [];
	const changeSummary = diff ? (changedHeadings.length ? `Changed: ${changedHeadings.join(", ")}.` : "No section changes vs the current profile.") : "";

	// 3. Approve the drafted profile. Headless: accept as-is (cannot edit/confirm).
	if (ctx.hasUI) {
		ctx.ui.notify(diff ? `Review the profile REFRESH at ${draftPath}. ${changeSummary}` : `Review the drafted project profile at ${draftPath}`, "info");
		const title = diff
			? `Profile refresh — accept these changes as .slice-flow/PROJECT.md? (${changedHeadings.length ? changedHeadings.join(", ") : "no changes"})`
			: "Project profile draft — accept it as this repo's .slice-flow/PROJECT.md?";
		const choice = await ctx.ui.select(title, ["Accept", "Regenerate with notes", "Cancel"]);
		if (choice === undefined || choice === "Cancel") {
			return `slice-flow init canceled. The draft is kept at ${draftPath}; re-run /feature-init to resume. ${projectMd} was not written. End your turn.`;
		}
		if (choice === "Regenerate with notes") {
			const notes = await ctx.ui.input("What should the profile change?", "Describe what to fix or add");
			rmSync(draftPath, { force: true });
			return issueDraft(cwd, cfg, notes?.trim() || undefined);
		}
	}

	// 4. Promote: draft -> PROJECT.md; stamp provenance; clean up the transient brief.
	renameSync(draftPath, projectMd);
	writeProfileStamp(cwd, headCommit);
	rmSync(initBriefPath(cwd), { force: true });
	const manifestNote = existsSync(manifestPath(cwd))
		? readManifestConfirmed(cwd)
			? "check-pack manifest confirmed"
			: "check-pack manifest left unconfirmed (quarantined until you confirm it)"
		: "no check-pack profile detected";
	return (
		`slice-flow init complete. Wrote ${projectMd} (${manifestNote}).${diff ? ` ${changeSummary}` : ""} ` +
		`The profile now feeds the intake, architect, build, and review phases of every /feature run — no engine restart needed. ` +
		`Tell the user and end your turn.`
	);
}

function readManifestConfirmed(cwd: string): boolean {
	try {
		return JSON.parse(readFileSync(manifestPath(cwd), "utf8")).confirmed === true;
	} catch {
		return false;
	}
}

/**
 * Entry point for the `init` action. Disk-driven stage selection: the presence
 * of the draft file decides whether we are issuing the scout (stage 1) or
 * confirming its output (stage 2). Idempotent and resumable.
 */
export async function runInit(ctx: GateContext, cfg: SliceFlowConfig, cwd: string, headCommit: string | null = null): Promise<string> {
	if (existsSync(projectDraftPath(cwd))) return confirmDraft(ctx, cfg, cwd, headCommit);
	return issueDraft(cwd, cfg);
}
