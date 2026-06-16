---
name: codegraph
description: Steers scout/builder agents to prefer codegraph CLI queries (query/context/callers/callees/impact/files, all with --json) over grep/find/read for code discovery, with an automatic grep fallback when codegraph returns nothing or is unavailable.
---

# codegraph

This workspace has a [codegraph](https://github.com/colbymchenry/codegraph) index
of the code. codegraph answers structural questions about the codebase far more
precisely than text search. **During code discovery, query codegraph before
reaching for grep/find/read.**

## Query commands

Always invoke these with the `--json` flag so the output is machine-readable:

- `codegraph query <term> --json` — search the graph for symbols matching a term.
- `codegraph context <symbol> --json` — gather the surrounding context for a symbol (definition + nearby relationships).
- `codegraph callers <symbol> --json` — list the call-graph edges that call into a symbol.
- `codegraph callees <symbol> --json` — list the call-graph edges a symbol calls out to.
- `codegraph impact <symbol> --json` — compute the blast radius of changing a symbol.
- `codegraph files <term> --json` — locate the files associated with a term or symbol.

## When to use it

When you need to find where something is defined, who calls it, what it calls,
which files hold it, or what a change would affect, run the matching codegraph
command **before grep/find/read**. It gives you structural answers (definitions,
call edges, impact) that text search cannot.

## Fallback rule

codegraph is a best-effort accelerator, not a hard dependency. **Fall back to
grep/find/read** whenever:

- a codegraph query returns no results / returns nothing,
- a codegraph command errors, or
- the `codegraph` CLI is unavailable (not installed or no index present).

Do not block on codegraph: if it cannot answer, immediately use grep/find/read
and continue.
