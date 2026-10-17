# End-to-end verification

The locked fixture is `fixtures/putnam-1966-a1`. Its manifest pins the PutnamBench commit, problem-file hash, Lean toolchain, Mathlib revision, checker version, and environment reference. The checked-in valid and invalid candidate files are protocol fixtures; the invalid file is deliberately rejected by the deterministic checker.

Run the deterministic root proof path with:

```sh
node scripts/run-mvp-fixture.mjs --keep
```

The JSON audit records the task, execution, frozen Initial Context, candidate Materials, both CheckResults, workspace and checkpoint references, process-session count, and the retained FAIL evidence. The same ScriptExecutor protocol runs the first invalid candidate, restores the existing Workspace after the failed CheckResult, submits a superseding candidate, and applies PASS. It uses the public Services SDK, Runtime, Workspace Manager, and Judge Service; the script does not write directly to SQLite.

The real Agent Core startup path is available through:

```sh
node scripts/run-mvp-fixture.mjs --real-agent --keep
```

It uses the local `nurouter pi -- ... --mode rpc` adapter only after these local routing variables are present:

```sh
export NUROUTER_PI_PROVIDER=...
export NUROUTER_PI_MODEL=...
export NUROUTER_PI_ACCOUNT=...
export NUROUTER_PI_GROUP=...
```

It also requires `nurouter`, `pi`, `lean`, and `lake` on `PATH`. The probe reports command versions and missing variable names without recording credential values. A successful process launch is reported separately from a completed proof: the current repository does not yet expose an Agent-to-Services SDK bridge that can convert an arbitrary Pi RPC conversation into candidate submission and CheckResult application, so the real path remains `BLOCKED` until that bridge and a configured Lean environment are available. The deterministic ScriptExecutor remains the repeatable protocol golden path.

The research parent-review/rework path is covered by the Task Flow integration tests. Rework appends a steer Material and preserves the original child Execution's Initial Context, Workspace, and checkpoint lineage; a parent acceptance completes the child without invoking the Judge.
