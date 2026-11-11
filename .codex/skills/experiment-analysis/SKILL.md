---
name: experiment-analysis
description: Analyze existing SwarmEnv experimental or diagnostic evidence, reconstruct Task/Execution/Material/Judge activity, and produce evidence-backed results and explanations.
---

# SwarmEnv experiment analysis

Analyze **existing evidence**. This skill cannot authorize paid runs, choose a new research direction, change an approved fixture/model/checker or rewrite raw traces. Follow [the experiment workflow](../../../docs/workflows/experiment.md), the relevant **human-approved GitHub Issue**, and any [Issue-numbered implementation spec](../../../docs/phases/INDEX.md).

There are two output paths:
- **Implementation diagnostics**: small tests and authorized debugging probes may be repeated autonomously and summarized locally or at a milestone. No formal EXP ID or individual report after every iteration.
- **Formal research/acceptance experiments**: use the preregistered Experiment ID, its parent Issue, approved comparison, stop rules and [canonical report template](../../../docs/experiments/TEMPLATE.md). Write detailed analysis to `<experiment-directory>/analysis/experiment-analysis.md`. Publish only a reviewed, sanitized version to `docs/experiments/`.

## Evidence gate

Identify the tested Issue contract, code commit and clean state, actual inputs, fixture/environment, model/provider, prompt/tool/schema identity, resources, timebox and actual duration. Inventory metadata, authoritative Task/Execution state, Agent logs, Runtime/Service events, Workspace versions, Materials, Candidate/Judge checks and external observation stores.

- Source-verified, deterministic tests, controlled probes and natural Agent runs are different evidence classes.
- Missing sources or links are **unknown**, not zero. For a formal run, absent preregistration or unmatched comparison must be identified as retrospective or diagnostic-only.
- Compare operations with the exact run schema or source commit; otherwise mark `schema unavailable`.
- Preserve stable IDs. Do not assign an ambiguous record to the latest Session simply because the Core or timestamp is similar. Do not infer hidden model reasoning.

## Evidence reconstruction

Use [references/evidence-map.md](references/evidence-map.md) and trace each relevant Task from proposal/admission through Execution, delivery and termination.

**Orchestration:** Task selection, claim, authoritative owner/Execution, Runtime binding, waiting, release and cleanup. Distinguish ready work, discovery, productive execution and waiting.

**Coordination:** Material producer, recipient, delivery, read, decision and subsequent action. A read or count alone does not establish useful reuse. Preserve each recipient's independent decision.

**Execution:** Keep Task, Execution, identity, Session, Core, Workspace and revision separate. For meaningful windows explain target, action, immediate result and next effect. Establish actual predecessor/successor lineage and distinguish handoff, expiry, fencing and cleanup.

**Tools/Judge:** Link requests, responses, error/diagnostic codes and subsequent action. Preserve Candidate input/checker/environment identity. A replay or cache hit is not necessarily an independent research iteration; checker source failure is not infrastructure failure.

Group routine calls compactly and report mismatches with concrete evidence IDs and competing explanations.

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
