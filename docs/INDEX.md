# SwarmEnv documentation index

> Status: Active · Reviewed 2026-11-12

This is the entry point to current maintained documentation. Historical design documents and experiment reports remain available from pinned Git history, not a live archive.

## Where to look

| Question | Source | Responsibility |
|---|---|---|
| Why research SwarmEnv? | [PROJECT.md](PROJECT.md) | Research motivation and open problems |
| What must be built or observed next? | **Human-approved GitHub Issue / accepted Agent Brief in its comments** | Sole source of requirements, hypotheses, scope, and acceptance |
| How is a substantial next stage designed? | [phases/INDEX.md](phases/INDEX.md) | Numbered, versioned design attachments; approval and progress remain in the linked Issue/PR |
| Which engineering workflow applies? | **Installed Matt Pocock engineering skills** + [AGENTS.md](../AGENTS.md) | `/to-spec`, optional `/to-tickets`, `/implement`, `/implement-spec`, `/tdd`, `/code-review`, `/pr` |
| Where is Matt skills configuration? | [agents/issue-tracker.md](agents/issue-tracker.md), [agents/domain.md](agents/domain.md), [agents/triage-labels.md](agents/triage-labels.md) | Issue tracker, domain and triage setup |
| How does the current system run in detail? | [architecture/INDEX.md](architecture/INDEX.md) | Complete implementation manual, full prompts, interfaces, state and source coverage |
| What are the SwarmEnv-specific working rules? | [workflows/development.md](workflows/development.md), [workflows/experiment.md](workflows/experiment.md) | Repo conventions, verification and experiment boundaries |
| Where are formal experiments? | [experiments/INDEX.md](experiments/INDEX.md) | Run IDs, evidence and report template |
| Why was a major design decision made? | [adr/INDEX.md](adr/INDEX.md) | Decision rationale |
| How are tools operated? | [operations/benchmark.md](operations/benchmark.md), [operations/observability.md](operations/observability.md) | Operational references |

Root [GLOSSARY.md](../GLOSSARY.md) distinguishes the current runtime vocabulary from the [Phase 02 target model](phases/0002-task-material-workspace/01-model-and-runtime.md). The [experiment-analysis skill](../.codex/skills/experiment-analysis/SKILL.md) reconstructs experimental evidence.

## Authority and lifecycle

**Approved GitHub Issue → Matt engineering implementation/review → Issue/PR evidence → accepted Architecture.**

The Issue (including explicitly approved Agent Briefs and changes in its comments) defines requirements and acceptance. Matt engineering skills determine *how engineering work is carried out*. Architecture is the baseline to preserve outside an approved Issue's changes; ADRs explain durable tradeoffs. Code shows the current implementation; tests and experiments establish what was observed. Keep implementation progress, test results, unresolved gaps and decisions in the originating GitHub Issue/PR, linking formal experiment reports when appropriate.

Keep approvals, dependencies, progress, handoff notes and discussion in the Issue/PR. A substantial design may be maintained under numbered `phases/` entries, with its exact accepted revision linked from the Issue. These documents are reviewable target designs, not another authority or status ledger. Update Architecture in the same PR as its implementation so both can be reviewed together. At Issue/stage closeout, reconcile the manual, generated references, source fingerprints, final code and Issue/PR acceptance evidence. See AGENTS.md for human/Agent approval boundaries.

## Why experiments and ADRs remain

`experiments/` holds version-bound observations: what was run, with which inputs and resources, what occurred, and which conclusions the evidence supports. Architecture explains how the current implementation works and cannot replace a past result. The registry, report template and cited R16 retrospective therefore remain.

`adr/` retains the rationale for durable decisions. ADR 0017 explains shared Missions and independent responsibilities; ADR 0018 explains Issue-led development and the documentation contract. ADRs do not introduce a parallel phase plan, need not be created for each stage, and do not override later approved Issue decisions. Superseded details belong in pinned Git history.

## Historical records

The [pre-cleanup `docs/` tree at `02adbb43`](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs) retains earlier tracked documents. Ignored raw experiment evidence may not be in Git. Do not recreate `archive/`, old redirects, `STATUS.md`, or `CONTEXT.md` for versioning. The restored phase directory contains new Issue-linked designs, not copies of the retired phase ledger.
