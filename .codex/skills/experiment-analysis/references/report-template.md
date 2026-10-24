# Report template

The generated file is `<experiment-directory>/analysis/experiment-analysis.md`. Keep the section order stable so reports can be compared across runs.

## 1. Executive conclusion

State what the run demonstrated, what it did not demonstrate, and the largest evidence limitation. Label non-trivial statements as:

- **Fact** — directly recorded;
- **Derived metric** — deterministic arithmetic/count;
- **Interpretation** — evidence-backed semantic reading;
- **Unknown** — unsupported by the available sources.

## 2. Evidence boundary

Include the experiment identity, provenance, privacy mode, exact relative evidence paths, completeness status for every evidence class, malformed lines, and unmatched Task/Execution/Session/Core references.

## 3. Run overview and attempt graph

Show project outcomes and supporting metrics, then list Tasks and Execution attempts. Each Execution row must include:

- Task and attempt number;
- owner, Core, Session;
- Workspace lineage;
- predecessor/successor Execution for rework;
- terminal state;
- evidence references.

An Execution is one complete Agent session for one Task attempt. Rework is a new Execution.

## 4. Per-Execution semantic work windows

Create one section for every Execution attempt, including sparse, waiting, failed, superseded, and reworked attempts.

Use 5-minute windows by default or 10-minute windows when configured. Split earlier for a clear objective/lifecycle change. Each row must include:

| Field | Required content |
|---|---|
| Time/duration | bounded interval and evidence gap marker |
| Phase | research, editing, candidate construction, feedback, collaboration, waiting, recovery, or unknown |
| Semantic summary | route/question/objective visible in the cited records |
| Route change | comparison with the prior window or Candidate |
| Durable changes | Workspace, Material, Candidate, Judge, Task, review, or lifecycle change |
| Result | actual state/artifact/feedback/error |
| Next state/handoff | expected owner, wait condition, consumer, or blocker |
| Evidence/confidence | source references and confidence |

Supporting event counts may appear below the narrative. Millisecond-level call listings are audit evidence, not the main report.

## 5. Collaboration review

Follow:

`decompose → claim → independent work → deliver → consumer reads → review/rework → resume`.

For each delivery explain producer, expected consumer, semantic handoff, actual read, downstream action, state effect, and whether the loop closed. Distinguish closed collaboration, one-way delivery, unused result, consumed-without-effect, and unknown.

## 6. Candidate/Judge semantic review

For every Candidate show:

- bounded strategy summary;
- visible Workspace/Material changes;
- change from the previous Candidate;
- Judge diagnostic in operator language;
- explicit feedback reads;
- whether the next route changed;
- later review, rework, Workspace, or Candidate action;
- evidence and unknowns.

Never copy proof/candidate source into a shareable report.

## 7. Scheduling and system-level health

Separate Core assignment/release, Runtime RUNNING/WAITING/IDLE, Agent turns, Judge time, scheduler polling, and heartbeat lease activity. Report low capacity, serial execution, ready-unassigned work, claim contention, handoff loss, wake/resume failure, and cleanup truncation only when the trace supports them.

## 8. Error analysis

Lead with system-level Swarm findings. For each finding include observed pattern, affected Tasks/Executions/Cores, impact, confidence, competing explanations, validation condition, and evidence. List isolated Agent/Service/tool errors afterward as supporting records.

## 9. Optimization recommendations

Prioritize proposed next actions and state a validation condition for each. Recommendations are not proof of a current code defect.

## 10. Conclusions and follow-up

Separate facts, derived metrics, interpretations, unknowns, evidence limitations, and concrete operator actions. State whether the report supports semantic conclusions or is diagnostic-only.
