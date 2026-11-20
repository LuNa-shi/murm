---
name: experiment-analysis
description: Analyze existing SwarmEnv experimental or diagnostic evidence, reconstruct Task/Execution/Material/Judge activity, and produce evidence-backed results and explanations.
---

# SwarmEnv experiment analysis

Analyze **existing evidence**. This skill cannot authorize paid runs, choose a new research direction, change an approved fixture/model/checker or rewrite raw traces. Follow [the experiment workflow](../../../docs/workflows/experiment.md), the relevant **human-approved GitHub Issue**, its approved comments, and linked tickets/PRs. No local Phase spec is needed.

There are two output paths:
- **Implementation diagnostics**: small tests and authorized debugging probes may be repeated autonomously and summarized locally or at a milestone. No formal EXP ID or individual report after every iteration.
- **Formal research/acceptance experiments**: use the preregistered Experiment ID, its parent Issue, approved comparison, stop rules and [canonical report template](../../../docs/experiments/TEMPLATE.md). Write detailed analysis to `<experiment-directory>/analysis/experiment-analysis.md`. Publish only a reviewed, sanitized version to `docs/experiments/`.

## Evidence gate

Identify the tested Issue contract, code commit and clean state, actual inputs, fixture/environment, model/provider, prompt/tool/schema identity, resources, timebox and actual duration. Inventory metadata, raw Agent JSONL, authoritative Task/Execution state, Agent logs, Runtime/Service events, Workspace versions, Materials, Candidate/Judge checks and external observation stores. For every recorded request/response pair, preserve the expected result, actual result and operational effect.

- Source-verified, deterministic tests, controlled probes and natural Agent runs are different evidence classes.
- Missing sources or links are **unknown**, not zero. For a formal run, absent preregistration or unmatched comparison must be identified as retrospective or diagnostic-only.
- Start with the Architecture at the run commit. For each disputed decision, trace the Bot startup instructions, CLI help or discovery response, authenticated Bridge binding and provider operation that were available at that moment. Locate the actual request and returned content by ID. A stored column, Runtime maintenance operation or term from a different release supplies no evidence that this Bot saw a choice. If the run contract cannot be recovered, mark `schema unavailable`.
- A source path that is only checked statically is `source-verified only`; missing runtime evidence remains unknown.
- Preserve stable IDs. Do not assign an ambiguous record to the latest Session simply because the Core or timestamp is similar. Do not infer hidden model reasoning.

### 1. Orchestration question

Follow a concrete Task through admission, claim, Runtime binding, effective work and release. Keep selection, waits, tool-only waits, cleanup and a reusable-Core handoff distinct from productive execution.

### 2. Coordination question

Build a **Task window** from proposal through all Executions and a **Material window** from production through intended recipient, read, decision and downstream action. For a task-selection question, compare the chosen responsibility with alternatives visible at that timestamp. Trace its deliverable through actual consumption, Workspace revision, integration on main and the fixed Mission submission wherever those steps occurred. Measure which Mission obligations that evidence settles.

### 3. Execution question

Keep Task, Execution, identity, Session, Core, Workspace and revision separate. Establish predecessor/successor evidence and summarize each meaningful work window as Target, Action, Immediate result and Next effect. Preserve unknown lineage.

### 4. Tools/Judge question

For every recorded request/response pair, compare the expected result with the actual result and the Agent reaction. Keep checker infrastructure failures separate from mathematical source failures; a replay or cache hit is not a new research iteration.

## Decision reconstruction for long runs

Use [the evidence map](references/evidence-map.md) for the ledger and joins. Account for every Bot, including selection without a take and gaps in the trace. At important decisions identify the timestamp, Mission gap, information actually returned, any stated rationale, chosen action, available alternatives and later effect. Distinguish an inferred motive from a recorded explanation. Prior reports can locate evidence. Verify conclusions against the original records for this run.

To distinguish a missed problem, repeated local choices and a short time budget, locate the earliest recorded recognition of each unresolved prerequisite. Follow the ensuing proposals, takes, deliveries and actual downstream use. At the cutoff record ready work, blockers and recent verified progress toward the missing obligations. Projected benefit from more time remains uncertain until a matched extension tests it.

## Report

Formal reports use:
- **Setup**: parent approved Issue, fixed inputs, comparison and evidence boundary.
- **Results**: observed execution, system and research outcomes with IDs, costs and versions.
- **Analysis**: evidence-supported explanations, alternatives, confounds and remaining uncertainty.
- **Next steps**: permitted Issue-scope fixes, proposals needing a new human decision, and any recorded approval.
- **Evidence and limitations**: references, missing data and privacy restrictions.

For a local implementation probe, only document what is needed to reproduce the defect and verify the fix. Do not turn a debugging explanation into a self-approved research hypothesis.

## Verification, costs and privacy

For formal studies use the Issue-approved criteria and preregistered comparisons; for diagnostics use the accepted contract and reproducible tests. Report PASS/FAIL/INCONCLUSIVE/BLOCKED with actual coverage. An untriggered condition is not a pass; high Task, Material or Core counts do not by themselves prove useful progress.

Report actual costs and unknown amounts, never zero-filled assumptions. Do not publish raw Agent conversations, private reasoning, candidate/proof source, credentials, stdout/stderr, private databases or private absolute paths. Use relative event/row/commit references; external stores use `<external>/<basename>` and store identity.

[references/report-template.md](references/report-template.md) is a diagnostic checklist, not a second authoritative formal template.
