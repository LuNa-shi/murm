# Report template

The generated file is `<experiment-directory>/analysis/experiment-analysis.md`. Keep this structure stable so reports can be compared across runs.

## 1. Executive conclusion

State only what the records support. Include:

- experiment ID and evidence mode;
- what the run demonstrated;
- what it did not demonstrate;
- confidence and the largest evidence limitation.

Label each non-trivial statement as one of:

- **Fact** — directly recorded in a source;
- **Derived metric** — deterministic arithmetic/count from recorded facts;
- **Interpretation** — an evidence-backed reading of observable behavior;
- **Unknown** — the sources do not support the claim.

Do not call a Material useful because it was published/read/accepted. Do not call a scheduler interval a bug when the source is missing.

## 2. Evidence boundary

Include a completeness matrix:

| Class | Status | Exact relative paths/database identity | Effect of a gap |
|---|---|---|---|
| Metadata | present/missing/malformed/empty/not applicable | … | … |
| Agent | … | … | … |
| Bridge | … | … | … |
| Runtime | … | … | … |
| Service | … | … | … |
| Judge | … | … | … |
| SQLite/state | … | … | … |
| Observation | … | … | … |
| Workspace | … | … | … |
| Summary | … | … | supporting only |

Record privacy mode, repository/environment provenance, malformed lines, and unknown Task/Execution references. Explain how each gap limits a conclusion.

## 3. Run overview and Task/Execution inventory

Give the root/project outcome and supporting metrics. Link every high-impact value to a source. Then show:

| Task | Parent | Owner | State | Goal/contract summary | Evidence |
|---|---|---|---|---|---|
| … | … | … | … | … | … |

| Execution | Task | Attempt | Owner/Core/Session | Workspace lineage | State | Evidence |
|---|---|---:|---|---|---|---|
| … | … | … | … | … | … | … |

A completed child is local completion only. A `PASS` is a checker result only. Neither alone proves root progress.

## 4. Per-Execution analysis

Create one section for every discovered Execution, including sparse, unmatched, waiting, superseded, or failed Executions. Include artifact/check facts, Service interactions, errors, waits, handoffs, and unresolved questions.

### Execution `<execution-id>`

- Task, owner, attempt, Core/Session and state;
- Workspace reference and revision lineage;
- evidence sources and sparse/missing warning;
- artifact, Material, Candidate, Judge, and terminal facts.

#### Time-window summary

Use actual timestamps. Split at claim/assignment, Session/Core handoff, Task state change, Workspace revision, Material publication/explicit consumption, Candidate, Judge, wait/wake/resume/review/rework, terminal event, or a material objective change. Split long continuous activity at 15 minutes. Preserve long silent gaps as separate `no observed event` intervals.

| Time | Duration | Operations | Observed intent | Intent basis/confidence | Result | Next state | Handoff/blocker | Evidence |
|---|---:|---|---|---|---|---|---|---|
| actual start–end | … | concrete tools/Service calls/reads/writes | observable objective, or `unknown` | source IDs + high/medium/low/unknown | state/artifact/feedback/error/no effect | Task/Execution/Workspace/Judge state | consumer, wait condition, error, missing source, or none | path:line/event ID |

Intent must come from visible Task/Agent tool objectives. Never summarize hidden chain-of-thought.

## 5. Collaboration review

Trace only explicit links:

```text
Material publication → explicit read/consumption → later Workspace/Task/Candidate/Judge/review operation
```

Use separate labels:

- `accepted-but-unused`;
- `consumed-without-recorded-downstream-effect`;
- `explicit downstream operation recorded; semantic usefulness not inferred`;
- `no recorded consumer`;
- `unknown` when the source is incomplete.

## 6. Scheduling/health review

Separate Core assignment/release, Runtime RUNNING/WAITING/IDLE, Agent turn, process/session health, Service activity, Judge time, scheduler polling, and heartbeat lease activity. State ready-work evidence when available. Do not merge them into a single productivity score or infer a scheduler fault from an unexplained gap.

## 7. Candidate/Judge review

For each Candidate, show ordered submission, Workspace revision, CheckResult ID, verdict, bounded diagnostic class, feedback read, and subsequent observable action. A FAIL is feedback; a PASS is a verified checker result. Neither proves that the Agent used feedback or that a route was mathematically useful.

## 8. Conclusions and follow-up

Separate observed facts, deterministic derivations, interpretations, and unknowns. Give concrete operator actions, such as repairing a missing log, opening a cited source record, or rerunning the analyzer after collection is fixed.
