# ADR 0018: GitHub Issue as the sole requirements authority

- Status: Accepted for repository development and research governance
- Date: 2026-11-11
- Updated: 2026-11-11 — removed local Phase/Implementation Notes workflow

## Context

SwarmEnv's development goals and experiments have been coordinated through GitHub Issues and the Matt Pocock engineering skills. Introducing local Phase Charters or Issue Implementation Specs creates parallel requirements, duplicates the ticket graph and can confuse future Coding Agents about what the human approved.

The project's exploratory research also requires a clear separation between human decisions about the value of hypotheses and autonomous implementation/debugging work.

## Decision

1. **GitHub Issue is the sole requirements and acceptance source.** A human-approved Issue, including approved Agent Brief comments and later explicit decisions, defines why the change matters, desired behavior, experiments, scope and acceptance. Creating or labeling an Issue is not, by itself, permission to run new research or incur costs.
2. **Matt engineering skills govern development procedure.** Use `/to-spec` for Issue specs, optional `/to-tickets` for reviewed ticket dependencies, `/implement` or `/implement-spec` for implementation, `/tdd` and `/diagnosing-bugs` for verification, and `/code-review` and `/pr` for review and PR presentation. Engineering skills do not independently approve new product or research requirements.
3. **No local Phase/Implementation Spec directory.** Put code-level plans, cross-session pointers, reviews and implementation decisions in GitHub Issues/PRs and commits. Remove `docs/phases/` rather than maintaining a second working-plan system.
4. **Bounded Coding Agent autonomy.** Within approved scope and resource limits, Agents may implement, test, diagnose, fix and repeat without per-run approval. New hypotheses, changed architecture scope, benchmark/checker, provider/model, acceptance criteria or budget require human decisions.
5. **STATUS and Architecture are not competing requirement sources.** [STATUS](../STATUS.md) tracks Issue/PR/commit-linked progress and evidence. [Architecture](../architecture/INDEX.md) records the accepted system baseline, updated for accepted design-changing PRs and checked at Issue closeout. ADRs record the reasons for enduring choices.
6. **Formal experiments remain traceable.** Register approved research/acceptance runs via `EXP-YYYYMMDD-NN`. Ordinary deterministic tests and bounded in-scope diagnostic probes do not need a formal Experiment ID. Reports use **Results / Analysis / Next steps**.

## Consequences

The human-facing review and approval surface is GitHub. Coding Agents follow one spec and one task graph, preserve evidence through Issues/PRs and STATUS, and update Architecture only after a design change is accepted. No local Phase documentation competes with GitHub's approved work contract. Historical tracked documents remain available by their Git commits, without a working-tree archive.
