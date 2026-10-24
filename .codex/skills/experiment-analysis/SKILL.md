---
name: experiment-analysis
description: Analyze a completed SwarmEnv experiment as a semantic operator report. Reconstruct each Agent session as a distinct Execution attempt, summarize bounded work windows, explain collaboration and Candidate route changes, and diagnose system-level Swarm degradation from local evidence.
---

# SwarmEnv semantic experiment analysis

Use this skill when the user gives an experiment directory or ID and asks what the Agents did, what route they explored, whether collaboration worked, why candidates stagnated, or where the Swarm degraded.

The deliverable is:

```text
<experiment-directory>/analysis/experiment-analysis.md
```

Start with the deterministic extractor, then run a semantic summary pass in a
fresh Codex context. The extractor establishes the evidence boundary and stable
references; the summary pass turns the cited records into a readable operator
report. Do not stop at the extractor's event tables, and do not treat a manual
paragraph appended by the operator as a substitute for the summary pass.

From the repository root:

```text
npm run analyze:experiment -- <experiment-directory-or-id> [--mode full|sanitized] [--window-minutes 5|10]
```

The default is `--window-minutes 5`. Use 10 minutes for long runs when a coarser narrative is easier to review. Use `--mode full` only for private local evidence and `--mode sanitized` for an export that must not read raw traces or private Workspace contents.

## Execution identity and rework

Use the authoritative durable `Execution` ID as the report identity. An Agent
`Session` and a Core assignment are separate segments: wait/resume, Core reuse,
or a valid in-place parent rework may keep the same Execution ID. A new
Execution ID is a separate attempt and may be shown as a successor only when a
durable relation or explicit lifecycle evidence supports that reading. Do not
infer rework from same-Task creation order alone.

This preserves the repository domain model while answering the operator's
question. Each Execution section explains the complete observable attempt,
including Session/Core segments, Workspace lineage, checkpoint, feedback,
handoff, and terminal result. The report must show Execution ID, attempt number,
Session IDs, segment boundaries, Workspace lineage, and any explicit
predecessor/successor relation. A rework *event* is reported inside the durable
Execution when the Task Service updates that Execution in place.

## Two-pass workflow

1. Resolve the directory or ID and run the analyzer. Never manually invent an evidence boundary.
2. Inspect the completeness matrix and source warnings. A missing source limits a conclusion; it does not mean zero activity.
3. Review every Execution attempt and its bounded semantic windows.
4. In a fresh Codex context, write `analysis/semantic-review.md` before merging
   conclusions into the final report. Give that reviewer the experiment path,
   this skill, and the report's stable evidence references; do not give it a
   previous report's conclusions. For each window, act as a summary Agent:
   - read only the cited Agent-visible objectives/messages, tool arguments/results, Workspace revisions/diffs or manifests, Material metadata, Candidate metadata, Judge diagnostics, and lifecycle records needed for the conclusion;
   - write a 5- or 10-minute summary of the work being attempted;
   - identify the mathematical/research route when the visible evidence supports it;
   - describe research, editing, candidate construction, feedback processing, collaboration, waiting, or recovery;
   - state the durable result, next state, handoff, blocker, and uncertainty;
   - cite the source paths, line/sequence/event IDs, and confidence.
5. Replace generic metadata-only wording with the semantic summary when the cited local evidence supports a more precise account. Keep the generated event counts as supporting audit data. If the reviewer cannot improve a window, retain the generic text only with an explicit evidence-gap reason.
6. Review collaboration and Candidate sections as semantic analyses, not ID inventories.
7. Review System-level Error Analysis. Prioritize Swarm capacity, serialization, handoff, recovery, feedback-loop, and cleanup failures. Keep isolated tool errors as supporting records unless they block a system loop.
8. Keep raw traces, hidden chain-of-thought, proof/candidate source, credentials, stdout/stderr, and unrestricted private paths out of the report.
9. Apply `references/semantic-review-rubric.md`. Record the six dimension scores
   and mark the report diagnostic-only when the total is below 9/12.

A summary Agent may interpret observable behavior. It must never claim access to hidden model reasoning. If the route or intent is not visible, write `unknown` and explain which evidence is missing.

The semantic reviewer is an independent evidence-reading step, not a prose
formatter. It must compare revisions and feedback, identify competing causal
explanations, and state what next experiment would distinguish them.

