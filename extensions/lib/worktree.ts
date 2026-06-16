/**
 * Git worktree isolation primitives. Dependency-free and exec-injected so it
 * stays unit-testable: it imports only node:path and never reaches for a Pi
 * package, workspace, or engine. The caller supplies an `Exec` that runs a
 * command and reports its exit code plus captured output.
 */

import { join } from "node:path";

/** Container directory (relative to the repo root) for slice-flow worktrees. */
export const WORKTREES_DIR = ".pi/worktrees";

/** A created worktree, persisted into State so later phases can run inside it. */
export interface WorktreeInfo {
	cwd: string;
	branch: string;
	path: string;
	created_at: string;
}

/** A command runner: resolves with the exit code and captured streams. */
export type Exec = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number; cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Create a git worktree under `.pi/worktrees/<slug>/` on its own
 * `slice-flow/<slug>` branch. Throws when git exits non-zero (recording
 * nothing); returns the WorktreeInfo on success.
 */
export async function createWorktree(exec: Exec, cwd: string, slug: string): Promise<WorktreeInfo> {
	const path = join(cwd, WORKTREES_DIR, slug);
	const branch = `slice-flow/${slug}`;
	const res = await exec("git", ["worktree", "add", "-b", branch, path], { cwd, timeout: 30000 });
	if (res.code !== 0) {
		throw new Error(`git worktree add failed (code ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
	}
	return { cwd: path, branch, path, created_at: new Date().toISOString() };
}
