---
name: experiment-analysis
description: Analyze a completed SwarmEnv experiment from its local traces, reconstruct each Execution, and write an evidence-linked Markdown report with time-window summaries. Use when the user provides an experiment directory or ID and asks what the Agents did, intended, achieved, or where the run stalled.
---

# SwarmEnv experiment analysis

Run the deterministic extractor before doing semantic review. From the repository root, use:

```text
npm run analyze:experiment -- <experiment-directory-or-id> [--mode full|sanitized]
```

The command writes `<experiment-directory>/analysis/experiment-analysis.md`. An experiment ID is resolved below the repository's `experiments/` directory; pass `--experiments-root` when the evidence is stored elsewhere. Use `--mode full` only for private local evidence. Use `--mode sanitized` for an export that must not read raw traces or private Workspace contents.

Then review the generated report and the cited source records. Do not treat `report.json` as the source of truth: it is a numerical/sanitized summary. The source of truth for this analysis is the union of the experiment's Agent, Bridge, Runtime, Service, Judge, SQLite, Observation, Workspace, and metadata evidence. The extractor is a stable evidence projection; the skill adds the bounded semantic interpretation and operator follow-up.

The deliverable is a readable report at:

```text
<experiment-directory>/analysis/experiment-analysis.md
```

Create the `analysis/` directory if needed. Keep raw traces, credentials, candidate/proof contents, and unredacted payloads out of the generated report unless the user explicitly requests a private excerpt and it is safe to include. Prefer source references and bounded summaries.

## Deterministic extraction and semantic review

1. Resolve the input and run the analyzer. Do not manually create a report before the command has recorded the evidence boundary.
2. Read [references/evidence-map.md](references/evidence-map.md) when a source is missing, malformed, or a correlation is unclear.
3. Read [references/report-template.md](references/report-template.md) before changing the report structure.
4. Review every Execution section and every time-window table. Open only the cited local records needed to support a high-impact conclusion; do not dump full transcripts into the report.
5. Add semantic conclusions only with explicit labels: `Fact`, `Derived metric`, `Interpretation`, or `Unknown`. Keep the extractor's source references beside the claim.
6. Read the **Error analysis** and **Optimization recommendations** sections. Check that each error category separates independent occurrences from supporting duplicate records, states a causal interpretation with confidence, and proposes a validation step.
7. If the report is incomplete, keep the report and state exactly what is missing. Do not silently rerun with a different evidence boundary or turn a missing log into zero operations.

The CLI performs deterministic correlation by stable IDs first and timestamp fallback second. Its windows split at lifecycle, Workspace, Material, Candidate, Judge, wait/wake/review, and terminal changes, and at a 15-minute maximum. Long silent gaps are explicit `no observed event` windows. A window's observed intent must come from an explicit tool/service objective or be `unknown`; never use hidden chain-of-thought.

## Input and evidence boundary

Accept either:

- a direct experiment directory; or
- an experiment ID, resolved using the repository's experiment root and metadata.

Before drawing conclusions, inventory the evidence. Read [references/evidence-map.md](references/evidence-map.md) for the expected locations and correlation rules. Also read the repository SOP at `docs/benchmark-analysis-sop.md` and the relevant source/schema files when a format is unclear.

Record in the report:

- resolved experiment path and ID;
- problem/project IDs;
- exact evidence paths and database locations;
- whether evidence is full local evidence or a sanitized/incomplete export;
- each evidence class as `present`, `missing`, `malformed`, `empty`, or `not applicable`;
- the reason a missing or malformed source limits a conclusion.

Never turn a missing log into "zero calls" or "no activity". If an event references an unknown Task, Execution, Session, or Core, record an integrity warning and retain the event as an unmatched fact.

## Evidence reconstruction

Build a chronological normalized view without changing domain ownership:

1. Read report/metadata only to discover run identity, projects, paths, versions, and summary values.
2. Read Task/Execution/Material/CheckResult state from SQLite or the authoritative Service records.
3. Read Agent RPC/session records for prompts, assistant-visible messages, tool calls, tool results, process diagnostics, and session boundaries.
4. Read Bridge, Runtime, Service, and Judge records for operation envelopes, results, failures, state transitions, waits, wakes, releases, checks, and recovery.
5. Read Workspace manifests/revisions to connect file state and lineage to an Execution.
6. Join records by stable IDs first: `experiment_id`, `task_id`, `execution_id`, `session_id`, `core_id`, operation/correlation ID, Material ID, Candidate ID, and CheckResult ID. Use timestamps only as a documented fallback.
7. Preserve an audit reference for every important fact: source path, line or sequence/event ID, timestamp, and related IDs.

Do not infer that a Material was useful merely because it was published or read. Do not infer Goal progress from a Task acceptance, heartbeat, turn count, Material count, or `made_progress=true`. State only the explicit downstream effect that the traces show; otherwise report `no recorded downstream effect` or `unknown`.

## Per-Execution time-window summaries

Every Execution gets a narrative and a time-window table. A window is a bounded period in which the Execution has one coherent operational phase. Use these deterministic boundaries:

