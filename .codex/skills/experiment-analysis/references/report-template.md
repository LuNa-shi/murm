# Experiment analysis report

Write `<experiment-directory>/analysis/experiment-analysis.md`. Read the current Issue and `docs/validation/phase-1-acceptance.md`. Label conclusions Fact, Derived metric, Interpretation or Unknown and cite relative evidence references. Task proposal, execution and updates form the narrative; the headings below provide diagnostic lenses, not a required parent-child architecture.

## 1. Evidence gate

Record implementation and baseline commits, clean state, actual model/provider, fixture/environment, config/prompt/schema identity, resource limits, planned/actual duration, status and privacy boundary. Inventory metadata, raw Agent JSONL, authority state, Runtime, services, Materials, Workspace and checker records. Missing records are unknown, not zero. Mark limited conclusions diagnostic-only. Use schema from the run or exact commit; otherwise say schema unavailable. Source-only behavior is source-verified only.

## 2. Orchestration question

Follow a Task through proposal/admission, claim, execution, release and any reopening. Identify which component decided its content and which only maintained state. Track the same Task identity across supported services. Keep idle/selection/tool waits separate from effective work; identify queue truncation or evidence gaps rather than guessing a cause.

## 3. Coordination question

Group by Task. Show its proposed boundary, actual materials, intended receivers and concrete downstream uses. Separate self-checkpoints from directed delivery and each receiver's decision. Historical parent/child terms may be interpreted for historical runs only; do not require a parent approval chain for current Tasks. Include the Issue's real acceptance cases and excluded/nonqualifying cases.

## 4. Execution question

Within each Task, list every Execution and Session in temporal order, with predecessor evidence, inherited Workspace/Material, cumulative costs and terminal reason. Distinguish effective handoff, forced expiry, controlled interruption and final cleanup. For meaningful work windows state Target, Action, Immediate result and Next effect. Do not infer lineage from attempt_no alone or attach reusable-Core records without stable identity.

For feedback, show publication, delivery, entry into context, handling decision and subsequent action. Include delivered-but-unprocessed feedback across turnover and expiration of execution-specific reminders. Mark unknown events explicitly.

## 5. Tool contract question

Compare every recorded request/response pair in the relevant evidence: expected result, actual result and Agent reaction. Group normal pairs and detail mismatches. For Judge show check scope, immutable content/environment identity, diagnosis and next meaningful edit; cache/replay is not a new iteration. Preserve source failure versus infrastructure failure. Exclude raw stdout/stderr and other private diagnostics; retain bounded class/code and evidence identity.

## 6. Final causal conclusion

For the registered Issue, report conformance/regression coverage and before/after real behavior separately. Include denominators, minimum event coverage, thresholds, guardrails, controlled interventions and all run verdicts. Use PASS, FAIL, INCONCLUSIVE or BLOCKED; absent opportunities never imply success. Address all newly found same-scope deviations or explicitly document unresolved disposition.

State what improved, what remains unknown and the mathematical result. More Tasks, Materials or calls do not alone establish useful progress. Never publish credentials, raw transcripts, proof/candidate source, hidden reasoning, stdout/stderr or private absolute paths; external references use `<external>/<basename>` with commit or store identity.
