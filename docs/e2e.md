# End-to-end verification

The locked fixture is `fixtures/putnam-1966-a1`. Its manifest pins the PutnamBench commit, problem-file hash, Lean toolchain, Mathlib revision, checker version, and environment reference. The checked-in candidates contain the same fixed Putnam theorem: the invalid candidate has a real Lean name-resolution failure, while the valid candidate is a complete proof of that theorem.

Run the deterministic root proof path with:

```sh
node scripts/run-mvp-fixture.mjs --keep
```

The JSON audit records the task, execution, frozen Initial Context, candidate Materials, both CheckResults, workspace and checkpoint references, process-session count, and the retained FAIL evidence. The same ScriptExecutor protocol runs the first invalid candidate, restores the existing Workspace after the failed CheckResult, submits a superseding candidate, and applies PASS. It uses the public Services SDK, Runtime, Workspace Manager, and Judge Service; the script does not write directly to SQLite.

The real Agent Core path is available through:

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

It also requires `nurouter`, `pi`, `lean`, and `lake` on `PATH`, plus a local checkout of the locked PutnamBench commit. Set its path explicitly when it is not the current directory:

```sh
export SWARMENV_PUTNAMBENCH_ROOT=/path/to/PutnamBench/lean4
```

`AgentCoreAdapter` launches NuRouter/Pi in RPC mode inside the Runtime-owned Workspace and loads `src/agent/swarmenv-extension.mjs`. That extension exposes the loopback `ServicesBridge` as the model-callable `swarmenv_call` tool. The bridge authenticates with a per-run token and routes Task, Execution, Material, candidate, heartbeat, and child-task operations through `ServicesSDK`; it does not expose SQLite or Workspace Manager writes to the Agent. The host Runtime remains responsible for saving the Workspace revision and checkpoint before each durable wait, and the host Judge remains responsible for Lean execution and CheckResult application.

The probe reports command versions and missing variable names without recording credential values. A successful process launch is reported separately from a completed proof. When routing or toolchain prerequisites are absent, the command returns a `BLOCKED` audit report. With them present, the run records the real Agent RPC phases, Material lineage, checkpoint lineage, Lean FAIL evidence, superseding candidate, Lean PASS, fixture versions, and terminal Task/Execution states. The deterministic ScriptExecutor remains the repeatable protocol golden path.

The research parent-review/rework path is covered by the Task Flow integration tests. Rework appends a steer Material and preserves the original child Execution's Initial Context, Workspace, and checkpoint lineage; a parent acceptance completes the child without invoking the Judge.
