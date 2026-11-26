# PutnamBench 2025 B1 on TaskPool

This opt-in driver runs the pinned original Lean theorem with the normal TaskPool host and the local Pi/OpenSandbox backend. The trial opens with an empty Task pool and four researcher slots. Agents can save and apply proof files in the same Session. The defaults are Kimi K3 and a one-hour research window. The [TaskPool implementation](../../docs/architecture/02-execution.md) and [Issue #200](https://github.com/LuNa-shi/murm/issues/200) describe the input boundary and its acceptance evidence.

The driver submits Material notices through Pi's steering queue. A busy recipient can receive a notice in its next model request after its current tool batch. The notice keeps the active Task, Execution and Session. The report records admission separately from model visibility, handling and use in the proof.

## Prepare the fixed inputs

Use the official [PutnamBench tree](https://github.com/trishullab/PutnamBench/tree/a635813f5edf297d928f9bd5ef8324a26bdde09c) and the standard locked final-tree deployment. The checker configuration must enable `projectChecks` and name a trusted `artifactLock`. See [the deployment manual](../../docs/architecture/07-run-configuration.md#generic-checker-deployment-after-benchmark-retirement) for the Lean, Mathlib, Comparator and exporter roots. The tracked Mathlib source in the lock supplies the search service.

```sh
npm run build
node dist/scripts/lock-final-tree-checker.js checker-config.json checker-sources.json artifact-lock.json
node benchmarks/putnambench-taskpool/main.ts preflight trusted-checker-config.json /path/to/PutnamBench
```

The trusted checker configuration uses the same settings as the lock command and adds the canonical absolute path to the resulting lock. Preflight runs real Lean. It expects the initial project to compile and the final checker to reject the original placeholder. It does not invoke the hosted model.

## Run the registered benchmark

Build the Worker from the clean, pinned implementation, then record its immutable image ID and the checker lock in the [experiment registry](../../docs/experiments/INDEX.md). The registry entry uses `**REGISTERED` status, links #200 and pins the implementation commit. The operator supplies K3 credentials through `PI_KIMI_PROXY_BASE_URL` and `PI_KIMI_PROXY_API_KEY`. An equivalent local Pi catalog can supply the model configuration through `MURM_PI_MODELS_FILE`, which defaults to `~/.pi/agent/models.json`. The local sandbox settings use `MURM_SANDBOX_LIFECYCLE_URL`, `MURM_SANDBOX_ENDPOINT_HOST`, `MURM_SANDBOX_ADVERTISE_HOST` and the optional `MURM_SANDBOX_API_KEY`.

```sh
docker build --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  -f deploy/worker/Dockerfile -t murm-putnam-flat .
docker image inspect murm-putnam-flat --format '{{.Id}}'
node benchmarks/putnambench-taskpool/main.ts run trusted-checker-config.json /path/to/PutnamBench \
  EXP-YYYYMMDD-NN sha256:<worker-image-id>
```

The default research window is 3,600 seconds. The optional argument after the image ID sets a registered shorter window in whole seconds. Each Agent gets up to 300 seconds to select work by default, matching the original Putnam runner. For a registered timing diagnostic, append the selection duration after the research duration, for example `3600 600` for ten minutes of selection within a one-hour run. This duration must fit inside the research window. The controller caps each Agent's selection at the shared deadline. The launch identity and final receipt record the selection duration.

A registered selection reasoning diagnostic can add `low` after both durations. For example, `3600 600 low` sets the reasoning effort sent to K3 while a Agent selects work. Work and closeout requests retain the effort supplied by Pi. The launch identity and receipt record the setting. The private model trace records the actual request sent upstream.

For the registered GPT comparison, append the selected model after the reasoning setting, for example `1800 600 low gpt-6.1-sol`. Include the line `` Model · `gpt_proxy/gpt-6.1-sol` `` in the registered report. The launcher compares the report to the selected pair before reserving the run directory. GPT uses `PI_GPT_PROXY_BASE_URL` and `PI_GPT_PROXY_API_KEY` or the matching entry in the same local Pi catalog.

The runner claims the experiment directory once. It keeps the original fixture, databases, Core traces, version metadata and final receipts private under that directory. Use the Git tree ID from the receipt to replay the final candidate and the revision ancestry and Lean proof to verify actual adoption. The fixed final assessment, Mission submission, stop reason and resource result are independent fields.

## Local checks

```sh
npx tsc -p benchmarks/putnambench-taskpool/tsconfig.json
node --test benchmarks/putnambench-taskpool/case.test.ts benchmarks/shared/run-window.test.ts
```
