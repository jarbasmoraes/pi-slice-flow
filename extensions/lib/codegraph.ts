/**
 * Codegraph perception: at workflow start, decide whether the project has a
 * usable codegraph index and turn that into a one-time startup message. Pure
 * classification is separated from the disk/CLI probe so it stays testable
 * without a filesystem or a subprocess.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type CodegraphState = "ready" | "nudge" | "silent";

/** A narrow command runner: only the exit code is consulted here. */
type ExecProbe = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number; cwd?: string },
) => Promise<{ code: number }>;

/** Pure: an index makes us `ready`; the CLI alone makes us `nudge`; neither is `silent`. */
export function classifyCodegraph(graphDbExists: boolean, cliOnPath: boolean): CodegraphState {
	if (graphDbExists) return "ready";
	if (cliOnPath) return "nudge";
	return "silent";
}

/**
 * Pure-ish disk probe: is there a codegraph index under `<cwd>/.codegraph/`?
 * codegraph names its database after the project (e.g. `codegraph.db`), not a
 * fixed `graph.db`, and its own `.gitignore` matches `*.db` — so detect any
 * `*.db` file in the directory rather than a single hard-coded name.
 */
export function codegraphIndexExists(cwd: string): boolean {
	const dir = join(cwd, ".codegraph");
	if (!existsSync(dir)) return false;
	try {
		return readdirSync(dir).some((f) => f.endsWith(".db"));
	} catch {
		return false;
	}
}

/**
 * Is a codegraph index reachable from `start` by walking up to (and including)
 * `repoRoot`? The build/verify agents run in a nested worktree
 * (`<repoRoot>/.pi/worktrees/<slug>/`), and `.codegraph/` is gitignored so it is
 * never checked into that worktree — the only physical index sits at the repo
 * root, an ancestor of the worktree. A codegraph CLI that discovers its project
 * root resolves that ancestor index, so reachability is an ancestor walk, not a
 * single-dir check. The walk is bounded to within `repoRoot` so a stray
 * `.codegraph/` elsewhere on disk is never mistaken for this project's index; if
 * `start` somehow escapes the repo, only `start` itself is checked.
 */
export function codegraphIndexReachable(start: string, repoRoot: string): boolean {
	const top = resolve(repoRoot);
	let dir = resolve(start);
	if (dir !== top && !dir.startsWith(top + sep)) return codegraphIndexExists(dir);
	while (true) {
		if (codegraphIndexExists(dir)) return true;
		if (dir === top) return false;
		const parent = dirname(dir);
		if (parent === dir) return false; // filesystem root: stop
		dir = parent;
	}
}

/** Pure: the one-time startup line for each state ("" means say nothing). */
export function codegraphPreamble(cls: CodegraphState): string {
	switch (cls) {
		case "ready":
			return "Codegraph recon is active: the scout and builder use codegraph to navigate this codebase.";
		case "nudge":
			return "Codegraph CLI detected but no index found — run `codegraph init` to enable code-graph-aware recon.";
		case "silent":
			return "";
	}
}

/**
 * Probe the project from the tree the agents will actually run in (`cwd`): a
 * `*.db` index reachable by walking up to `repoRoot` means `ready` without
 * touching the CLI. `repoRoot` defaults to `cwd`, so a non-isolated run is a
 * single-dir check exactly as before; an isolated run passes the worktree as
 * `cwd` and the repo root as `repoRoot` so the ancestor index is found (or, if
 * the worktree ever lives outside the repo, honestly is not). Otherwise ask
 * whether `codegraph` is on PATH; `nudge` when the probe exits 0, `silent` on
 * any non-zero exit or thrown error.
 */
export async function detectCodegraph(cwd: string, exec: ExecProbe, repoRoot: string = cwd): Promise<CodegraphState> {
	if (codegraphIndexReachable(cwd, repoRoot)) return classifyCodegraph(true, false);
	let cliOnPath = false;
	try {
		const res = await exec("which", ["codegraph"], { timeout: 5000 });
		cliOnPath = res.code === 0;
	} catch {
		cliOnPath = false;
	}
	return classifyCodegraph(false, cliOnPath);
}
