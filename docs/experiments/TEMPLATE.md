# EXP-YYYYMMDD-NN: Short title

Status: REGISTERED / RUNNING / COMPLETE / BLOCKED / INCONCLUSIVE
Approved GitHub Issue: [Issue URL and linked approval]
Implementation PR / decision links: [GitHub links]
Experiment ID: [assigned in INDEX before execution]
Repeat of / comparison to: [optional]

## Setup (record before the run)

| Item | Fixed value or reference |
|---|---|
| Approved Issue requirements, main observations and decision criteria | |
| Clean implementation commit, candidate archive, Architecture baseline and implementation PR | |
| Baseline and treatment, or approved exploration boundary | |
| Variables allowed to change and conditions held fixed | |
| Harness, executor, problem/checker inputs and relevant toolchain revisions | |
| Provider/model and prompt/Profile/Service-schema hashes | |
| Agent capacity, resource budget, work/cleanup deadlines, exact command and stop conditions | |
| Working-window timestamp fields, setup interval and post-deadline finalization convention | |
| Raw evidence and privacy boundary | |

A formal experiment has a registered ID and is authorized by the Issue or a linked explicit decision. Implementation unit tests and bounded diagnostic probes do **not** require this template or a separate human-facing report.

## Results

Report actual setup/work/finalization times, input deviations, admission and execution outcomes, business checks, artifact verification, cleanup status and costs. Identify the Runtime, Agents, requests and Service operations, plus the domain identities used by this Harness (such as TaskPool Execution/Workspace revisions or a Git team's fixed commits). Use authoritative records and stable IDs; **missing evidence is unknown, not zero**. Avoid causal claims in this section.

## Analysis

State what the observed results support, and which alternatives, confounds and unknowns remain. Distinguish implementation/contract failures, tools/provider/environment problems, Agent decisions and failures of the research hypothesis itself. Publishing or reading a contribution alone does not establish useful reuse.

## Next steps

- Agent recommendation: [bounded, evidence-backed suggestion]
- Within-Issue work already authorized: [tests, repairs or repeats within approval]
- New scope, hypothesis, budget or Architecture proposal: [Issue decision required]
- Human decision/reference: [linked approval state, comment and date]

## Evidence and limitations

Link code commits, relative event/row IDs, missing stores and incomplete comparisons. Never publish credentials, raw Agent conversations, proof/candidate source, stdout/stderr or private absolute paths.
