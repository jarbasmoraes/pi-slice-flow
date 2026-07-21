import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelMode } from "./config.ts";

/** Persist the project-level provider mode without discarding its other
 * slice-flow settings. A same-directory rename keeps the update atomic. */
export function setProjectModelMode(cwd: string, modelMode: ModelMode): string {
	const path = join(cwd, "slice-flow.json");
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("top level must be an object");
			config = parsed as Record<string, unknown>;
		} catch (error) {
			throw new Error(`${path} cannot be updated: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify({ ...config, modelMode }, null, "\t")}\n`, "utf8");
		renameSync(temporaryPath, path);
	} catch (error) {
		throw new Error(`Could not save ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return path;
}