## Semantic work windows

The analyzer defaults to five-minute windows. It may split earlier at a meaningful lifecycle or objective change:

- Task claim/assignment or Task state transition;
- Candidate submission or Judge result;
- parent review, rework, wake, resume, or terminal state;
- a concrete change from exploration to candidate construction, feedback processing, handoff, or waiting.

Do not make heartbeat, turn, read, or Service-call rows the primary narrative. Each window must contain:

| Field | Required question |
| --- | --- |
| Time | What bounded interval is covered? |
| Phase | What kind of work was happening? |
| Semantic summary | What route, question, or operational objective was being pursued? |
| Route change | Did the approach change relative to the previous window/Candidate? |
| Durable changes | What Workspace, Material, Candidate, Judge, Task, or lifecycle state changed? |
| Result | What actually followed? |
| Next state/handoff | Who or what should act next? |
| Evidence/confidence | Which visible records support it, and how certain is the interpretation? |

A silent interval is an explicit evidence gap. Never attach it to the prior action or convert it into “no work”.

## Collaboration review

Explain the collaboration loop:

```text
decompose → claim → independent work → deliver → consumer reads
→ review/rework → resume
```

For every meaningful delivery, answer:

- who produced it and who should consume it;
- what question, route, or result was handed off;
- whether the expected consumer actually read it;
- what that consumer did next;
- whether the handoff changed Task, Workspace, Candidate, Judge, or review state;
- whether the loop closed, became one-way delivery, remained unused, or is unknown because evidence is missing.

Publication, acceptance, or a Material count alone is not collaboration success.

## Candidate/Judge semantic review

For each Candidate, summarize the route at the level supported by evidence:

- the visible proof/solution strategy and major sub-step, without copying source;
- Workspace or Material changes relative to the previous Candidate;
- Judge feedback in operator language;
- whether feedback was explicitly read;
- whether the next Candidate responds to that feedback;
- repeated unchanged routes, superficial edits, or meaningful route changes;
- later review, rework, or Workspace action.

A PASS is a checker result. A FAIL is feedback. Neither proves mathematical usefulness by itself. If candidate source or route evidence is unavailable, say so and retain the Candidate as an unresolved semantic question.

Before interpreting any Candidate verdict, classify the Judge/checker path as
one of these states:

```text
request rejected → checker not started → checker started/no result
→ source-level FAIL/PASS → timeout/crash
```

`Judge operation ok=true` means that the Judge request and persistence path
completed; it does not mean that the checker proved the Candidate. A checker
launch failure such as missing `lake`, missing wrapper, invalid working
directory, or unavailable toolchain is an infrastructure result. It must be
reported separately from mathematical failure, and the Candidate's mathematical
status is `unassessed` until a checker process starts and produces a source-level
result. If the same infrastructure diagnostic repeats, look for a preflight or
health gate; do not describe each retry as new proof feedback.

## Analysis hierarchy: three operational layers plus two cross-cutting lenses

Use this top-down order in every report:

1. **Coordination Layer** — public-service health and collaboration contracts.
   Check service availability, completion/error rates, state consistency,
   idempotency, Task supply and claim/lease transitions, ready-but-unassigned
   work, Context/Material publication and consumption, Workspace/checkpoint
   lineage, Judge/checker handoff, and the full `decompose → claim → deliver →
   consume → review/rework → resume` loop. Required inputs are
   Service/Bridge records, Task/Execution/Material/Workspace tables, stable
   operation IDs, parent/child links, and consumer/review evidence.
2. **Execution Layer** — one durable Execution attempt from initial context to
   result. Check initial prompt and frozen context, Workspace initialization and
   isolation, Session/Core binding, RUNNING/WAITING/IDLE segments, retries and
   recovery, checkpoint save/restore, wake/resume/rework, terminal state, and
   5/10-minute semantic phase progression. Required inputs are prompt/context
   metadata, Workspace manifests/revisions, Runtime segments, Agent-visible
   objectives, lifecycle events, Judge feedback, and output/candidate records.
3. **Tool Layer** — provider, tool, and checker contracts. Measure
   provider/transport error rate and latency, invalid tool use, response schema
   completeness, idempotency, and whether errors contain an accurate code,
   actionable message, and correlation ID. Review Judge/checker diagnostics for
   classification accuracy and whether the Agent read and acted on feedback.
   Required inputs are Agent tool records, Bridge/Service results, provider
   error fields, Judge/checker CheckResults, and feedback-read events.

