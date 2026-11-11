# SwarmEnv documentation index

> Status: Active · Reviewed 2026-11-11

This is the entry point to current maintained documentation. Historical design documents and experiment reports remain available from pinned Git history, not a live archive.

## Where to look

| Question | Source | Responsibility |
|---|---|---|
| Why research SwarmEnv? | [PROJECT.md](PROJECT.md) | Research motivation and open problems |
| What must be built or observed next? | **Human-approved GitHub Issue / accepted Agent Brief in its comments** | Sole source of requirements, hypotheses, scope, and acceptance |
| Which engineering workflow applies? | **Installed Matt Pocock engineering skills** + [AGENTS.md](../AGENTS.md) | `/to-spec`, optional `/to-tickets`, `/implement`, `/implement-spec`, `/tdd`, `/code-review`, `/pr` |
| Where is Matt skills configuration? | [agents/issue-tracker.md](agents/issue-tracker.md), [agents/domain.md](agents/domain.md), [agents/triage-labels.md](agents/triage-labels.md) | Issue tracker, domain and triage setup |
| What system structure has been accepted? | [architecture/INDEX.md](architecture/INDEX.md) | Current accepted design baseline |
| What is implemented and verified? | [STATUS.md](STATUS.md) | Issue/PR/commit-linked evidence and gaps |
| What are the SwarmEnv-specific working rules? | [workflows/development.md](workflows/development.md), [workflows/experiment.md](workflows/experiment.md) | Repo conventions, verification and experiment boundaries |
| Where are formal experiments? | [experiments/INDEX.md](experiments/INDEX.md) | Run IDs, evidence and report template |
| Why was a major design decision made? | [adr/INDEX.md](adr/INDEX.md) | Decision rationale |
| How are tools operated? | [operations/benchmark.md](operations/benchmark.md), [operations/observability.md](operations/observability.md) | Operational references |

Root [GLOSSARY.md](../GLOSSARY.md) defines runtime vocabulary. The [experiment-analysis skill](../.codex/skills/experiment-analysis/SKILL.md) reconstructs experimental evidence.

## Authority and lifecycle

**Approved GitHub Issue → Matt engineering implementation/review → Issue/PR evidence and STATUS → accepted Architecture.**

The Issue (including explicitly approved Agent Briefs and changes in its comments) defines requirements and acceptance. Matt engineering skills determine *how engineering work is carried out*. Architecture is the baseline to preserve outside an approved Issue's changes; ADRs explain durable tradeoffs. Code shows the current implementation, and tests/experiments establish what was observed. STATUS links evidence to Issues without redefining requirements.

Keep engineering plans, dependencies, code-level decisions, handoff notes and discussion in the Issue/PR and commit history rather than creating local Phase or Implementation Spec files. Synchronize Architecture when a design-changing PR is accepted for merge; check consistency at Issue closeout. See AGENTS.md for human/Agent approval boundaries.

## Historical records

The [pre-cleanup `docs/` tree at `02adbb43`](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs) retains earlier tracked documents. Ignored raw experiment evidence may not be in Git. Do not recreate `archive/`, old redirects, `docs/phases/`, or `CONTEXT.md` for versioning.
