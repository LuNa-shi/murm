# Experiment analysis report

Write the report to:

```text
<experiment-directory>/analysis/experiment-analysis.md
```

Keep this order. Every conclusion is labelled **Fact**, **Derived metric**,
**Interpretation**, or **Unknown** and cites relative evidence references.

## 1. Evidence gate

Record:

- experiment and project IDs;
- implementation commit, provider/model, Core count, timebox, start/end/status;
- privacy mode and analysis date;
- evidence classes as `present`, `missing`, `malformed`, `empty`, or
  `not applicable`;
- unmatched IDs, malformed records, and the resulting completeness status.

State whether the report is complete or diagnostic-only.

Use these rules when deciding that status:

- Missing Controller/Daemon events or the ordered Observation store makes the
  control-plane result diagnostic-only, but does not erase Runtime/Task/Agent
  facts that are independently joined.
- Missing Agent JSONL makes that Execution's behavior unknown.
- Missing authoritative Task/Execution state makes lifecycle and ownership
  conclusions diagnostic-only.
- Missing Material, Workspace, or Judge evidence makes the affected handoff or
  check unknown.

When comparing a tool response with a contract, use serialized Service metadata
first, then the checked-out implementation at the exact implementation commit
recorded in metadata. If neither is available, write `schema unavailable`.
If the source contains a fallback that the run did not exercise, label it
`source-verified only`.

## 2. Orchestration question

> Did the control plane move the right Task to the right Core and continue after
> claim, release, blocking, or dependency changes?

Show the relevant chains:

```text
Controller → Daemon → selection → claim → Runtime → Task Session
Execution release/block → Controller → next admission or reopen
dependency change → Controller → Daemon → new Execution
```

For each broken chain, record the missing transition, affected entities,
operational impact, confidence, and competing explanation.

## 3. Coordination question

> Were Task and Material results consumed by the next responsible Agent and did
> that consumption change later work?

Use bounded Task and Material windows.

For a Task window record:

```text
creation/admission → claim/Execution → result/dependency changes
→ terminal, blocked, or reopened state
```

For a Material window record:

```text
publication → intended consumer/read → downstream decision or state change
```

Classify each important chain as `closed`, `one-way`, `unused`, or
`unknown`. Do not call publication or read alone successful collaboration.
Mark a child chain `closed at child scope` only when the child satisfied its own
Task contract. Mark parent integration closed only after the parent records a
decision or durable state change from that child result.

## 4. Execution question

> Did each Execution's bounded work windows pursue its Task goal and produce
> auditable progress?

Create one subsection per durable Execution. Include its Task, attempt,
Core/Session segments, Workspace lineage, lifecycle result, and evidence gaps.

For every work window use this compact format:

| Field | Content |
| --- | --- |
| Target | What the Agent was trying to accomplish |
| Action | Visible Agent, tool, Workspace, or research behavior |
| Immediate result | What the action produced |
| Next effect | Durable state, handoff, route, or owner change |

Read raw Agent JSONL and cite the associated Runtime, Workspace, Material,
Candidate, Judge, and lifecycle records needed to support the interpretation.
Keep Selection Session and bound Task Session distinct when visible.

Assign Agent lines by explicit Execution/Session ID first. If reusable-Core
sessions overlap and the line cannot be assigned safely, mark it unmatched or
shared with uncertainty. For many Executions, repeated windows may be grouped
by an explicit Execution ID list and shared references, but each durable
Execution still needs a compact row and lifecycle breaks remain separate.

## 5. Tool contract question

> Did each tool call return the information its contract promised, and did the
> Agent use that information correctly?

For each material mismatch record:

| Field | Content |
| --- | --- |
| Call | Tool, operation, and related entity |
| Expected | Contractually expected response |
| Actual | Returned response and status |
| Use | How the Agent used or failed to use it |
| Effect | Operational consequence and evidence |

Separate request rejection, transport failure, contract mismatch, checker launch
failure, checker result, and mathematical source failure.
For diagnostics containing stdout/stderr or private payload, retain only the
sanitized diagnostic class/code, process status, checker or service identity,
and affected entity.

## 6. Final causal conclusion

Answer:

> If the experiment did not reach its goal, is the strongest supported cause an
> orchestration break, an unclosed Task/Material handoff, ineffective Agent
> work, or a tool-contract failure?

Separate protocol/lifecycle validity, collaboration closure, Execution
progress, and mathematical or domain outcome. State the strongest evidence,
uncertainties, and the next validation condition. Do not introduce a new
count-only diagnosis here.
