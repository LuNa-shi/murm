# Judge Service

The Judge Service is the verification boundary for proof candidates. It accepts a candidate Material reference together with the target Task, the frozen Initial Context snapshot, and a locked PutnamBench fixture manifest. It records a `CheckResult` and never changes Task or Execution state itself; a later lifecycle operation applies an accepted result.

Each fixture manifest pins the full PutnamBench commit, problem file hash, Lean toolchain, Mathlib revision, checker reference and checker version, and environment reference. A request must repeat the checker and environment bindings from that manifest. The Lean adapter creates a temporary candidate workspace, rejects `sorry` placeholders, invokes the pinned checker command, and records bounded stdout, stderr, exit status, timeout state, candidate hash, and input snapshot hash as evidence. The runtime does not download a toolchain implicitly.

The request lifecycle is `REQUESTED` → `RUNNING` → `RECEIVED`. `PASS`, `FAIL`, `INCONCLUSIVE`, and `ERROR` are verdicts carried by a received result. `request_key` makes repeated checks idempotent: the same key and request hash return the original result, while a different request is rejected with `CONFLICT`. Operation envelopes provide a second idempotency boundary for `submit_check_result`.

The current repository fixture is `fixtures/putnam-1966-a1/fixture-manifest.json`. Its source and manifest are reviewable inputs; running the real checker requires the manifest's Lean environment to be installed and available through the configured checker command.
