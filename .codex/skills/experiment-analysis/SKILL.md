---
name: experiment-analysis
description: Reconstruct SwarmEnv experiment evidence, analyze Task/Execution/Material/Judge activity, and draft an Overview and evidence-backed analysis for a registered experiment.
---

# SwarmEnv experiment analysis

This skill produces an evidence-first **draft**, not a research-direction decision. Read [docs/workflows/experiment.md](../../../docs/workflows/experiment.md), the approved phase description when it exists, the registered experiment input, and [docs/experiments/TEMPLATE.md](../../../docs/experiments/TEMPLATE.md). Do not silently substitute a historical S1–S3 acceptance plan for the currently approved experiment.

**Only analyze an existing run.** This skill does not authorize paid runs, change the tested code/model/fixture, approve new hypotheses, or edit raw evidence. Write the detailed local report to `<experiment-directory>/analysis/experiment-analysis.md`. A separate sanitized publication under `docs/experiments/` needs review and explicit approval.

## 1. Evidence gate

Record the canonical Experiment ID (or exact legacy ID), code commit and clean state, baseline/comparison, fixture/environment, model/provider, prompt/profile/schema identity, resource limits, planned/actual time and outcome. Enumerate metadata, raw Agent JSONL, authoritative Task/Execution state, Runtime/Service events, Material/Workspace/Judge and external observation stores.

- Missing, empty, malformed and not applicable are distinct. **Unknown is not zero.**
- Use schemas recorded by the run or exact source commit; otherwise say `schema unavailable`.
- An unexercised code path is `source-verified only`. A deterministic test, real controlled probe and natural Agent run are separate evidence levels.
- Do not infer hidden model reasoning, predecessor lineage from timestamps, or acceptance from absent failures.
- Mark missing preregistration or unmatched comparison `retrospective / diagnostic-only` as appropriate.

## 2. Task-centric evidence reconstruction

Use [references/evidence-map.md](references/evidence-map.md) to join stable IDs first. Follow each relevant Task from proposal/admission through claims, Execution binding, results and release/closure.

**Orchestration:** Which Agent proposed or took responsibility? Did Task Service, Bridge and Runtime agree on owner, Core and Execution? What was actually ready versus waiting, timed out or being cleaned up?

**Coordination:** Which Material was produced for whom? Reconstruct publish → delivered → read → recipient decision → downstream action; distinguish self-checkpoint from inter-Task sharing. A read or consumer count alone does not demonstrate benefit.

**Execution:** Keep Task/Execution/Session/Core/Workspace identifiers separate. For meaningful windows summarize target, action, immediate result and next effect. Preserve handoff, expiry, fencing, shutdown and continuation distinctions; unknown predecessor is unknown.

**Tools and Judge:** Join each relevant request, service response, returned error or diagnosis and next Agent action. Preserve Candidate content/checker/environment binding. A cache hit or retry is not necessarily a new research iteration. Keep checker source_failure separate from infrastructure failure.

Group normal events compactly; explain concrete mismatches with IDs and evidence anchors.

## 3. Canonical report sections

1. **Registration and evidence boundary**: copied from the pre-run record; if missing say so.
2. **Overview**: immutable inputs, runtime and observed outcomes, task/execution/material/judge facts, protocol, costs and math result. No causal speculation.
3. **Input surface and process**: what the Agent could see and what it did, including timelines and evidence consumption.
4. **分析判断**: competing causes (implementation/contract; tools/provider; Agent behavior; experiment confounds; design hypothesis), evidence for/against, uncertainty and falsifiers.
5. **下一步建议与人工决定**: AI may suggest a bounded diagnostic; only the human phase owner may approve hypothesis/scope/next paid run.
6. **Evidence index and privacy limitations**: where each claim comes from and what is not visible.

The published report format is owned by `docs/experiments/TEMPLATE.md`. [references/report-template.md](references/report-template.md) is only the diagnostic checklist; do not maintain competing public formats here.

## 4. Acceptance and privacy

Use **registered** denominators, changed variables, stop rules, comparisons and guardrails. Report PASS, FAIL, INCONCLUSIVE or BLOCKED with actual event coverage. Do not change thresholds after the run, count filler Tasks or whitespace-only edits, or mistake shared-Mission concurrency for independent parallel work.

Preserve mathematical result separately from protocol and execution reliability. Report model/tool costs and missing metrics as unknown, not zero. Never publish credentials, raw transcripts, private reasoning, candidate/proof code, stdout/stderr, private paths or unrestricted state DBs. Use relative paths plus event/row/commit IDs; references outside experiment directory use `<external>/<basename>` and store identity.
