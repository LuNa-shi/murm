---
name: experiment-analysis
description: Analyze a SwarmEnv experiment directly from its local evidence and answer four causal questions about orchestration, collaboration, Execution behavior, and tool results.
---

# SwarmEnv experiment analysis

Use this skill when the user gives an experiment directory or experiment ID
and wants to know what the Swarm did, whether Agents collaborated, why a run
stalled, or whether the runtime and tools behaved as designed.

The skill is a direct Codex workflow. Start from the supplied experiment
directory, read the local evidence, and write:

```text
<experiment-directory>/analysis/experiment-analysis.md
```

Do not turn the analysis into a count-only report. Do not infer hidden model
reasoning. If the evidence does not show an intent, route, handoff, or result,
write `unknown` and name the missing evidence.

## The operating rule

The report answers four questions. Each question has one evidence chain and one
conclusion. Do not create separate checklists for Controller, Daemon, Runtime,
Task, Material, Judge, or individual tools; those are evidence sources inside
the four questions.

### 0. Evidence gate

Before answering the questions, decide whether the directory is complete
enough to analyze:

```text
metadata and run identity
→ implementation commit and timebox
→ raw Agent/Runtime/Service evidence
→ Task/Execution/Material state
→ Workspace/Judge evidence where applicable
```

Record the experiment ID, project IDs, implementation commit, provider/model,
Core count, timebox, start/end/status, and every evidence class as `present`,
`missing`, `malformed`, `empty`, or `not applicable`. A missing source limits a
conclusion; it is never evidence that no work happened. Mark the report
diagnostic-only when the run or evidence boundary is incomplete.

Use this boundary rule:

| Missing evidence | Allowed conclusion |
| --- | --- |
| Controller/Daemon events or ordered Observation store | Runtime/Task/Agent chains may be reported, but exact reconcile→signal→claim ordering is `unknown`; the orchestration result is diagnostic-only. |
| Agent JSONL for an Execution | That Execution's behavior is `unknown`; do not infer idle, success, or failure from state counts. |
| Authoritative Task/Execution state | Lifecycle and ownership conclusions are diagnostic-only and must not be presented as durable facts. |
| Material/Workspace/Judge evidence needed for a claimed handoff or check | The handoff or mathematical result is `unknown`; retain only the observable request/result envelope. |

The complete experiment evidence is the metadata-declared implementation
commit plus the experiment directory. For a tool contract, first use the
serialized schema or Service metadata in the evidence. If it is absent, the
skill may read the checked-out source at the exact implementation commit named
by metadata and must cite that path and commit. It must not silently compare a
run with the current working tree or an unrelated branch. If neither source is
available, report `schema unavailable` rather than guessing.

If a fallback exists in source but the experiment did not exercise it, label it
`source-verified only`; do not present it as a runtime-observed behavior.

### 1. Orchestration question

> **Did the control plane move the right Task to the right Core and continue
> after claim, release, blocking, or dependency changes?**

Reconstruct the experiment's control chain:

```text
Controller reconcile
→ Core Daemon signal/discovery/selection
→ Task claim
→ Runtime bind and Task Session
→ release, block, reopen, or terminal state
```

Read Controller, Core Daemon, Runtime, Task Service, admission, and lifecycle
records. Join them by stable `task_id`, `execution_id`, `core_id`, `session_id`,
`operation_id`, and timestamps only as a labelled fallback.

The answer must identify at least one complete normal chain when one exists and
each material break that affected progress. For a break, state the missing
transition, affected Task/Execution/Core, operational effect, confidence, and
the competing explanation if the evidence is incomplete. The conclusion is one
of `chain demonstrated`, `chain partially demonstrated`, or `unknown`.

### 2. Coordination question

> **Were Task and Material results consumed by the next responsible Agent and
> did that consumption change later work?**

Build two kinds of bounded windows from the same evidence model.

**Task window**

```text
Task creation/admission
→ claim and Execution
→ child/dependency/result changes
→ terminal, blocked, or reopened state
```

**Material window**

```text
Material publication
→ intended consumer/read
→ downstream decision, Workspace, Candidate, Judge, review, or Task change
```

For each important window, state what was produced, who should consume it, what
was actually read or received, what the consumer did next, and whether the
durable state changed. A publication or read alone is not successful
collaboration. Classify the chain as `closed`, `one-way`, `unused`, or
`unknown`, and cite the producer, consumer, Task, Execution, Material, and
downstream records that support the classification.

`closed at child scope` means the child satisfied its own Task contract. It does
not mean the parent integrated the result. Use `closed at parent scope` only
when the parent records a decision or durable state change after consuming the
child result; otherwise classify the parent edge as `one-way` or `unknown`.

### 3. Execution question

> **Did each Execution's bounded work windows pursue its Task goal and produce
> auditable progress?**