- start at the first observed event for the Execution;
- split at claim/assignment, Session or Core handoff, Task state transition, Workspace revision, Material publication or explicit consumption, Candidate submission, Judge result, wait/wake/resume/rework/review, terminal event, or a material change of operational objective;
- split long continuous periods at a 15-minute maximum window by default, keeping the original timestamps;
- preserve silent gaps as explicit `no observed event` intervals rather than attaching them to the preceding action;
- if only one or two events exist, keep one short window and say that the evidence is sparse.

For each window write:

| Field | Required content |
| --- | --- |
| Time | Actual start/end timestamps and duration; identify an evidence gap if applicable |
| Operations | Concrete tools, Service calls, reads/writes, publications, submissions, waits, or process events |
| Observed intent | The external objective visible in the Task/Agent message/tool arguments, e.g. `inspect child feedback` or `submit candidate`; never hidden chain-of-thought |
| Intent basis/confidence | Evidence references and `high`, `medium`, or `low`; use `unknown` if no objective is visible |
| Result | State/artifact/feedback/error that actually followed |
| Next state | Task/Execution/Workspace/Judge state after the window |
| Handoff/blocker | Explicit consumer, wait condition, error, missing evidence, or `none recorded` |

Intent is an evidence-backed interpretation of observable behavior, not a claim about private model reasoning. Prefer labels such as `discover`, `claim`, `inspect`, `decompose`, `research`, `edit workspace`, `publish material`, `submit/check candidate`, `process feedback`, `review/rework`, `wait/coordinate`, `recover`, or `retry`. Quote or copy only short safe metadata; summarize long messages instead of exporting them.

A window's result must distinguish:

- no state change;
- a durable state change;
- feedback received;
- an error returned and whether later activity followed;
- a handoff or wait persisted;
- an unresolved/no-observed-effect outcome.

## Report structure

Use the template in [references/report-template.md](references/report-template.md). At minimum include:

1. **Executive conclusion**: what the run demonstrated, what it did not demonstrate, and the confidence/limitations.
2. **Evidence boundary**: completeness matrix, provenance, privacy mode, and integrity warnings.
3. **Run overview**: project outcomes and supporting metrics, with links back to concrete evidence.
4. **Task/Execution inventory**: Root/Child graph, attempts, owners, Sessions, Cores, Workspace lineage, and terminal states.
5. **Per-Execution analysis**: metadata, time-window summaries, artifacts, Service interactions, errors, waits, handoffs, and unresolved questions.
6. **Collaboration review**: only explicit delivery, read/consumption, downstream action, Candidate/Workspace effect, and Judge effect. Separate accepted-but-unused from consumed-without-recorded-effect.
7. **Scheduling/health review**: Core/session/runtime facts, idle/wait/turn/Judge intervals, ready-work evidence, and any unexplained gaps. Do not call an unexplained gap a scheduler bug.
8. **Error analysis**: deduplicated Service/Agent failures, causal interpretation, impact, confidence, and source references.
9. **Optimization recommendations**: prioritized next actions with explicit validation conditions.
10. **Candidate/Judge review**: ordered candidate/check sequence, diagnostics, Workspace lineage, feedback reads, and whether later behavior changed.
11. **Conclusions and follow-up**: observed facts, deterministic derivations, interpretations, unknowns, and concrete next investigations.

Use tables for inventories and windows; use prose only for conclusions that cite the tables. Every conclusion that matters must have one or more evidence references.

## Analysis rules

- Separate **fact**, **derived metric**, **interpretation**, and **unknown** with explicit labels.
- An Agent's stated task or tool objective is observable intent. Do not claim access to hidden chain-of-thought.
- A published Material is an artifact, not automatically progress. A completed child is local completion, not automatically Root progress.
- A Judge FAIL is feedback and a PASS is a verified checker result; neither alone proves the Agent used the feedback or that a route was mathematically useful.
- Heartbeats prove lease activity only. Turn counts and file reads prove activity only. Count them separately from durable progress.
- A missing source limits the conclusion; it does not prove the corresponding event did not occur.
- Treat ordinary Service errors as evidence to analyze, not automatically as protocol invalidity. Preserve the actual error class and subsequent behavior.
- Do not copy raw transcript, proof/candidate source, credentials, stdout/stderr, or unrestricted private paths into a report intended for sharing.
- Do not modify the experiment's domain databases or raw evidence. Only write the analysis output and optional derived manifest under `analysis/`.

## Finish criteria

Before returning:

1. Confirm the deterministic CLI completed and the report is under the supplied experiment directory.
2. Confirm there is one section for every discovered Execution, including Executions with sparse or missing evidence.
3. Confirm every high-impact conclusion has source references.
4. Confirm missing/malformed evidence is visible in the completeness matrix.
5. Confirm each Execution has at least one time-window summary, with operations, observed intent, result, and next state.
6. Confirm privacy rules are preserved.
7. State whether the report is complete enough for semantic conclusions or is diagnostic-only because of evidence gaps.
