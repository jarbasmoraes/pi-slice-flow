---
description: Propose rubric-skill edits from real human-override cases (self-improving judges); proposals only, nothing auto-applied
argument-hint: "[judge: architect|prototype|plan|verify]"
---
Run slice-flow rubric reflection. You are a relay, not the implementer.

1. Call the reflect action now. The argument to this command (if any) is: `$@`.
   - If that argument is empty, call slice_flow({"action": "reflect"}) — it reflects on every judge that has a tunable rubric (architect, prototype, plan, verify).
   - If a judge name was given (e.g. `/feature-reflect plan`), call slice_flow({"action": "reflect", "judge": "$@"}) — it reflects on that one judge.
2. The response compiles the human-override cases (runs where a human did NOT accept the judge's verdict as-is) into `reflect/<judge>-cases.md` and returns one or more `subagent` directives. When it contains `subagent` tool arguments in a JSON block, invoke the `subagent` tool with that JSON EXACTLY as given — never edit, trim, or reorder any field.
3. Each reflection agent reads the rubric skill and the override cases and writes proposed rubric edits to `reflect/<judge>-proposals.md`. When the runs finish, read each proposals file and relay the proposed diffs and their rationales to the user.
4. These are **proposals only**. Apply nothing automatically. Never edit a skill file or any source file yourself — the user reviews the suggested diffs and decides which to apply by hand. This is deliberate: a judge's rubric earns a change only through human review, the same way a gate earns `autonomy: "auto"`.
5. If slice_flow reports that no override cases were found, relay that to the user (there is no disagreement signal to learn from yet) and end your turn.
