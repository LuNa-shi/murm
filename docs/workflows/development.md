# Development workflow — Matt engineering skills adapter

> Type: Project-specific workflow · Status: Active · Updated: 2026-11-11

SwarmEnv uses [Matt Pocock's engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering) as the preferred engineering workflow **when installed**. Do not rewrite or compete with those skills here. [AGENTS.md](../../AGENTS.md) defines SwarmEnv-specific authority, resource limits, evidence rules and documentation responsibilities.

## From problem to Issue

- Use `/to-spec` for a substantial new feature or design. Its **GitHub Issue is the spec**, containing Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions and Out of Scope.
- Review the relevant [GLOSSARY](../../GLOSSARY.md), [ADRs](../adr/INDEX.md) and [Architecture](../architecture/INDEX.md). Agree with the human on intended observable behavior, scope and important testing seams.
- If triage produced an accepted Agent Brief, read it alongside the Issue and later decisions. Do not assume an old Issue body overrides an explicitly approved later change.
- `/to-tickets` is optional: use it when independent, complete vertical slices and blocking edges will help. The human reviews the split before publication. Do **not** force every large Issue into sub-Issues: [Issue #111](https://github.com/LuNa-shi/SwarmEnv/issues/111) used one Issue for several implementation PRs.

## Implementation and review

- Use `/implement` for a single Issue or ticket; use `/implement-spec` for a ticket graph, following its integration branch and separate worktree process. Ticket state and dependencies stay on GitHub.
- Follow `/tdd` at pre-agreed public seams. Use `/diagnosing-bugs` to reproduce and reduce failures. Iterate within approved scope without asking for permission after every test or probe.
- Run focused tests and full tests when available, then use `/code-review` to review **Standards** and **Spec** separately. Correct review findings before completing the PR.
- Use `/pr` to present a concise Summary, before/after Evidence, and Merge Danger. Link the originating Issue and tested commit.
- If a skill is unavailable, follow its equivalent documented behavior without claiming the skill ran.

## SwarmEnv-specific synchronization

- The **GitHub Issue or accepted Agent Brief** owns intended behavior and acceptance. A local [Issue implementation note](../phases/INDEX.md) is optional and records code-level decisions and context pointers, not a second spec.
- Maintain [STATUS](../STATUS.md) at meaningful implementation/evidence milestones. Do not copy full Issue discussions or raw debugging logs into STATUS.
- When a design-changing PR is accepted for merge, synchronize the affected [Architecture](../architecture/INDEX.md); at Issue closeout verify the agreed design, merged code and evidence.
- Formal paid or research experiments require approval under [the experiment workflow](experiment.md). In-scope deterministic tests and bounded authorized debug probes do not require a formal EXP ID.
- Escalate changes to research direction, accepted contract, experiment controls, or resource budgets. Do not change unrelated Issue state or merge unapproved PRs.
