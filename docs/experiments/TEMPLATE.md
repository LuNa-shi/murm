# EXP-YYYYMMDD-NN: <short title>

Status: REGISTERED / RUNNING / COMPLETE / BLOCKED / INCONCLUSIVE
Approved phase: <link to human-approved phase>
Experiment ID: <assigned in INDEX before this formal run>
Repeat of / comparison to: <optional>

## Setup (record before the run)

| Item | Fixed value or reference |
|---|---|
| Approved hypothesis, comparison and decision criteria | |
| Clean implementation commit and approved design revision | |
| Baseline and treatment, or approved exploration boundary | |
| Variables that may change and conditions held fixed | |
| Problem / fixture, Lean/Mathlib, input hash | |
| Provider/model and prompt/profile/tool schema hashes | |
| Core, budget, timebox, exact command and stop rule | |
| Raw evidence and privacy boundary | |

A formally approved research experiment has a registered ID. Implementation unit tests and in-scope diagnostic probes do **not** require this template or a separate human report.

## Results

Report actual start/end times, changes from the planned setup, protocol and cleanup status, Task/Execution/Material/Judge and Workspace evidence, cost, and whether the objective was achieved. Use authoritative records and stable IDs; **missing evidence is unknown, not zero**. Avoid causal claims in this section.

## Analysis

What does the evidence support? What alternatives, confounds and uncertainties remain? Separate implementation/contract defects, provider/tools/environment failures, Agent actions, and the hypothesis itself. Show the next action after feedback or Material consumption when it matters. A Material read, tool call count or a busy Core is not proof of useful progress.

## Next steps

- Agent recommendation: <a bounded diagnostic or proposal, supported by evidence>
- Approved in-scope implementation fixes or repeat runs: <what may proceed without another human decision>
- New hypothesis, changed goal, budget or architecture: <pending human decision; do not run automatically>
- Human owner decision and date: <pending / approved / declined / phase closed>

## Evidence and limitations

Link fixed commits, relative event/row IDs, missing stores and incomplete comparisons. Never publish credentials, raw Agent conversations, candidate/proof source, stdout/stderr or private absolute paths.
