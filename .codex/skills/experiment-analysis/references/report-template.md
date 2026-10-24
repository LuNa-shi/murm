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

The authoritative durable Execution is distinct from an Agent Session. A
wait/resume, Core handoff, or valid in-place parent rework remains one
Execution; a new Execution ID is a separate attempt only when durable evidence
records it. Do not infer rework from same-Task row order.

## 4. Coordination layer

Report public-service availability, completion/error rates, state consistency,
idempotency, Task queue supply and claim transitions, ready-but-unassigned work,
Context/Material publication and consumption, Workspace/checkpoint lineage,
Judge/checker handoff, and the full collaboration loop:

`decompose → claim → independent work → deliver → consumer reads → review/rework → resume`.

For each service include the observed calls, failed finishes, latency/error
limits when available, affected entities, and unknowns caused by missing sources.

## 5. Execution layer: semantic work windows

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

## 6. Collaboration review

Follow:

`decompose → claim → independent work → deliver → consumer reads → review/rework → resume`.

For each delivery explain producer, expected consumer, semantic handoff, actual read, downstream action, state effect, and whether the loop closed. Distinguish closed collaboration, one-way delivery, unused result, consumed-without-effect, and unknown.

## 7. Candidate/Judge semantic review

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

Before interpreting a Candidate verdict, classify the checker lifecycle:

`request rejected → checker not started → checker started/no result →
source-level FAIL/PASS → timeout/crash`.

Keep Judge request persistence (`ok=true`) separate from checker process success.
If the checker never starts, report the mathematical result as **unassessed**
and analyze the infrastructure failure and retry policy first.

## 8. Tool layer

Measure provider/transport errors, invalid tool use, response-schema quality,
idempotency, and actionable error fields (code, message, correlation ID).
Review Judge/checker diagnostic accuracy and whether the Agent read and acted on
feedback. Keep tool-call volume as supporting evidence rather than a work
summary.

The tool section must state whether each error came from request validation,
provider/transport, checker launch, checker execution, or source-level
diagnostics. A repeated pre-checker error is one environment failure with
supporting retry records, not a series of independent mathematical failures.

## 9. System efficiency and health

Separate Core assignment/release, Runtime RUNNING/WAITING/IDLE, Agent turns, Judge time, scheduler polling, and heartbeat lease activity. Report low capacity, serial execution, ready-unassigned work, claim contention, handoff loss, wake/resume failure, and cleanup truncation only when the trace supports them.

Keep configured capacity separate from effective work: Core occupancy,
concurrency, ready-but-unassigned work, claim contention, capacity release,
WAITING/IDLE/Judge/scheduler time, wake/resume, serial degradation, and cleanup.
Use Runtime RUNNING and queue intervals where available; call duration-based
occupancy a proxy otherwise. A missing source is an Unknown/limitation, not a
scheduler failure.

## 10. Error analysis

Lead with system-level Swarm findings. For each finding include observed pattern, affected Tasks/Executions/Cores, impact, confidence, competing explanations, validation condition, and evidence. List isolated Agent/Service/tool errors afterward as supporting records.

## 11. Evidence, outcome, and optimization

Separate evidence completeness/provenance/privacy from outcomes. Report
protocol/lifecycle validity, collaboration closure, and domain or mathematical
success as different conclusions.

## 12. Optimization recommendations

Prioritize proposed next actions and state a validation condition for each. Recommendations are not proof of a current code defect.

## 13. Conclusions and follow-up

Separate facts, derived metrics, interpretations, unknowns, evidence limitations, and concrete operator actions. State whether the report supports semantic conclusions or is diagnostic-only.

The analysis directory must also contain `semantic-review.md`, the independent
summary-agent review and rubric score. The final report should state whether
that review was merged completely, partially, or not at all.
