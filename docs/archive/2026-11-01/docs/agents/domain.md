# Domain Docs

How the engineering skills should consume this repository's domain documentation.

## Before exploring, read these

- `CONTEXT.md` at the repository root, or `CONTEXT-MAP.md` if it exists.
- `docs/adr/` for architecture decisions that touch the area being changed.

If these files do not exist, proceed silently. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## File structure

This is a single-context repository:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-example-decision.md
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept, use the term as defined in `CONTEXT.md`. If the needed concept is not defined there, treat that as a signal to clarify the domain model or record the gap through `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
