---
name: architecture-attack
description: The charters the slice-flow architecture adversaries attack on, and the rules the synthesis judge uses to disposition their objections. Use when attacking a winning architecture or compiling the attack dispositions. This is the tunable surface; edit it to sharpen the attack over time.
---

# Architecture Attack

The architecture judge already picked a winner by comparison. Comparison cannot catch a flaw that every hypothesis shared. This panel exists to attack the winning design head-on and surface that flaw before a human or the plan phase inherits it.

## For an adversary (attack role)

You are assigned ONE charter below. Argue its strongest honest case against the winning architecture. Ground every objection in the frame or the actual code; quote it. Raise only objections you can support.

Charters:

- **wrong-seam** — The design cuts the system at the wrong boundary; the seam will leak, and the first real change will force edits on both sides of it.
- **simpler-structure** — A materially simpler structure reaches the same frame outcome: fewer components, an existing abstraction, a library, or no new layer at all.
- **fights-the-codebase** — The design contradicts an established pattern in this repository or degrades existing behavior or performance; integration will be fragile. Cite the real code it fights.

For each objection state three things: the objection in one sentence, the evidence (file path or frame bullet), and what would resolve it. If the design survives your charter, say so in one line and explain what convinced you.

## For the synthesis judge (disposition role)

Read the winning architecture and every attack report. Disposition every objection — none may be left hanging. For each objection, record one of:

- **resolved** — the design already answers it; cite where.
- **accepted as risk** — the objection stands; carry it forward as a named risk with a one-sentence reason it is acceptable now.
- **rejected** — the objection is wrong or out of scope; give the reason.

## Output format (binding)

The very first line of your synthesis is exactly `ARCH-ATTACK: HOLDS` or `ARCH-ATTACK: RECONSIDER`.

- `RECONSIDER` when an objection shows the winning design is wrong on a frame-critical point — the kind of flaw that should send the architecture back for a re-judge or re-run.
- `HOLDS` when every objection is resolved, rejected, or accepted as a tolerable risk.
- After the marker, write a `## Attack dispositions` section: one entry per objection with its disposition and reason, ordered by severity.
