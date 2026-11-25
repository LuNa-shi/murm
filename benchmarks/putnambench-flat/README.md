# PutnamBench 2025 B1 on Flat

This opt-in driver runs the pinned original Lean theorem with the normal Flat host and the local Pi/OpenSandbox backend. The trial opens with an empty Task pool and four researcher slots. Bots can save and apply proof files in the same Session. The formal run uses Kimi K3 and a one-hour research window. See the [Phase 0005 design](../../docs/phases/0005-core-environment/04-flat-math.md) for input visibility and acceptance.

## Prepare the fixed inputs

Use the official [PutnamBench tree](https://github.com/trishullab/PutnamBench/tree/a635813f5edf297d928f9bd5ef8324a26bdde09c) and the standard locked final-tree deployment. The checker configuration must enable `projectChecks` and name a trusted `artifactLock`. See [the deployment manual](../../docs/architecture/07-run-configuration.md#generic-checker-deployment-after-benchmark-retirement) for the Lean, Mathlib, Comparator and exporter roots. The tracked Mathlib source in the lock supplies the search service.

```sh
npm run build
node dist/scripts/lock-final-tree-checker.js checker-config.json checker-sources.json artifact-lock.json
node benchmarks/putnambench-flat/main.ts preflight trusted-checker-config.json /path/to/PutnamBench
```

The trusted checker configuration uses the same settings as the lock command and adds the canonical absolute path to the resulting lock. Preflight runs real Lean. It expects the initial project to compile and the final checker to reject the original placeholder. It does not invoke the hosted model.

## Run the registered benchmark

Build the Worker from the clean, pinned implementation, then record its immutable image ID and the checker lock in the [experiment registry](../../docs/experiments/INDEX.md). The registry entry uses `**REGISTERED` status, links #200 and pins the implementation commit. The operator supplies K3 credentials through `PI_KIMI_PROXY_BASE_URL` and `PI_KIMI_PROXY_API_KEY`. An equivalent local Pi catalog can supply the model configuration through `SWARMENV_PI_MODELS_FILE`, which defaults to `~/.pi/agent/models.json`. The local sandbox settings use `SWARMENV_SANDBOX_LIFECYCLE_URL`, `SWARMENV_SANDBOX_ENDPOINT_HOST`, `SWARMENV_SANDBOX_ADVERTISE_HOST` and the optional `SWARMENV_SANDBOX_API_KEY`.

```sh
docker build --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  -f services/opensandbox-agent/Dockerfile -t swarmenv-putnam-flat .
docker image inspect swarmenv-putnam-flat --format '{{.Id}}'
node benchmarks/putnambench-flat/main.ts run trusted-checker-config.json /path/to/PutnamBench \
  EXP-YYYYMMDD-NN sha256:<worker-image-id>
```

The runner claims the experiment directory once. It keeps the original fixture, databases, Core traces, version metadata and final receipts private under that directory. Use the Git tree ID from the receipt to replay the final candidate and the revision ancestry and Lean proof to verify actual adoption. The fixed final assessment, Mission submission, stop reason and resource result are independent fields.

## Local checks

```sh
npx tsc -p benchmarks/putnambench-flat/tsconfig.json
node --test benchmarks/putnambench-flat/case.test.ts benchmarks/shared/run-window.test.ts
```
