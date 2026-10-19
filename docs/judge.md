# Judge Service

Judge Service is the verification boundary for candidate Materials. It checks
the candidate against the claimed Task, its Workspace snapshot hash, and a
locked checker and environment manifest. It records a CheckResult and leaves
Task and Execution state changes to the Task Service lifecycle operation that
applies the result.

Agents submit a candidate through the named `judge_submit_candidate` tool.
The runner or Judge controller submits the candidate to the checker and makes
the result available as shared feedback. Candidate source and checker output
remain in the private experiment evidence; sanitized benchmark reports retain
IDs, hashes, verdicts, and diagnostic classes.
