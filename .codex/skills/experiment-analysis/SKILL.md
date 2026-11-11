---
name: experiment-analysis
description: Analyze existing SwarmEnv experiment or diagnostic evidence, reconstruct Task/Execution/Material/Judge activity, and produce grounded results and explanations.
---

# SwarmEnv experiment analysis

Analyze **existing evidence**. This skill cannot authorize a paid run, choose a new research direction, change an approved fixture/model/checker, or rewrite raw traces. Follow [the experiment workflow](../../../docs/workflows/experiment.md) and the relevant human-approved task or phase.

There are two output paths:
- **Implementation diagnostics**: small tests and authorized debugging probes may be repeated autonomously and summarized locally or at a milestone. No formal EXP ID or report after every iteration.
- **Formal research/acceptance experiments**: use the preregistered Experiment ID, approved comparison, stop rules and [canonical report template](../../../docs/experiments/TEMPLATE.md). Write the detailed local analysis to `<experiment-directory>/analysis/experiment-analysis.md`. Only publish a reviewed, sanitized version to `docs/experiments/`.

## Evidence gate

Identify code commit and clean state, tested contract, actual inputs, fixture/environment, model/provider, prompt/tool/schema identity, resources, timebox and actual duration. Inventory metadata, authoritative Task/Execution state, Agent logs, Runtime/Service events, Workspace versions, Materials, Candidate/Judge checks and external observability stores.

- Source-verified, deterministic tests, controlled probes and natural Agent runs are different evidence classes.
- Missing sources or links are **unknown**, not zero. For a formal run, absent preregistration or unmatched comparison must be identified as retrospective or diagnostic-only.
- Compare operations with the exact run schema or source commit; otherwise mark `schema unavailable`.
- Preserve stable IDs. Do not assign an ambiguous record to the latest Session simply because the Core or timestamp is similar. Do not infer hidden model reasoning.

## Evidence reconstruction

Use [references/evidence-map.md](references/evidence-map.md) and trace each relevant Task from proposal/admission through Execution, delivery and termination.

**Orchestration:** Task selection, claim, authoritative owner/Execution, Runtime bind, wait, release and cleanup. Distinguish available work from selection time, genuine working time, and waiting.

**Coordination:** Material producer, intended recipient, delivery, read, decision and subsequent action. A count or read alone does not prove useful reuse. Preserve decisions of different recipients.

**Execution:** Keep Task, Execution, identity, Session, Core, Workspace and revision separate. For important windows, explain target, Agent action, immediate result and next effect. Check real predecessor/successor lineage; distinguish handoff, expiry, fencing and final cleanup.

**Tool/Checker:** Connect actual request, response, error/diagnosis and next action. Preserve Candidate input/checker/environment identity; a replay or cache hit is not another iteration. Separate checker source failures from infrastructure errors.

Group routine calls compactly. Report concrete mismatches with evidence anchors and competing explanations.

## Report

Formal reports use plain headings:
- **Setup**: the human-approved question, fixed inputs and evidence boundary.
- **Results**: what actually happened, with IDs, costs and outcomes; no unsupported causal inference.
- **Analysis**: what the evidence supports, what may explain it otherwise, and what remains uncertain.
- **Next steps**: in-scope fixes the Agent can perform, proposals that require human approval, and any recorded human decision.
- **Evidence and limitations**: source references, unknowns and privacy restrictions.

For an implementation probe, use only the sections necessary to explain the defect, attempted correction and final verification. An Agent must not turn a debugging explanation into an independently selected **research hypothesis**.

## Verification, costs and privacy

Use preregistered criteria for formal studies and approved contract assertions for diagnostics. Report PASS/FAIL/INCONCLUSIVE/BLOCKED with actual coverage. An untriggered case is not a pass; high Task/Material/Core counts are not proof of productive research.

Report known costs and unknown amounts explicitly. Never publish raw Agent dialogue, private reasoning, proof/candidate source, credentials, stdout/stderr, private databases or personal absolute paths. Use relative event/row/commit references; external stores use `<external>/<basename>` with store identity.

[references/report-template.md](references/report-template.md) is a diagnostic checklist, not a second authoritative formal template.