Use the durable `Execution` ID as the attempt identity. Keep its Core and
Session segments together, and distinguish the unbound Selection Session from
the bound Task Session when the records expose both.

Read the raw Agent JSONL for every discovered Execution, then correlate only
the Runtime, Workspace, Material, Candidate, Judge, and lifecycle evidence
needed to explain what the Agent did. Split a window at a meaningful objective,
claim, feedback, state, handoff, or terminal change; use bounded time windows
when no such change exists.

Assign raw Agent lines to an Execution by explicit `execution_id` or
`session_id` first, then by the Runtime bind interval and Task/Core identity.
When reusable-Core sessions overlap and no stable identity resolves the line,
keep it unmatched or shared with an uncertainty label; never silently attach it
to the newest Execution.

Every window has exactly four required statements:

```text
Target:       what the Agent was trying to accomplish
Action:       what the visible Agent/tool/Workspace behavior did
Immediate result: what the call or edit produced
Next effect:  what durable state, handoff, route, or owner changed afterward
```

Use these statements to explain research route, candidate construction,
feedback response, collaboration, waiting, recovery, and acceptance work. A
window with no usable Agent evidence is an evidence gap, not an assertion of
idle or no progress. Do not copy transcripts, hidden reasoning, proof source,
or candidate source into the report.

For a run with many Executions, keep one compact row or subsection per durable
Execution. Identical repeated windows may be grouped by an explicit list of
Execution IDs and shared evidence references, but fences, retries, feedback,
handoffs, and terminal changes must remain separate. The four statements are
the minimum required content, not a reason to repeat identical prose dozens of
times.

### 4. Tool contract question

> **Did each tool call return the information its contract promised, and did the
> Agent use that information correctly?**

For every recorded request/response pair in the relevant evidence, follow:

```text
request
→ bridge/service execution
→ response
→ Agent reaction
```

Compare every request with the current public tool schema or Service
implementation and every response with the expected contract. A missing
response is itself a contract result. Summarize normal pairs in a bounded
table and list every mismatch or missing pair individually; do not silently
skip a call because it did not change the final conclusion.
Check four things: request validity, response existence, response shape and
meaning, and downstream use. `ok=true` proves neither complete data nor correct
semantics. Flag missing or contradictory IDs, ownership, state, provenance,
version, checker, or correlation information when it changes the interpretation
of the run.

For each mismatch record:

```text
call and entity
expected result
actual result
Agent's subsequent use
operational effect
```

Keep transport failure, request rejection, contract mismatch, checker launch
failure, checker result, and mathematical source failure separate. A Judge
request that persisted successfully is not proof that a checker ran or that a
candidate was mathematically useful.

When a checker or service diagnostic contains stdout/stderr or private payload,
retain only the sanitized diagnostic class/code, process status, checker or
service identity, and the affected entity. Never quote the diagnostic body.

## Final causal conclusion

After the four questions, answer one final question without doing a new broad
scan:

> **If the experiment did not reach its goal, is the strongest supported cause
> an orchestration break, an unclosed Task/Material handoff, ineffective Agent
> work, or a tool-contract failure?**

Separate protocol/lifecycle validity, collaboration closure, Execution
progress, and mathematical or domain outcome. A conclusion must be labelled
as a `Fact`, `Derived metric`, `Interpretation`, or `Unknown`, and must include
stable evidence references and confidence. Counts support a conclusion but do
not replace the causal chain.

## Evidence handling

Use the experiment directory as the primary boundary. A summary report can
help locate records, but raw JSONL, state, Workspace metadata, and service
records are authoritative for semantic claims.

Join in this order:

1. Observation `event_id` or `sequence` and experiment ID;
2. Task, Execution, Session, Core, operation/correlation IDs;
3. Material, Candidate, CheckResult, and Workspace revision IDs;
4. timestamp and Core lane only when no stable ID exists.

Keep unmatched records visible as evidence warnings. Use relative source paths
and line, sequence, event, or database row references in the report. Do not
modify raw evidence or domain databases; write only derived analysis under
`analysis/`. For evidence outside the experiment directory, render the source
as `<external>/<basename>` plus its commit or database identity; never emit an
absolute checkout or machine path.

## Report shape

Keep the report in this order:

1. Evidence gate and experiment identity;
2. Orchestration question and control chains;
3. Coordination question with Task and Material windows;
4. Execution question with one section per Execution and its windows;
5. Tool contract question and mismatches;
6. Final causal conclusion, evidence gaps, and next validation conditions.

The report must state the implementation commit, experiment status, privacy
boundary, relevant evidence paths, and whether the result is complete or
diagnostic-only. It must not include credentials, authorization headers, raw
transcripts, hidden reasoning, proof/candidate source, stdout/stderr, or
unrestricted private paths.
