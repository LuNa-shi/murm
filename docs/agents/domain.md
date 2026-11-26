# Domain documentation configuration

> Configuration for Matt Pocock's engineering skills · Single-context repository

**Phase 0005:** read the [authoritative Core / Harness design on main](../phases/0005-core-harness/README.md) first. This stage’s Issues derive requirements and acceptance from its exact revision; design changes go through a documentation PR before affected tickets are updated. Core/Runtime/Slot/workDir target vocabulary is defined there. Current Architecture and the legacy glossary remain evidence of implemented behavior, not proof that the new design is implemented. Other stages retain the Issue-led rules below.

- Root [GLOSSARY.md](../../GLOSSARY.md) is the shared entry to murm vocabulary. It defines the approved Phase 02 vocabulary used by the current runtime; Architecture distinguishes the registered Agent path from retained compatibility APIs. Do not present pending Issue changes as implemented behavior. Do not create a competing `CONTEXT.md` for this single-context repository.
- Accepted design and module boundaries live in [Architecture](../architecture/INDEX.md). Approved changes to those boundaries are specified by the relevant human-reviewed GitHub Issue or accepted Agent Brief.
- Long-lived design rationale belongs in [ADRs](../adr/INDEX.md). ADRs do not replace the current approved Issue's acceptance criteria.
- Numbered [phase designs](../phases/INDEX.md) are versioned attachments to their design Issues. They contain proposed models, protocols, prompt/skill text, validation and migration, with approval tied to an exact revision. They do not replace the current implementation manual.
- Coding Agent instructions are in [AGENTS.md](../../AGENTS.md), and practical work guidance is in the [development workflow](../workflows/development.md).

When using `/to-spec`, `/to-tickets`, `/tdd`, `/code-review` or `/triage`, use these domain terms. Propose any newly necessary domain term or architecture rule to the human owner before treating it as an accepted requirement.

