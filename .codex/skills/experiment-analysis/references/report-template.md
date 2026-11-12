# Experiment analysis — evidence checklist

The only formal publication template is [docs/experiments/TEMPLATE.md](../../../../docs/experiments/TEMPLATE.md). This file is an evidence checklist, not a second report format. Ordinary implementation probes do not need a formal Experiment ID.

## Input and evidence
- [ ] Formal runs: preregistration, human-approved research question, changed variables, clean commit, fixture/model/schema/budget, start and end times
- [ ] Diagnostic probes: approved behavior to verify, actual code and input, failure and final test/probe result
- [ ] Available and missing metadata, Task/Execution state, Runtime/Bridge/Service events, Material, Workspace and Judge records
- [ ] Separate source-verified, deterministic, controlled probe and natural-run evidence
- [ ] Clearly label retrospective analyses and unmatched comparisons

## Four diagnostic perspectives
- [ ] **Orchestration:** Task creation, claim, binding, release, permission errors and contention
- [ ] **Coordination:** Material publication, read, recipient decision and subsequent action
- [ ] **Execution:** Task/Execution/Session/Core/Workspace, versions, handoff, expiry and cleanup
- [ ] **Tools/Judge:** actual requests, errors, checker results and next Candidate/Agent action

## Reporting checks
- [ ] **Results** present verifiable observations; **Analysis** gives alternative explanations and falsifiers
- [ ] **Next steps** distinguish the Agent's suggestions from human-approved research decisions
- [ ] Formal runs use preregistered criteria; unknown or untested conditions cannot be PASS
- [ ] Sanitized output contains no credentials, raw dialogue, proof/candidate source, stdout/stderr or private paths
