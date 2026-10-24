# Semantic review rubric

This rubric tests the skill as an operator workflow. Passing the deterministic
JavaScript tests is necessary, but it does not show that a fresh Codex can
produce a useful experiment analysis.

## Black-box test protocol

Run the test with a fresh Codex context. Give it only:

1. the experiment directory or ID;
2. this skill and `references/report-template.md`;
3. permission to read local evidence under the experiment directory.

Do not give it a previous report's conclusions. The fresh reviewer must first
run the deterministic extractor, then inspect the cited evidence and write
`analysis/semantic-review.md`. A separate evaluator compares that review with
the evidence and only then merges it into `analysis/experiment-analysis.md`.

The test is invalid if the reviewer only reruns the extractor, copies the
existing report, or fills the report with manually supplied conclusions.

## Anti-template checks

The evaluator rejects a review when any of these conditions holds:

- a non-gap window uses only a generic phase sentence such as “the Agent was
  primarily engaged in ...” without a concrete objective, route, state change,
  or evidence reference;
- a Candidate row reports only changed-file count, PASS/FAIL, or “feedback was
  read” without comparing the previous route and the response to feedback;
- a service section lists call counts without stating the affected contract,
  observed failure pattern, operational impact, and an alternative explanation;
- a system-efficiency conclusion calls the scheduler defective without ready
  work, Runtime RUNNING, or Core-capacity evidence;
- a tool error is listed without classifying provider, transport, contract,
  schema, checker, or diagnostic-quality impact;
- a Judge `ERROR` is treated as a mathematical Candidate failure without first
  proving that the checker process started and produced a source-level result;
- an absence is called a failure when the relevant evidence class is missing,
  malformed, or not correlated.

## Required semantic assertions

For every Execution, the reviewer must provide:

- initial context and Workspace initialization assessment;
- a bounded phase narrative for every 5/10-minute window, including silent
  intervals and the expected next owner/state;
- checkpoint, retry, recovery, wait/wake, and terminal-state assessment;
- a collaboration path from child creation through claim, delivery, consumer,
  review/rework, and resume, with unknown edges called out;
- Candidate-by-Candidate route comparison and feedback response;
- a separate protocol/lifecycle outcome and domain/mathematical outcome.

For every high-impact finding, require the chain:

```text
observed pattern → affected entities → operational impact
→ competing explanations → validation condition
```

## Scoring

Score each dimension 0, 1, or 2:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Coordination | inventory only | handoff facts | service contract and causal loop |
| Execution | call timeline | lifecycle phases | route/progress/recovery semantics |
| Tool | error counts | error classes | error fidelity and Agent response |
| Efficiency | core counts | utilization proxy | supply/dispatch/wait causal analysis |
| Candidate semantics | verdict list | revision comparison | route and feedback convergence |
| Evidence discipline | uncited claims | partial citations | stable IDs, uncertainty, alternatives |

Scores below 9/12 are diagnostic-only and must not be presented as a complete
semantic report. The report must include the score and the failed dimensions.
