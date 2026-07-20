---
description: Escalate a halted fusion-harness /auto-validate run (.fusion/escalation.md) into the full slice-flow workflow
argument-hint: "[path to escalation.md — defaults to .fusion/escalation.md]"
---
Escalate a gated-tier failure into the full slice-flow feature workflow.

1. Read the escalation handoff: use the path given as "$@" if non-empty, otherwise `.fusion/escalation.md` in the project root. If the file does not exist, STOP and tell the user there is nothing to escalate (a handoff is only written when `/auto-validate` halts with its gate still red).
2. From the handoff extract: the verbatim task (the "## Task (verbatim)" section), the gate script path, the failure history, and the validator triage if present.
3. Call slice_flow({"action": "start", "description": "<one paragraph: the verbatim task, then one sentence noting it already FAILED the gated tier after N validation rounds, then: 'Escalation evidence: <path to escalation.md> (gate script, failure history, triage) — the framing MUST read it and treat those failures as constraints, not suggestions.'"}).
4. From here follow the standard workflow protocol exactly as /feature does: relay directives verbatim, invoke the `subagent` tool with directive JSON unedited, call slice_flow({"action":"next","slug":"<slug>"}) after each run, and become the FRAMING PARTNER during explore — where your first move is walking the user through WHY the gated tier failed (use the failure history and triage as the opening evidence in the decision ledger).
5. Never write project code or the frame document yourself. If slice_flow reports PAUSED, STOPPED, or COMPLETE, relay that and end your turn.
