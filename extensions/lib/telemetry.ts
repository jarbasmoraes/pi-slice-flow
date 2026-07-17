/**
 * The single module that talks to Langfuse. It uses the ingestion REST API
 * directly (`POST /api/public/ingestion`), where every trace / observation /
 * score is upserted by a caller-chosen `body.id`. That by-id merge is what makes
 * slice-flow's telemetry survive a `/reload`: the workflow is resumable across
 * process restarts with no in-memory conversation, so deterministic entity ids
 * that merge server-side are the right model — the v4/v5 OTel JS SDK, whose span
 * ids are process-lifetime in-memory handles that cannot be reopened, is not.
 *
 * No SDK and no OpenTelemetry dependency: just authenticated `fetch`. Every
 * method is fail-soft — a disabled flag, a missing key, or a dead host degrades
 * to a no-op and never throws into the workflow.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SliceFlowConfig } from "./config.ts";

export interface TraceArgs {
	id: string;
	name?: string;
	sessionId?: string;
	userId?: string;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
	/** Top-level Langfuse trace tags — the only field that feeds the
	 * "Trace Tags" filter panel (metadata does NOT). */
	tags?: string[];
}

export interface ObservationArgs {
	id: string;
	traceId: string;
	name?: string;
	parentObservationId?: string;
	/** Present on open (tool_call); absent on close. */
	startTime?: string;
	/** Present on close (tool_result); absent on open. */
	endTime?: string;
	input?: unknown;
	output?: unknown;
	model?: string;
	usageDetails?: Record<string, number>;
	costDetails?: Record<string, number>;
	metadata?: Record<string, unknown>;
	level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
}

export interface ScoreArgs {
	id: string;
	traceId: string;
	name: string;
	value: number;
	comment?: string;
	observationId?: string;
}

export interface Telemetry {
	readonly enabled: boolean;
	trace(a: TraceArgs): void;
	/** Upsert one observation. An open carries `startTime`; a close carries
	 * `endTime` (and the same `id`), merging server-side. */
	observation(a: ObservationArgs): void;
	score(a: ScoreArgs): void;
	flush(): Promise<void>;
}

interface IngestionEvent {
	id: string;
	type: string;
	timestamp: string;
	body: Record<string, unknown>;
}

export type SendFn = (batch: IngestionEvent[]) => Promise<void>;

const NOOP: Telemetry = {
	enabled: false,
	trace() {},
	observation() {},
	score() {},
	async flush() {},
};

/** Drop undefined fields so the ingestion body stays minimal. */
function clean<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
	return out;
}

/** Build a Telemetry that buffers ingestion events and ships them via `send` on
 * flush. Returns a no-op when `enabled` is false. `send` is injectable so tests
 * can capture batches without a live Langfuse. */
export function createTelemetry(opts: { enabled: boolean; send: SendFn; debug?: boolean }): Telemetry {
	if (!opts.enabled) return NOOP;
	const buffer: IngestionEvent[] = [];
	const push = (type: string, body: Record<string, unknown>): void => {
		try {
			buffer.push({ id: randomUUID(), type, timestamp: new Date().toISOString(), body });
		} catch {
			/* telemetry must never throw into the workflow */
		}
	};
	return {
		enabled: true,
		trace(a) {
			push("trace-create", clean({ ...a }));
		},
		observation(a) {
			// Per-directive runs are modelled as generations so real token cost
			// surfaces in Langfuse. Open (startTime) creates; close (endTime, no
			// startTime) updates the same id.
			const isClose = !!a.endTime && !a.startTime;
			push(isClose ? "generation-update" : "generation-create", clean({ ...a }));
		},
		score(a) {
			push("score-create", clean({ ...a }));
		},
		async flush() {
			if (buffer.length === 0) return;
			const batch = buffer.splice(0, buffer.length);
			try {
				await opts.send(batch);
			} catch (e) {
				if (opts.debug) console.error("[slice-flow telemetry] flush failed:", e);
			}
		},
	};
}

/** A fetch-backed transport to the Langfuse ingestion endpoint, with a hard
 * timeout so a dead host can never hang a turn. */
function httpSend(baseUrl: string, publicKey: string, secretKey: string): SendFn {
	const url = `${baseUrl.replace(/\/+$/, "")}/api/public/ingestion`;
	const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
	return async (batch) => {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 5000);
		try {
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: auth },
				body: JSON.stringify({ batch }),
				signal: ctrl.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Minimal KEY=VALUE parser for a project `.env` file — no dependency, since
 * this module deliberately carries none. Blank lines and '#' comments are
 * skipped; quoted values keep their contents verbatim, unquoted values are
 * trimmed. Not a general-purpose dotenv implementation — just enough to read
 * the three LANGFUSE_* keys a project might keep alongside its other secrets. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const raw = trimmed.slice(eq + 1).trim();
		const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
		out[key] = quoted ? quoted[1] : raw;
	}
	return out;
}

/** Read `<cwd>/.env` for LANGFUSE_* fallback credentials. Fails soft to {} — a
 * missing or unreadable file is not an error, telemetry just stays off. */
function readProjectEnv(cwd: string): Record<string, string> {
	try {
		return parseEnvFile(readFileSync(join(cwd, ".env"), "utf8"));
	} catch {
		return {};
	}
}

let singleton: Telemetry | null = null;

/** The process-wide telemetry client. Memoized so the event buffer accumulates
 * across the parent's tool calls within a turn and a single flush ships them —
 * and so only the FIRST call in a process's lifetime needs a real `cwd`; every
 * later call (e.g. `recordGate`, which has no `cwd` in scope) reuses whatever
 * this one resolved. No-op unless `cfg.telemetry.enabled` and all three
 * LANGFUSE_* values are present, checking `process.env` first and falling back
 * to `<cwd>/.env` — pi does not itself load a project's `.env`, so a repo that
 * keeps its Langfuse keys there (rather than in the shell's own environment)
 * still works. */
export function getTelemetry(cfg: SliceFlowConfig, cwd?: string): Telemetry {
	if (singleton) return singleton;
	if (cfg.telemetry?.enabled !== true) {
		singleton = NOOP;
		return singleton;
	}
	const projectEnv = cwd ? readProjectEnv(cwd) : {};
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? projectEnv.LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY ?? projectEnv.LANGFUSE_SECRET_KEY;
	const baseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? projectEnv.LANGFUSE_BASE_URL ?? projectEnv.LANGFUSE_HOST;
	const enabled = !!publicKey && !!secretKey && !!baseUrl;
	singleton = enabled ? createTelemetry({ enabled: true, send: httpSend(baseUrl, publicKey, secretKey), debug: cfg.telemetry?.debug }) : NOOP;
	return singleton;
}

/** Test/seam hook: drop the memoized client so the next getTelemetry re-reads env/config. */
export function resetTelemetry(): void {
	singleton = null;
}