Add two cross-cutting lenses rather than forcing them into a service layer:

- **System Efficiency & Health** — configured versus effective Core occupancy,
  concurrency, ready work, claim contention, capacity release, WAITING/IDLE/
  Judge/scheduler time, wake/resume, cleanup, and serial degradation. Use
  Runtime RUNNING intervals and ready-queue evidence; label
  Execution-duration occupancy as a proxy when those sources are absent.
- **Evidence & Outcome** — completeness, provenance, privacy, and integrity;
  separate protocol/lifecycle success, collaboration success, and domain or
  mathematical success. Missing evidence produces an Unknown/limitation rather
  than a failure claim.

## System-level Error Analysis

Rank failures in the Swarm operating model before isolated call errors. Check for:

- low effective Core occupancy or available capacity left unused;
- ready work with no owner;
- serial Execution despite independent work and free Cores;
- claim contention and quota waste;
- repeated discovery or duplicate work;
- child delivery without parent consumption;
- waiting that does not release capacity or wake the right owner;
- wake/resume/rework failures;
- repeated Judge diagnostics without a route change;
- timebox or cleanup truncation;
- protocol/lifecycle failures blocking collaboration.

For every finding state:

- observed trace pattern;
- affected Tasks, Executions, and Cores;
- operational impact;
- confidence and competing explanations;
- a concrete validation condition for the next run.

Do not call a scheduler defect from an unexplained gap. Separate deterministic facts, derived metrics, interpretation, and unknowns.

For deep causal analysis, test the following feedback loops explicitly:

- **Judge loop:** Candidate submitted → checker process state → diagnostic
  quality → Agent interpretation → next route. A repeated pre-checker error is
  a broken environment loop, not evidence about the theorem.
- **Handoff loop:** producer publishes → intended consumer can read → consumer
  changes Task/Workspace/Candidate state → parent reviews or resumes. A read
  without a durable downstream change is not closed collaboration.
- **Capacity loop:** ready work exists → claim succeeds → Core runs → WAITING
  releases capacity → wake/resume reclaims the right Execution. Without ready
  work and auditable RUNNING intervals, report a capacity signal rather than a
  scheduler defect.
- **Terminal loop:** retry/recovery condition changes → Execution reaches a
  typed terminal state → dependent Tasks are accepted, blocked, or cancelled.
  An experiment timebox must not be presented as mathematical failure.

## Evidence and privacy rules

The source of truth is the union of metadata, Agent, Bridge, Runtime, Service, Judge, SQLite/state, Observation, Workspace, and summary evidence. `report.json` is supporting numerical evidence only.

Join by stable IDs first: experiment, Task, Execution, Session, Core, operation/correlation, Material, Candidate, CheckResult, and Workspace revision IDs. Use timestamp fallback only when no stable ID exists and label the fallback.

Record every evidence class as `present`, `missing`, `malformed`, `empty`, or `not applicable`. Preserve unmatched references as integrity warnings.

Do not modify raw evidence or domain databases. Write only the analysis report and optional derived data under `analysis/`. Reports intended for sharing must not contain raw transcript, hidden chain-of-thought, proof/candidate source, credentials, authorization headers, stdout/stderr, or unrestricted absolute paths.

## Finish criteria

Before returning:

- the deterministic CLI completed and the report exists under the supplied experiment;
- each discovered Execution attempt, including sparse or reworked attempts, has its own section;
- windows are 5 or 10 minutes by configuration and contain semantic summaries;
- rework events are represented against the authoritative Execution; a new
  Execution gets predecessor/successor links only when durable evidence records
  a distinct successor;
- Collaboration Review explains producers, consumers, handoffs, and loop closure;
- Candidate/Judge Review explains route changes and feedback response;
- System-level Error Analysis covers capacity, serialization, handoff, feedback, recovery, and cleanup where evidence supports them;
- high-impact conclusions have source references and confidence;
- missing/malformed evidence is visible;
- privacy rules are preserved;
- the report states whether it is semantically complete or diagnostic-only because of evidence gaps.
- `analysis/semantic-review.md` exists, records the rubric score, and identifies
  any dimensions that remained template-level or evidence-limited;
