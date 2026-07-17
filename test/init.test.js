import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	runInit,
	loadProjectProfile,
	parseProfile,
	projectMdPath,
	hasProjectProfile,
	PROFILE_SECTIONS,
	isProfileStale,
	profileStaleNudge,
	readProfileStamp,
	diffProfiles,
} from "../extensions/lib/init.ts";
import { projectProfileClause, planJudgeBrief, hypothesisBrief } from "../extensions/lib/briefs.ts";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { loadManifest, manifestPath } from "../extensions/lib/detect-stack.ts";

/** A throwaway repo with a package.json naming the given deps. */
function repo(deps = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "slice-flow-init-"));
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: deps }));
	return cwd;
}

/** Fake gate ctx. `select` answers by the option set so the check-pack confirm
 * and the draft-approval gate (different option lists) can each get an answer;
 * `input` is a fixed reply (e.g. tenant labels). */
function fakeCtx({ approve = "Accept", enableChecks = true, input = "Project, Task", hasUI = true } = {}) {
	const calls = { select: 0, input: 0, selectTitles: [] };
	return {
		hasUI,
		ui: {
			notify: () => {},
			select: async (title, options) => {
				calls.select++;
				calls.selectTitles.push(title);
				if (options.includes("Enable check-pack")) return enableChecks ? "Enable check-pack" : "Not now";
				if (options.includes("Accept")) return approve;
				return undefined;
			},
			input: async () => {
				calls.input++;
				return input;
			},
		},
		calls,
	};
}

const NEO4J = { "neo4j-driver": "^5", "@clerk/nextjs": "^5" };

const SAMPLE_PROFILE = [
	"<!-- SLICE-FLOW PROJECT PROFILE (managed by `slice-flow init`; safe to hand-edit) -->",
	"# Project profile",
	"",
	"## Domain & vocabulary",
	'Graph task manager. "Tenant" = a customer org.',
	"",
	"## Architectural invariants & seams",
	"Cypher lives in db/ only.",
	"",
	"## Conventions",
	"Tests: `npm test`. camelCase names.",
	"",
	"## Preferred libraries / banned patterns",
	"Use neo4j-driver; never hand-concatenate Cypher.",
	"",
	"## Risk model notes",
	"Every query needs a tenant predicate.",
	"",
	"## Definition of done",
	"Tests green and reviewer PASS.",
	"",
].join("\n");

function plantDraft(cwd, text = SAMPLE_PROFILE) {
	mkdirSync(join(cwd, ".slice-flow"), { recursive: true });
	writeFileSync(join(cwd, ".slice-flow", "PROJECT.draft.md"), text);
}

// --- Stage 1: issue the scout draft ------------------------------------------

test("stage 1 (no draft) returns a directive to spawn the scout and writes the brief", async () => {
	const cwd = repo(NEO4J);
	const text = await runInit(fakeCtx(), DEFAULT_CONFIG, cwd);
	assert.match(text, /subagent/, "relays a subagent directive");
	assert.match(text, /slice-flow-scout/, "names the scout agent");
	assert.match(text, /PROJECT\.draft\.md/, "outputs to the draft path");
	assert.ok(existsSync(join(cwd, ".slice-flow", "init-brief.md")), "writes the scout brief to disk");
	assert.ok(!existsSync(projectMdPath(cwd)), "does not write PROJECT.md yet");
});

test("stage 1 brief surfaces the detected stack profile for grounding", async () => {
	const cwd = repo(NEO4J);
	await runInit(fakeCtx(), DEFAULT_CONFIG, cwd);
	const brief = readFileSync(join(cwd, ".slice-flow", "init-brief.md"), "utf8");
	assert.match(brief, /multi-tenancy/, "the brief tells the scout the live axes");
});

