# Experiment workflow

> Type: Workflow · Status: Active · Updated: 2026-11-11

**GitHub Issues organize research and engineering intent.** A human-approved Issue decides why the next work is valuable, what the system should do and which phenomena matter for acceptance. A separate Phase approval document is not required. Optional [Issue implementation notes](../phases/INDEX.md) may point to technical test plans but do not authorize a new question or extra resources.

Distinguish implementation diagnostics from formal research or acceptance experiments.

## A. Implementation tests and bounded diagnostics

Within an approved Issue, Coding Agents may run and repeat deterministic checks, fault reproductions and diagnostic probes without requesting approval or filing a formal report after each attempt, provided their tools, model/provider, inputs and time/cost limits have already been authorized.

- Iterate: review the accepted contract → inspect the implementation → run tests → diagnose a mismatch → fix → retest.
- Keep enough commit, input, failed assertion and final result evidence to make consequential findings reproducible. Ordinary debug probes do not need an `EXP-YYYYMMDD-NN`.
- Summarize evidence at a meaningful PR/Issue milestone and in [STATUS](../STATUS.md), rather than producing a report per tool call.
- If the findings point to an important new research hypothesis or a design beyond the Issue, propose it to the human owner first. Do not treat a debugging explanation as approval for a new research program.
- Code authorization does not imply unlimited model calls or external spending. Use only an explicitly approved allowance.

## B. Formal research and acceptance experiments

### 1. Confirm the approved Issue

The human-approved GitHub Issue (or a linked explicit human decision) defines the research question and priority, allowed variations, acceptance observations, baseline, guardrails, resources and stopping conditions. Optional implementation notes may record test methods **within** these bounds; they never expand the Issue's approval.

An umbrella research program may contain several linked Issues; the normal control unit is still the approved Issue, not an additional Phase Charter.

### 2. Register the run

Before each formal run allocate `EXP-YYYYMMDD-NN` (UTC) in [the experiment index](../experiments/INDEX.md). Record the parent Issue, clean code commit, baseline/comparison, fixture/Lean/Mathlib, provider/model, prompt/profile/schema hashes, Core/timebox/budget, main observations and stop conditions. A rerun receives a new ID linked to the previous one.

A formal registration is for experimental traceability, **not a request for per-run approval**. Runs within the Issue's authorized matrix and spending cap can proceed autonomously. Changes outside it return to the human owner before execution.

### 3. Execute and analyze

Raw Agent transcripts, Workspace, checker/candidate source, credentials and private state remain in ignored local `experiments/`. Preserve Task/Execution/Session/Core/Material/Judge/Workspace identities and source revisions; mark unavailable inputs or tools as BLOCKED rather than silently substituting.

Use [experiment-analysis](../../.codex/skills/experiment-analysis/SKILL.md) and the [report template](../experiments/TEMPLATE.md): **Results** describe facts, **Analysis** evaluates evidence and competing explanations, and **Next steps** distinguish delegated fixes from pending human decisions. Unknown evidence is not zero, protocol validity is not Mission success, and busy Cores or large Material counts do not prove meaningful collaboration.

### 4. Sync decisions and evidence

At a milestone or at completion, link the registered runs and consolidated conclusions back to the GitHub Issue/PR and update [STATUS](../STATUS.md). The Agent may fix code defects and rerun within approved limits. Only the human can approve a new scientific question, expanded system design, changed acceptance conditions or extra resources.

When the resulting design is accepted for merge, update [Architecture](../architecture/INDEX.md); at Issue closeout verify that the design, implementation and evidence records agree. Do not turn historical runs into retrospectively preregistered evidence.
