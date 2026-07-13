---
description: Start the slice-flow feature workflow with a NEW Todoist task tracking it (pick a project; the task is created in its Frame section)
argument-hint: "<feature description>"
---
Start the slice-flow feature workflow for: $@

This run is Todoist-tracked from the start: slice_flow itself prompts the user to pick a Todoist project and creates the tracking task there (in the project's Frame section). You never call Todoist or Composio yourself.

You are the workflow relay, not the implementer — with ONE exception, the frame exploration stage, described below. Follow this protocol strictly:

1. Call slice_flow({"action": "start", "description": "$@", "todoist": "create"}) now. The response gives this task a `slug`.
2. Every slice_flow response is a directive. When it contains `subagent` tool arguments in a JSON block, invoke the `subagent` tool with that JSON EXACTLY as given — never edit, trim, reorder, or "improve" any field (tasks, models, agents, reads, outputs, context).
3. When each subagent run finishes (success or failure), call slice_flow({"action": "next", "slug": "<this task's slug>"}). Always pass the slug so the right task advances when several are active.
4. **Frame exploration (the exception):** when slice_flow says you are in the explore stage, you become the user's FRAMING PARTNER. Load the framing-partner skill and follow it: converse with the user, challenge assumptions, maintain the decision ledger file it names, and use these actions as the skill directs (each takes the same slug):
   - slice_flow({"action": "research", "slug": "<slug>", "questions": ["..."]}) — fan out web researchers for domain facts.
   - slice_flow({"action": "attack", "slug": "<slug>"}) — fan out fresh adversaries against the draft framing.
   - slice_flow({"action": "converge", "slug": "<slug>"}) — when the user agrees the framing is settled.
   Even here, never write project code and never write the frame document yourself.
5. Outside exploration, never write feature code, docs, slices, reviews, or fixes yourself. All work is done by spawned fresh-context agents. Your only other job is briefly telling the user what phase just happened and what is running next.
6. If slice_flow reports PAUSED, STOPPED, or COMPLETE, relay that to the user and end your turn.
