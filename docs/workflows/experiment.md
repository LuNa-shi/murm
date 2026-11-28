# Experiment workflow

> Type: Workflow · Status: Active · Updated: 2026-11-26

**GitHub Issues organize research and engineering work.** The [Core / Harness design](../designs/core-harness/README.md) records version-bound reviewed requirements and acceptance. Apply it with the relevant approved Issue and later explicit owner decisions. Research permission, testing scope and resources require explicit authorization in the applicable Issue or a linked human-approved decision.

Distinguish implementation diagnostics from formal research or acceptance experiments.

## A. Implementation tests and bounded diagnostics

Within an approved Issue, Coding Agents may run and repeat deterministic checks, fault reproductions and diagnostic probes without requesting approval or filing a formal report after each attempt, provided their tools, model/provider, inputs and time/cost limits have already been authorized.

- Iterate: review the accepted contract → inspect the implementation → run tests → diagnose a mismatch → fix → retest.
- Keep enough commit, input, failed assertion and final result evidence to make consequential findings reproducible. Ordinary debug probes do not need an `EXP-YYYYMMDD-NN`.
- Summarize evidence in the GitHub Issue/PR at a meaningful milestone, rather than producing a separate report per tool call.
- If the findings point to an important new research hypothesis or a design beyond the Issue, propose it to the human owner first. Do not treat a debugging explanation as approval for a new research program.
- Code authorization does not imply unlimited model calls or external spending. Use only an explicitly approved allowance.

## B. Formal research and acceptance experiments

### 1. Confirm the approved Issue

The human-approved GitHub Issue (or a linked explicit human decision) defines the research question and priority, allowed variations, acceptance observations, baseline, guardrails, resources and stopping conditions. The Issue, its linked tickets and approved comments record test decisions **within** these bounds; no secondary local specification may expand the Issue's approval.

An umbrella research program may contain several linked Issues; each approved Issue remains the work contract.

### 2. Register the run

Before each formal run allocate a unique `EXP-YYYYMMDD-NN` (UTC) in the originating Issue/PR and record its registration there. Check existing registrations before choosing the next sequence number. Record the parent Issue, clean code commit and candidate archive, Harness and executor, task/checker inputs, relevant toolchain versions, provider/model, prompt/Profile/Service-schema hashes, Agent capacity, work and cleanup deadlines, resource budget, main observations and stop conditions. For a Lean task, include Lean and Mathlib revisions; other tasks record their own language, build and evaluator versions. A rerun receives a new ID linked to the previous one.

A formal registration is for experimental traceability, **not a request for per-run approval**. Runs within the Issue's authorized matrix and spending cap can proceed autonomously. Changes outside it return to the human owner before execution.

### 3. Execute and analyze

Declare the runner's working-window timestamps before execution and use the same convention across comparison conditions. For example, the current ProgramBench driver records `window.startedAt` through [run-window.ts](../../benchmarks/shared/run-window.ts). Keep setup, active work and post-deadline finalization separate; Core startup and an accepted input receipt are not interchangeable work-window boundaries. Group comparisons use an explicitly shared start. Historical reports retain their own recorded convention, including older `run.started_at` and `experiment_started` fields.

Raw Agent transcripts, working files, checker/candidate source, credentials and private state remain in ignored local `experiments/`. Preserve Harness, Runtime, Agent, input/request and Service operation identities together with source revisions. Add the domain identifiers actually used by the Harness: TaskPool needs Mission/Task/Execution/Material/Workspace and Judge identities; a Git-based team needs repository, commit and delivery identities. Mark unavailable inputs or tools as BLOCKED rather than silently substituting.

Keep the reviewed report in the originating Issue/PR, or link an explicitly requested research artifact from it. **Results** describe facts, **Analysis** evaluates evidence and competing explanations, and **Next steps** distinguish delegated fixes from pending human decisions. Unknown evidence is not zero. Input admission, execution settlement, checked business success and cleanup are distinct results; high Agent activity or many shared artifacts do not prove meaningful collaboration.

### 4. Sync decisions and evidence

At a meaningful verification milestone or at completion, link registered runs and consolidated conclusions to the GitHub Issue/PR, including the exact tested commit, evidence limits and a link to the formal report. Do not duplicate full analyses in Issue comments or report each diagnostic iteration. The Agent may fix code defects and rerun within approved limits. Only the human can approve a new scientific question, expanded system design, changed acceptance conditions or extra resources.

Update affected [Architecture](../architecture/INDEX.md) in the implementation PR, including complete prompt changes, observed discrepancies and code-to-chapter ownership. Run the offline documentation generation/check commands. At Issue/stage closeout reconcile the manual with the final code and evidence. Do not turn historical runs into retrospectively preregistered evidence.