test("stage 1 gitignores the transient init files (but not PROJECT.md / manifest)", async () => {
	const cwd = repo(NEO4J);
	await runInit(fakeCtx(), DEFAULT_CONFIG, cwd);
	const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
	assert.match(gi, /\.slice-flow\/PROJECT\.draft\.md/, "draft is ignored");
	assert.match(gi, /\.slice-flow\/init-brief\.md/, "scout brief is ignored");
	assert.doesNotMatch(gi, /PROJECT\.md$/m, "PROJECT.md itself stays committed");
});

// --- Stage 2: confirm + promote ----------------------------------------------

test("stage 2 accept promotes the draft, fills tenant labels, and confirms the manifest", async () => {
	const cwd = repo(NEO4J);
	plantDraft(cwd);
	const text = await runInit(fakeCtx({ approve: "Accept", input: "Project, Task" }), DEFAULT_CONFIG, cwd);
	assert.match(text, /init complete/i);
	assert.equal(readFileSync(projectMdPath(cwd), "utf8"), SAMPLE_PROFILE, "draft promoted verbatim to PROJECT.md");
	assert.ok(!existsSync(join(cwd, ".slice-flow", "PROJECT.draft.md")), "draft is consumed");
	const m = loadManifest(cwd);
	assert.equal(m.confirmed, true, "risk profile confirmed");
	const tenant = m.checks.find((c) => c.id === "tenant-predicate");
	assert.deepEqual(tenant.params.labels, ["Project", "Task"], "tenant labels filled from input");
	assert.equal(tenant.pending, false, "filled check is no longer pending");
});

test("stage 2 cancel writes nothing and keeps the draft", async () => {
	const cwd = repo(NEO4J);
	plantDraft(cwd);
	const text = await runInit(fakeCtx({ approve: "Cancel", enableChecks: false }), DEFAULT_CONFIG, cwd);
	assert.match(text, /canceled/i);
	assert.ok(!existsSync(projectMdPath(cwd)), "PROJECT.md not written on cancel");
	assert.ok(existsSync(join(cwd, ".slice-flow", "PROJECT.draft.md")), "draft kept for a resume");
});

test("stage 2 regenerate re-issues the scout with notes", async () => {
	const cwd = repo(NEO4J);
	plantDraft(cwd);
	const text = await runInit(fakeCtx({ approve: "Regenerate with notes", input: "be more specific about auth", enableChecks: false }), DEFAULT_CONFIG, cwd);
	assert.match(text, /subagent/, "returns a fresh draft directive");
	assert.ok(!existsSync(join(cwd, ".slice-flow", "PROJECT.draft.md")), "stale draft cleared before redraft");
	const brief = readFileSync(join(cwd, ".slice-flow", "init-brief.md"), "utf8");
	assert.match(brief, /be more specific about auth/, "notes threaded into the redraft brief");
});

test("stage 2 headless promotes the draft as-is and leaves the manifest unconfirmed", async () => {
	const cwd = repo(NEO4J);
	plantDraft(cwd);
	const text = await runInit(fakeCtx({ hasUI: false }), DEFAULT_CONFIG, cwd);
	assert.match(text, /init complete/i);
	assert.ok(existsSync(projectMdPath(cwd)), "draft promoted even without a UI");
	assert.equal(loadManifest(cwd).confirmed, false, "a security profile is never auto-confirmed headless");
});

test("stage 2 on a no-risk repo promotes the draft and writes no manifest", async () => {
	const cwd = repo({ lodash: "^4" });
	plantDraft(cwd);
	const text = await runInit(fakeCtx(), DEFAULT_CONFIG, cwd);
	assert.match(text, /init complete/i);
	assert.ok(existsSync(projectMdPath(cwd)), "profile still captured");
	assert.ok(!existsSync(manifestPath(cwd)), "no manifest litters a plain repo");
});

// --- Profile parse / load ----------------------------------------------------

