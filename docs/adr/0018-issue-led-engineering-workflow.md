# ADR 0018: Issue-led development and a complete implementation manual

- Status: Governance decision, amended in [PR #116](https://github.com/LuNa-shi/SwarmEnv/pull/116) and by the owner's 2026-11-12 request recorded in [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122).
- Date: 2026-11-11; phase-design amendment: 2026-11-12.
- Scope: Development documentation and research evidence; no runtime algorithm change.

## Context

The owner approves stages through GitHub Issues and understands the system through `docs/architecture/`, without reading source. A second phase/spec directory duplicates the Issue and can drift. Short module summaries also leave the owner unable to inspect real behavior, especially composed prompts, lifecycle transitions and implementation limitations.

On 2026-11-12 the owner explicitly requested a design Issue, a corresponding PR and a complete numbered `docs/phases/` design for the next major stage. This supersedes the earlier blanket ban on that directory. The need is a coherent, versioned design that can be reviewed chapter by chapter; approvals and progress must still have one home.

Experiments answer a different question: what actually happened for a particular code revision, input, prompt and resource budget. Replacing those records with a description of today's implementation would lose the evidence needed to judge progress.

## Alternatives considered

| Approach | Tradeoff |
|---|---|
| Issue plus a parallel repository phase/spec ledger | Adds a second place to approve and synchronize the same plan |
| Issue as the only documentation, including implementation details | Plans and discussion become difficult to use as a coherent manual of the current system |
| Delete experimental reports when architecture changes | Hides the version-bound observations behind research conclusions |
| Keep a complete implementation manual, with a small decision and evidence layer | Requires documentation updates in implementation PRs, while preserving a clear owner for each kind of information |
| Issue plus an explicitly linked, versioned phase design | Supports detailed design review; requires the Issue to name the accepted revision and prevents a second approval/status ledger |

## Decision

The human-approved GitHub Issue is the sole approval authority for requirements and acceptance: it owns the intended outcome, constraints and resource authorization. An accepted Agent Brief and later approved decisions belong to its discussion. Creating or labeling an Issue does not independently authorize new research or spending. Approvals, progress and handoffs remain in its Issue/PR discussion.

Numbered [phase designs](../phases/INDEX.md) are maintained as version-controlled attachments to their design Issue, reviewed in corresponding PRs. The Issue links the exact accepted document revision. A phase design may contain the complete proposed model, protocol, prompts/skills, verification plan and migration, but cannot expand approved scope or authorize implementation, spending or merge merely by being edited. Distinguish accepted direction, detail awaiting review, implemented behavior and verification evidence. Do not recreate a separate STATUS/CONTEXT/archive ledger or restore obsolete phase files.

Installed Matt Pocock engineering skills govern the engineering procedure, with project-specific rules in [AGENTS.md](../../AGENTS.md). Routine implementation and verification within approved scope remain autonomous. Changes to hypotheses, intended behavior, architecture scope, benchmark/checker, provider/model, acceptance or budget require human decisions; skills do not independently grant those approvals.

[Architecture](../architecture/INDEX.md) is the complete manual of the reviewed implementation: flow, state, storage, interfaces, full repository-controlled prompts, defaults, failures, cleanup and known discrepancies. Update it in the same PR as runtime changes. At each Issue/stage closeout reconcile it with the final merged code and evidence. Generated references and source fingerprints detect mechanical drift; explanatory review establishes what those changes mean.

GitHub Issues and PRs record implementation and verification milestones, including tested commits and unresolved gaps. [Experiments](../experiments/INDEX.md) retain version-bound run evidence using Results, Analysis and Next steps. Register formal approved research/acceptance runs with an EXP ID; ordinary deterministic tests and bounded diagnostic probes do not require one. ADRs preserve the rationale for selected durable decisions; an ADR is not required for each stage.

## Consequences

The owner can review intended work in GitHub and read the architecture directory as one coherent account of the running system. Coding Agents must budget documentation work into implementation and closeout. A successful documentation check cannot prove runtime correctness, useful collaboration or scientific success. Historical results remain pinned to the code and evidence that produced them.
