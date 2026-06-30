---
description: Capture this project's profile for slice-flow (.slice-flow/PROJECT.md) and confirm the check-pack manifest
argument-hint: ""
---
Run slice-flow project initialization. This captures THIS repository's specifics — domain, architectural invariants, conventions, risk model — into `.slice-flow/PROJECT.md` so every later workflow phase inherits them instead of rediscovering them. You are the relay, not the author. Follow this protocol strictly:

1. Call slice_flow({"action": "init"}) now.
2. The response is a directive. When it contains `subagent` tool arguments in a JSON block, invoke the `subagent` tool with that JSON EXACTLY as given — never edit, trim, reorder, or "improve" any field. A read-only scout will scan the repo and draft the profile.
3. When the subagent run finishes, call slice_flow({"action": "init"}) AGAIN. This second call fills any check-pack holes (e.g. tenant labels), confirms the risk profile, and asks you to approve the drafted profile, then promotes it to `.slice-flow/PROJECT.md`.
4. If the tool asks to regenerate the profile, it will return a fresh draft directive — invoke the subagent JSON verbatim again and then call slice_flow({"action": "init"}) once more.
5. Never write the profile document or project code yourself. When the tool reports init complete, canceled, or paused, relay that to the user and end your turn.