test("loadProjectProfile is null when absent and parses sections when present", () => {
	const cwd = repo();
	assert.equal(loadProjectProfile(cwd), null);
	assert.equal(hasProjectProfile(cwd), false);
	mkdirSync(join(cwd, ".slice-flow"), { recursive: true });
	writeFileSync(projectMdPath(cwd), SAMPLE_PROFILE);
	const profile = loadProjectProfile(cwd);
	assert.match(profile.domain, /Graph task manager/);
	assert.match(profile.invariants, /Cypher lives in db\//);
	assert.match(profile.conventions, /npm test/);
	assert.match(profile.dod, /reviewer PASS/);
	assert.equal(hasProjectProfile(cwd), true);
});

test("parseProfile maps the (none recorded) placeholder to an empty section", () => {
	const text = ["# Project profile", "", "## Domain & vocabulary", "(none recorded)", "", "## Conventions", "Real content.", ""].join("\n");
	const profile = parseProfile(text);
	assert.equal(profile.domain, "", "placeholder becomes empty so the clause skips it");
	assert.equal(profile.conventions, "Real content.");
});

// --- projectProfileClause ----------------------------------------------------

test("projectProfileClause is empty for an absent or empty profile", () => {
	assert.equal(projectProfileClause(undefined, ["domain"]), "");
	const empty = parseProfile("# Project profile\n\n## Domain & vocabulary\n(none recorded)\n");
	assert.equal(projectProfileClause(empty, ["domain"]), "");
});

test("projectProfileClause injects only the requested sections", () => {
	const profile = parseProfile(SAMPLE_PROFILE);
	const clause = projectProfileClause(profile, ["conventions", "domain"]);
	assert.match(clause, /### Conventions/);
	assert.match(clause, /npm test/);
	assert.match(clause, /### Domain & vocabulary/);
	assert.doesNotMatch(clause, /### Architectural invariants/, "unrequested sections are omitted");
});

test("the drafted risk-model notes are live: plan judge brief embeds them", () => {
	const profile = parseProfile(SAMPLE_PROFILE);
	const p = { plan: "/p", slices: "/s", planJudgement: "/j" };
	const brief = planJudgeBrief(p, ["multi-tenancy"], profile);
	assert.match(brief, /### Risk model notes/, "riskNotes section reaches the plan judge");
	assert.match(brief, /tenant predicate/, "the actual risk-note text is injected");
});

test("architect hypothesis brief embeds the invariants section", () => {
	const profile = parseProfile(SAMPLE_PROFILE);
	const p = { arch: "/a", frame: "/f" };
	const brief = hypothesisBrief(p, { id: 1, angle: "minimal-change", brief: "x" }, false, undefined, profile);
	assert.match(brief, /### Architectural invariants & seams/);
	assert.match(brief, /Cypher lives in db\//);
});

test("PROFILE_SECTIONS keys match the ProjectProfile fields the clause reads", () => {
	const keys = PROFILE_SECTIONS.map((s) => s.key).sort();
	assert.deepEqual(keys, ["conventions", "dod", "domain", "invariants", "libs", "riskNotes"].sort());
});

// --- Layer 1: staleness ------------------------------------------------------

const THRESHOLDS = { staleAfterDays: 45, staleAfterCommits: 75 };

test("isProfileStale: fresh stamp is not stale", () => {
	const now = Date.parse("2026-06-30T00:00:00Z");
	const stamp = { capturedCommit: "abc", capturedAt: new Date(now).toISOString() };
	assert.equal(isProfileStale(stamp, { now, commitsSince: 3 }, THRESHOLDS).stale, false);
});

test("isProfileStale: over the commit threshold is stale (commits beat days)", () => {
	const now = Date.parse("2026-06-30T00:00:00Z");
	const stamp = { capturedCommit: "abc", capturedAt: new Date(now).toISOString() };
	const r = isProfileStale(stamp, { now, commitsSince: 200 }, THRESHOLDS);
	assert.equal(r.stale, true);
	assert.match(r.reason, /commits/);
});

test("isProfileStale: over the day threshold is stale even with no commit signal", () => {
	const now = Date.parse("2026-06-30T00:00:00Z");
	const stamp = { capturedCommit: null, capturedAt: new Date(now - 100 * 86_400_000).toISOString() };
	const r = isProfileStale(stamp, { now, commitsSince: null }, THRESHOLDS);
	assert.equal(r.stale, true);
	assert.match(r.reason, /days/);
});

test("isProfileStale: no stamp is never stale", () => {
	assert.equal(isProfileStale(null, { now: Date.now(), commitsSince: 9999 }, THRESHOLDS).stale, false);
});

test("promote writes a committed profile.json stamp, not gitignored", async () => {
	const cwd = repo({ lodash: "^4" });
	plantDraft(cwd);
	await runInit(fakeCtx(), DEFAULT_CONFIG, cwd, "deadbeef");
	const stamp = readProfileStamp(cwd);
	assert.equal(stamp.capturedCommit, "deadbeef");
	assert.match(stamp.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
	const gi = existsSync(join(cwd, ".gitignore")) ? readFileSync(join(cwd, ".gitignore"), "utf8") : "";
	assert.doesNotMatch(gi, /profile\.json/, "the stamp is shared like the manifest, not ignored");
});

test("profileStaleNudge: drifted profile returns a refresh nudge; no stamp returns nothing", async () => {
	const cwd = repo({ lodash: "^4" });
	assert.equal(await profileStaleNudge(cwd, "head", DEFAULT_CONFIG, undefined), "", "no stamp → no nudge");
	mkdirSync(join(cwd, ".slice-flow"), { recursive: true });
	writeFileSync(join(cwd, ".slice-flow", "profile.json"), JSON.stringify({ capturedCommit: "old", capturedAt: new Date().toISOString() }));
	const exec = async () => ({ code: 0, stdout: "200\n", stderr: "" });
	const nudge = await profileStaleNudge(cwd, "head", DEFAULT_CONFIG, exec);
	assert.match(nudge, /stale/);
	assert.match(nudge, /feature-init/);
});

// --- Layer 2: refresh-with-diff ----------------------------------------------

test("diffProfiles reports changed, added, and unchanged sections", () => {
	const existing = parseProfile(SAMPLE_PROFILE);
	const draftText = SAMPLE_PROFILE.replace("Tests: `npm test`. camelCase names.", "Tests: `npm run test`. kebab-case.").replace(
		"## Definition of done\nTests green and reviewer PASS.",
		"## Definition of done\n(none recorded)",
	);
	const draft = parseProfile(draftText);
	const d = diffProfiles(existing, draft);
	assert.ok(d.changed.includes("conventions"), "edited section is changed");
	assert.ok(d.unchanged.includes("domain"), "untouched section is unchanged");
});

test("diffProfiles marks a newly-filled section as added", () => {
	const existing = parseProfile(SAMPLE_PROFILE.replace("Cypher lives in db/ only.", "(none recorded)"));
	const draft = parseProfile(SAMPLE_PROFILE);
	const d = diffProfiles(existing, draft);
	assert.ok(d.added.includes("invariants"), "empty→filled is added");
});

test("confirmDraft refresh path surfaces the changed sections in the gate", async () => {
	const cwd = repo({ lodash: "^4" });
	mkdirSync(join(cwd, ".slice-flow"), { recursive: true });
	writeFileSync(projectMdPath(cwd), SAMPLE_PROFILE); // existing profile
	const draftText = SAMPLE_PROFILE.replace("Tests: `npm test`. camelCase names.", "Tests: `npm run test`. kebab-case files.");
	writeFileSync(join(cwd, ".slice-flow", "PROJECT.draft.md"), draftText);
	const ctx = fakeCtx({ approve: "Accept" });
	const text = await runInit(ctx, DEFAULT_CONFIG, cwd, "sha1");
	const title = ctx.calls.selectTitles.find((t) => /refresh/i.test(t));
	assert.ok(title, "the approval gate frames it as a refresh");
	assert.match(title, /Conventions/, "and names the changed section");
	assert.match(text, /Changed: Conventions/, "completion summary names the change");
	assert.equal(readFileSync(projectMdPath(cwd), "utf8"), draftText, "draft promoted");
	assert.equal(readProfileStamp(cwd).capturedCommit, "sha1", "stamp refreshed on promote");
});
