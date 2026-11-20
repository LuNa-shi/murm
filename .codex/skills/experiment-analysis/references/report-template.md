# Experiment analysis — evidence checklist

The only formal publication template is [docs/experiments/TEMPLATE.md](../../../../docs/experiments/TEMPLATE.md). This file is an evidence checklist, not a second report format. Ordinary implementation probes do not need a formal Experiment ID.

## 1. Input and evidence
- [ ] Formal runs: preregistration, human-approved research question, changed variables, clean commit, fixture/model/schema/budget, start and end times
- [ ] Diagnostic probes: approved behavior to verify, actual code and input, failure and final test/probe result
- [ ] Available and missing metadata, Task/Execution state, Runtime/Bridge/Service events, Material, Workspace and Judge records
- [ ] Separate source-verified, deterministic, controlled probe and natural-run evidence
- [ ] Clearly label retrospective analyses and unmatched comparisons

## 2. Four diagnostic perspectives
- [ ] **Orchestration:** Task creation, claim, binding, release, permission errors and contention
- [ ] **Coordination:** Material publication, read, recipient decision and subsequent action
- [ ] **Execution:** Task/Execution/Session/Core/Workspace, versions, handoff, expiry and cleanup
- [ ] **Tools/Judge:** For every recorded request/response pair, compare the expected result, actual result and next Agent action; keep checker source failures separate from infrastructure failures and treat replay/cache hits as non-iterations

## 3. Decision and tool contract details

- [ ] For selection studies, account for every Bot and identify what it could see at the decision timestamp, the chosen task, viable alternatives and any recorded reason
- [ ] Link the delivered work to each relevant Mission obligation, its downstream consumer and the final acceptance evidence. State where the chain ended
- [ ] Mark alternative explanations for outstanding gaps, including work still open at the time limit
- [ ] Record the request, service outcome, returned information and Agent reaction for each meaningful Judge or Service call
- [ ] Mark missing sources unknown rather than inferring a result from counts

## 4. Reporting checks
- [ ] **Results** present verifiable observations; **Analysis** gives alternative explanations and falsifiers
- [ ] **Next steps** distinguish the Agent's suggestions from human-approved research decisions
- [ ] Formal runs use preregistered criteria; unknown or untested conditions cannot be PASS
- [ ] Use relative evidence references and preserve stable IDs; sanitized output contains no credentials, raw dialogue, proof/candidate source, stdout/stderr or private paths

## 5. Evidence limitations
- [ ] Separate deterministic tests, controlled probes and natural Agent runs
- [ ] Identify retrospective, unmatched or source-only evidence as limited

## 6. Publication boundary
- [ ] Publish only reviewed, sanitized conclusions and retain private raw evidence locally
