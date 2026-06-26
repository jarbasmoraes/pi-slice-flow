# Tech Debt

Tracked, deferred work. Each item: what, why deferred, trigger to fix, proposed fix.

---

## DEBT-001 — Playwright research extension: one browser per extension process (memory under fan-out)

- **Status:** open
- **Logged:** 2026-06-25
- **Area:** `extensions/web-research.ts` (Playwright-backed `web_search` / `fetch_content` / `get_search_content`)

### What
The v1 Playwright-backed research extension launches **one headless Chromium per extension
process**, reused across calls within that process (ephemeral context per call). It does **not**
use a shared browser server.

### Why it's debt
slice-flow runs research as a **parallel subagent fan-out**. Each subagent is its own process and
loads its own copy of the extension, so N parallel researchers ⇒ **N browser instances**
(~150–300MB each). Under a large fan-out this can exhaust host memory.

### Why deferred (decision 2026-06-25)
- Accepted the per-process model for v1 to keep it simple and avoid premature infrastructure.
- Current research fan-outs are small enough that N browsers is tolerable.
- "No shared server" was an explicit decision for now.

### Trigger to fix
- Research fan-out grows (or OOM / swap thrash observed during a parallel research run), **or**
- We start running many researchers concurrently on a memory-constrained host.

### Proposed fix (v2)
Switch to a **connect-to-one-shared-browser** model: launch a single headless Chromium **server**
once (lazily, with a port/lock guard), and have every extension instance `connectOverCDP()` /
`connect()` to it instead of spawning its own. All researchers then share one browser with
per-agent isolated contexts. Add a global concurrency cap on contexts/pages.

### Notes
- Keep ephemeral-context-per-call and the SSRF / no-bash / no-persistent-profile guarantees in v2.
- Don't build this until the trigger fires (avoid over-engineering).
