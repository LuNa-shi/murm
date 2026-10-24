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

Start with the deterministic extractor, then run a semantic summary pass. The extractor establishes the evidence boundary and stable references; the summary pass turns the cited records into a readable operator report. Do not stop at the extractor's event tables.

From the repository root:

```text
npm run analyze:experiment -- <experiment-directory-or-id> [--mode full|sanitized] [--window-minutes 5|10]
```

The default is `--window-minutes 5`. Use 10 minutes for long runs when a coarser narrative is easier to review. Use `--mode full` only for private local evidence and `--mode sanitized` for an export that must not read raw traces or private Workspace contents.

## Execution is one Agent session and one attempt

An Execution is one complete Agent session responsible for one Task attempt:

- it starts when the Agent claims or is assigned the Task and receives/opens its Workspace;
- it owns the Workspace lineage through its work;
- it ends when the session hands off/submits its result, reaches a terminal state, or is explicitly stopped;
- a rework request creates a new Execution with a new identity and attempt;
- the new Execution is a rework successor, not more activity inside the previous Execution.

The report must show predecessor/successor Execution IDs, attempt numbers, session IDs, and Workspace lineage. Never merge rework attempts into one Execution narrative merely because they share a Task or Workspace ancestry.

## Two-pass workflow

1. Resolve the directory or ID and run the analyzer. Never manually invent an evidence boundary.
2. Inspect the completeness matrix and source warnings. A missing source limits a conclusion; it does not mean zero activity.
3. Review every Execution attempt and its bounded semantic windows.
4. For each window, act as a summary Agent:
   - read only the cited Agent-visible objectives/messages, tool arguments/results, Workspace revisions/diffs or manifests, Material metadata, Candidate metadata, Judge diagnostics, and lifecycle records needed for the conclusion;
   - write a 5- or 10-minute summary of the work being attempted;
   - identify the mathematical/research route when the visible evidence supports it;
   - describe research, editing, candidate construction, feedback processing, collaboration, waiting, or recovery;
   - state the durable result, next state, handoff, blocker, and uncertainty;
   - cite the source paths, line/sequence/event IDs, and confidence.
5. Replace generic metadata-only wording with the semantic summary when the cited local evidence supports a more precise account. Keep the generated event counts as supporting audit data.
6. Review collaboration and Candidate sections as semantic analyses, not ID inventories.
7. Review System-level Error Analysis. Prioritize Swarm capacity, serialization, handoff, recovery, feedback-loop, and cleanup failures. Keep isolated tool errors as supporting records unless they block a system loop.
8. Keep raw traces, hidden chain-of-thought, proof/candidate source, credentials, stdout/stderr, and unrestricted private paths out of the report.

A summary Agent may interpret observable behavior. It must never claim access to hidden model reasoning. If the route or intent is not visible, write `unknown` and explain which evidence is missing.

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
- rework is represented as a new Execution with predecessor/successor links;
- Collaboration Review explains producers, consumers, handoffs, and loop closure;
- Candidate/Judge Review explains route changes and feedback response;
- System-level Error Analysis covers capacity, serialization, handoff, feedback, recovery, and cleanup where evidence supports them;
- high-impact conclusions have source references and confidence;
- missing/malformed evidence is visible;
- privacy rules are preserved;
- the report states whether it is semantically complete or diagnostic-only because of evidence gaps.
