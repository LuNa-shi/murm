# murm documentation index

> Status: Active · Authority routing updated 2026-11-23

This is the entry point to current maintained documentation. Historical design documents and experiment reports remain available from pinned Git history, not a live archive.

## Where to look

| Question | Source | Responsibility |
|---|---|---|
| Why research murm? | [PROJECT.md](PROJECT.md) | Research motivation and open problems |
| What governs the current Core / Harness stage? | **[Phase 0005 design on main](phases/0005-core-harness/README.md)** | Sole authority for this stage’s target requirements, decisions, scope and acceptance; Issues derive their tasks and checks from it |
| What must be built or observed in other stages? | **Human-approved GitHub Issue / accepted Agent Brief in its comments** | Requirements, hypotheses, scope and acceptance outside the Phase 0005 exception |
| How is a substantial next stage designed? | [phases/INDEX.md](phases/INDEX.md) | Phase 0005 is authoritative target design; other entries are versioned Issue attachments. Progress and evidence remain in Issue/PR |
| Which engineering workflow applies? | **Installed Matt Pocock engineering skills** + [AGENTS.md](../AGENTS.md) | `/to-spec`, optional `/to-tickets`, `/implement`, `/implement-spec`, `/tdd`, `/code-review`, `/pr` |
| Where is Matt skills configuration? | [agents/issue-tracker.md](agents/issue-tracker.md), [agents/domain.md](agents/domain.md), [agents/triage-labels.md](agents/triage-labels.md) | Issue tracker, domain and triage setup |
| How are Phase 0005 contracts and migration regressions verified? | [Core / Harness verification contract](workflows/core-environment-verification.md) | Pinned baseline observations, public seams and requirements-to-ticket cross-reference; execution evidence stays on Issue/PR |
| How does the current system run in detail? | [architecture/INDEX.md](architecture/INDEX.md) | Complete implementation manual, full prompts, interfaces, state and source coverage |
| What are the murm-specific working rules? | [workflows/development.md](workflows/development.md), [workflows/experiment.md](workflows/experiment.md), [TypeScript migration inventory](workflows/typescript-migration-inventory.md) | Repo conventions, verification and experiment boundaries |
| Where are formal experiments? | [experiments/INDEX.md](experiments/INDEX.md) | Run IDs, evidence and report template |
| Why was a major design decision made? | [adr/INDEX.md](adr/INDEX.md) | Decision rationale |
| How are tools operated? | [operations/observability.md](operations/observability.md) | Operational references |

Root [GLOSSARY.md](../GLOSSARY.md) defines the Mission/Task/Agent/Execution/Material/Workspace vocabulary shared by the approved [Phase 02 design](phases/0002-task-material-workspace/01-model-and-runtime.md) and current implementation. Architecture explains the registered Agent path and explicitly labels retained compatibility APIs. Historical experimental reconstruction guidance is preserved in the [research tree](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/.codex/skills/experiment-analysis/SKILL.md).

## Authority and lifecycle

**Phase 0005: authoritative design on main → derived Issue/ticket graph → implementation/review → Issue/PR evidence → implemented Architecture.**

The owner requested this stage-specific authority on 2026-11-23. The full Core, Harness and delivery documents are the contract; Notion is migration source material. Issues cite an exact document revision and cannot independently override it. Change requirements through a reviewed design PR and synchronize affected tickets. Design publication does not establish implementation or verification.

**Other stages: approved GitHub Issue → Matt engineering implementation/review → Issue/PR evidence → accepted Architecture.**

For other stages, the Issue (including explicitly approved Agent Briefs and changes in its comments) defines requirements and acceptance. Matt engineering skills determine *how engineering work is carried out*. Architecture is the baseline to preserve outside an approved Issue's changes; ADRs explain durable tradeoffs. Code shows the current implementation; tests and experiments establish what was observed. Keep implementation progress, test results, unresolved gaps and decisions in the originating GitHub Issue/PR, linking formal experiment reports when appropriate.

Keep approvals, dependencies, progress, handoff notes and discussion in the Issue/PR. A substantial design may be maintained under numbered `phases/` entries, with its exact accepted revision linked from the Issue. Except for the explicit Phase 0005 authority above, these documents are reviewable target attachments rather than another requirements authority. No phase document is a progress ledger. Update Architecture in the same PR as its implementation so both can be reviewed together. At Issue/stage closeout, reconcile the manual, generated references, source fingerprints, final code and Issue/PR acceptance evidence. See AGENTS.md for human/Agent approval boundaries.

## Why experiments and ADRs remain

`experiments/` holds version-bound observations: what was run, with which inputs and resources, what occurred, and which conclusions the evidence supports. Architecture explains how the current implementation works and cannot replace a past result. The registry, report template and cited R16 retrospective therefore remain.

`adr/` retains the rationale for durable decisions. ADR 0017 explains shared Missions and independent responsibilities; ADR 0018 explains Issue-led development and the documentation contract; [ADR 0019](adr/0019-direct-judge-workspace-submission.md) explains direct Workspace-file submission to Judge and the separate Task completion decision. ADRs do not introduce a parallel phase plan, need not be created for each stage, and do not override later approved Issue decisions. Superseded details belong in pinned Git history.

## Historical records

The [pre-cleanup `docs/` tree at `02adbb43`](https://github.com/LuNa-shi/SwarmEnv/tree/02adbb43d39e0b23befb7f2ffc4b19ffb386a36d/docs) retains earlier tracked documents. Ignored raw experiment evidence may not be in Git. Do not recreate `archive/`, old redirects, `STATUS.md`, or `CONTEXT.md` for versioning. The restored phase directory contains new Issue-linked designs, not copies of the retired phase ledger.

