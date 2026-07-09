/**
 * Configuration for simple-flow. Own overlay file, own shape — never reads
 * slice-flow's config or slice-flow.json. See simple-flow's slice 001 acceptance
 * criteria (frame criterion 11).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SimpleFlowConfig {
	enabled: boolean;
	debug?: boolean;
}

export const DEFAULT_CONFIG: SimpleFlowConfig = { enabled: false };

/** DEFAULT < ~/.pi/simple-flow.json < <cwd>/simple-flow.json. Reads simple-flow's
 * OWN file only — never slice-flow.json, never SliceFlowConfig. `homeDir` is
 * injectable so tests can point the global lookup at a temp dir. */
export function loadConfig(cwd: string, homeDir: string = homedir()): SimpleFlowConfig {
	let cfg: SimpleFlowConfig = { ...DEFAULT_CONFIG };
	for (const f of [join(homeDir, ".pi", "simple-flow.json"), join(cwd, "simple-flow.json")]) {
		if (existsSync(f)) {
			try {
				cfg = { ...cfg, ...JSON.parse(readFileSync(f, "utf8")) };
			} catch (e) {
				throw new Error(`${f} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	return cfg;
}
