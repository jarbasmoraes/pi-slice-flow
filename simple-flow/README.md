# simple-flow

A lightweight Pi package for tracking your own work in Todoist through explicit
slash commands — a simpler sibling to `slice-flow` with no board-section state
machine, no reviews, and no LLM in the write path. Todoist is touched only when
a command runs, never inferred from conversation.

## Install

simple-flow is a Pi package and must be registered before its slash commands are
reachable. Like any Pi package, it is loaded only when listed in a `packages`
array of a global or project `settings.json`; a sibling directory next to
`slice-flow/` is **not** auto-discovered.

```bash
pi install -l /path/to/simple-flow    # project scope (writes .pi/settings.json)
pi install /path/to/simple-flow       # or user scope (~/.pi/agent/settings.json)
```

This repository ships a project-scoped `.pi/settings.json` that already lists
`../simple-flow`, so the six commands are reachable when Pi runs from the repo
root.

## Enable

simple-flow reads its own enable flag from its own config (never `slice-flow.json`)
and is **off by default**. Turn it on with a `simple-flow.json` in the project
root or `~/.pi/simple-flow.json`:

```json
{ "enabled": true }
```

## Commands

- `/simple-task <prompt>` — pick a Todoist project, create the task, track it, print its id.
- `/simple-status` — report the active tracked task.
- `/simple-comment <text>` — add exact text as a comment on the tracked task.
- `/simple-update <fields>` — change content/description/due/priority (never labels).
- `/simple-finish` — close the tracked task.
- `/simple-resume` — list a project's active tasks and pick one to track.

## Requirements

- The [Composio CLI](https://composio.dev) installed, on `PATH`, and authed for
  Todoist. simple-flow's client is **fail-loud**: a missing, unauthed, or failing
  CLI produces a clear user-visible error, never a silent success.
