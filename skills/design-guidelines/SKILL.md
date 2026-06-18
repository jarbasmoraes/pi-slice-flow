---
name: design-guidelines
description: How a slice-flow planner and builders conform new UI to a repository's EXISTING design — discover the established patterns first, reuse them, and never invent new visual vocabulary. Use when the feature extends an existing UI (the non-greenfield path).
---

# Design Guidelines

This feature extends a UI that already exists. Your job is to make the new work indistinguishable from what is already there. The repository is the style guide; discover it and conform to it. Inventing a new visual vocabulary is a defect, not a contribution.

## Discover before you design (binding)

Before specifying or building any UI, find and read the existing patterns. Do not guess:

1. **Components** — locate the existing component library or directory. Reuse a component before creating one; extend it before forking it.
2. **Tokens** — find the established colors, spacing scale, typography, and breakpoints (theme file, CSS variables, Tailwind config, design tokens). Use them; never hard-code a new value that duplicates an existing token.
3. **Layout and interaction** — find how comparable screens already handle navigation, forms, loading, empty, and error states. Mirror them.
4. **Naming and structure** — follow the repository's file layout, component naming, and styling approach (the existing one — CSS modules, styled-components, Tailwind, whatever is there).

Cite what you found by file path in the plan or memo, so a reviewer can verify the conformance.

## Hard rules

- Reuse existing components and tokens. A new component is justified only when nothing existing fits, and it must be built from the existing tokens.
- No new visual patterns: no new color, no new spacing unit, no new font, no new interaction idiom that the app does not already use.
- New UI components live one per file, matching the repository's component conventions.
- Match existing accessibility and responsive behavior; do not regress it.
- When the existing patterns genuinely cannot express what the frame needs, do not invent silently — flag the gap in the plan or memo and name the smallest addition required.

## Quality bar

- A user cannot tell the new UI from the old: same components, same spacing, same tone.
- Every visual value traces to an existing token, or to a flagged, justified addition.
- A reviewer can open the cited existing files and confirm the new work follows them.
