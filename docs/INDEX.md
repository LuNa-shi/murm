# SwarmEnv documentation index

> Status: Active · Documentation reviewed 2026-11-11
>
> This is the entry point to current maintained documents. Retired design plans and old experimental reports can be recovered from pinned Git commits, not from a parallel `archive/` tree.

## Documentation map

| Question | Source | Responsibility |
|---|---|---|
| Why do we research this system? | [PROJECT.md](PROJECT.md) | Broad research motivation; not an approved implementation request |
| What must the next work item accomplish? | **Human-reviewed GitHub Issue** | Approved motivation, scope, observable outcomes, constraints and acceptance criteria |
| How will the Coding Agent implement an Issue? | [phases/INDEX.md](phases/INDEX.md) | Optional Issue-numbered implementation specs, derived from GitHub Issues |
| What system design has been accepted? | [architecture/INDEX.md](architecture/INDEX.md) | Maintained architecture baseline, updated with accepted changes |
| What has been implemented and verified? | [STATUS.md](STATUS.md) | Continuous Issue/PR-linked progress and evidence |
| How should an Agent develop and review changes? | [workflows/development.md](workflows/development.md) | Independent implementation and testing within the approved Issue |
| How should approved research runs be executed? | [workflows/experiment.md](workflows/experiment.md) | Debugging probes vs. preregistered formal experiments |
| Where are formal experimental reports? | [experiments/INDEX.md](experiments/INDEX.md) | Run registration, evidence and report template |
| Why was an important design choice made? | [adr/INDEX.md](adr/INDEX.md) | Decisions and tradeoffs |
| How are benchmark and observation services operated? | [operations/benchmark.md](operations/benchmark.md), [operations/observability.md](operations/observability.md) | Operational references verified against current source |

[AGENTS.md](../AGENTS.md) governs human/Coding Agent permissions. [GLOSSARY.md](../GLOSSARY.md) defines domain vocabulary; the [experiment-analysis skill](../.codex/skills/experiment-analysis/SKILL.md) explains evidence reconstruction.

## Design authority and lifecycle

**GitHub Issue → optional Implementation Spec → implementation and evidence in STATUS → accepted Architecture.**

- A **human-reviewed Issue** is authoritative for its explicitly approved change. The Implementation Spec is the Agent's technical plan and never changes the Issue's intended outcome.
- **Architecture** is the accepted baseline outside that change. It is updated as design-changing PRs are accepted, and reconciled at Issue closeout. It does not become a log of unverified technical proposals.
- **STATUS** follows implementation and verification progress, distinguishing code changes, tests, controlled probes, real-Agent observations and unknowns.
- Source and tool schemas show what actually executes; tests and experiment records substantiate what was observed. Historic evidence does not silently replace an approved requirement.
- ADRs preserve the reasoning behind major decisions, rather than creating another authority for an Issue's acceptance criteria.

No independently approved Phase plan is required for normal work. A broader research effort may link several Issues, but approval still belongs to the Issue or an explicit human decision. See AGENTS.md for the complete permission rules.

## Historical documents

The [pre-cleanup `docs/` tree at `02adbb43`](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs) preserves previous tracked documents in Git history. Raw experiments in ignored local storage may not exist in Git. Do not recreate `archive/`, old redirects or `CONTEXT.md` for documentation versioning.
