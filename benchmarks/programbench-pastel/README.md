# ProgramBench Pastel benchmark

Rebuild the Pastel color CLI for ProgramBench instance `sharkdp__pastel.b60e899`. Subagents, Flat and Agensh receive the same task and reference executable. Each has its own workspace and delivery mechanism. The case checks whether multiple Bots can hand off source, incorporate a contribution and freeze a buildable submission within a fixed window.

This is a development benchmark run explicitly from a source checkout. [Repository tests](../../test/README.md) and [Environment examples](../../README.md#environments) have their usual entry points. Benchmark output goes under the ignored `experiments/programbench-pastel/` directory. The npm package, application CLI and default test command do not include the benchmark.

## Case and results

| Input | Pin |
|---|---|
| ProgramBench instance | `sharkdp__pastel.b60e899` |
| Pastel source revision | `b60e89932629b2d162e1ff9f3976a5a0ef1e5db9` |
| ProgramBench evaluator | `895f65916bc5ba34a915d36da321fde0301125ad` |
| Test data snapshot | `5954a1957b5e0d770ec2c5523506abd212806315` |
| Reference and evaluation image | `programbench/sharkdp_1776_pastel.b60e899@sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e` |
| Native Agensh Board source | `2dae4e14a653da48549fd9aa093f834841475d6c` |

| Environment | Work and evidence |
|---|---|
| Subagents | A parent delegates to two children and publishes a source tree through its candidate Service. The host matches source bytes to a completed child result delivered to that parent. |
| Flat | The host seeds parser, formatter and integration Tasks. The integrator publishes source as Material attachments. The host checks the actual producer and consumer Executions, source hashes and `integration` consumption record. This runner gives each Task a cap equal to the configured work window. The outer window stops model traffic and candidate writes at the common deadline. |
| Agensh | Two contributors start together. The host merges their pinned PR heads, then dispatches the integrator on the resulting main. The host checks Board publication and read order, fixed Git revisions and source bytes incorporated by the integrator. |

The three registered Kimi K3 runs used an earlier revision and each reached its 30-minute deadline without an archive. Subagents delivered child results. Flat repeatedly expired at the previous 60-second Task limit. Agensh merged the first contribution and never reached the integrator. The version-bound report retains these outcomes and the cleanup evidence. [Issue #209](https://github.com/LuNa-shi/SwarmEnv/issues/209) · [Formal results](../../docs/experiments/EXP-20261125-programbench-pastel.md)

## Prepare a local Worker

Run from the repository root on a Linux Docker host with Node.js 22.19 or newer, Python 3.11 or newer for archive tooling, Git, and a running Docker OpenSandbox provider with Core project limits and network isolation enabled. [Pi/OpenSandbox backend](../../docs/architecture/16-pi-opensandbox-backend.md)

```sh
npm ci
npm run build

cleanroom=programbench/sharkdp_1776_pastel.b60e899
cleanroom_digest=sha256:e75597f4307bf02746598d2b7eb8ae136b9978f0c2551e04b065b14e9e5f9c4e
docker pull "$cleanroom@$cleanroom_digest"
docker tag "$cleanroom@$cleanroom_digest" "$cleanroom:task_cleanroom_v6"

docker build -f services/opensandbox-agent/Dockerfile \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  -t swarmenv-programbench-base:local .
docker build -t swarmenv-programbench-pastel:local benchmarks/programbench-pastel
worker=$(docker image inspect swarmenv-programbench-pastel:local --format '{{.Id}}')
```

The Worker recipe installs only the reference executable and public documentation from the cleanroom image. Core supplies the Bot network grants. The test data stay in the host evaluator. The Worker has no provider credentials. OpenSandbox defaults to `http://127.0.0.1:8080/v1`, with `127.0.0.1` as endpoint host and `172.17.0.1` as the container-reachable host address. Export `SWARMENV_CORE_TEST_LIFECYCLE_URL`, `SWARMENV_CORE_TEST_ENDPOINT_HOST`, `SWARMENV_CORE_TEST_ADVERTISE_HOST` or `SWARMENV_CORE_TEST_API_KEY` if the provider requires different values.

Agensh also requires Docker images for Git, messaging, database and Board. Pull the first three by their pinned digest. The runner resolves those references to local image IDs. Build the Board from the existing pinned submodule and pass its local image ID.

```sh
docker pull docker.gitea.com/gitea@sha256:538658de667c5d098a274f2f63aa6ec891d88f670cdd5282cf27221ba747dda4
docker pull mysql@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902
docker pull mattermost/mattermost-team-edition@sha256:eadc42c1fefbe9837aa628ff3005c1ed7f08df6ecc372d2b549b7fc75736cb41
git submodule update --init third_party/agensh
docker build -t swarmenv-programbench-board:local third_party/agensh/board-service
export PROGRAMBENCH_BOARD_IMAGE=$(docker image inspect swarmenv-programbench-board:local --format '{{.Id}}')
```

## Run local verification

The benchmark runs its TypeScript source directly with Node. Build SwarmEnv first so the drivers can import `dist/`. Its separate TypeScript check and run-window tests are opt-in.

```sh
./node_modules/.bin/tsc --project benchmarks/programbench-pastel/tsconfig.json
node --test benchmarks/programbench-pastel/run-window.test.ts
for mode in subagents flat agensh; do
  node benchmarks/programbench-pastel/pastel-open-local.ts "$mode" "$worker" 30000 || exit
done
```

The run-window tests cover gateway admission, metering, in-flight cancellation and late checkpoint rejection. The three-mode loop runs actual Pi/OpenSandbox Bots and collaboration Services against scripted loopback Responses. Each mode must verify two source contributions in its timed archive and finish cleanup. Controlled responses exercise the collaboration path and provide a small runnable fixture. Provider calls and ProgramBench scores are separate evidence. Each mode prints a receipt path for inspection or evaluation.

## Run the official evaluator

The evaluator is a separate checkout with the pinned test snapshot already cached. The preparation commands below use [upstream ProgramBench](https://github.com/facebookresearch/programbench) and its [test data](https://huggingface.co/datasets/programbench/ProgramBench-Tests).

```sh
asset_dir=experiments/programbench-pastel
mkdir -p "$asset_dir"
git clone https://github.com/facebookresearch/programbench.git "$asset_dir/upstream"
git -C "$asset_dir/upstream" checkout --detach 895f65916bc5ba34a915d36da321fde0301125ad
(
  cd "$asset_dir/upstream" || exit
  uv sync --frozen
  PROGRAMBENCH_HF_REPO=programbench/ProgramBench-Tests \
  PROGRAMBENCH_HF_REVISION=5954a1957b5e0d770ec2c5523506abd212806315 \
    .venv/bin/programbench blob sync sharkdp__pastel.b60e899
)
```

Set `PROGRAMBENCH_EVALUATOR_DIR` to use an existing checkout at the same commit. Set `receipt` to the path printed by a local verification run, then evaluate it.

```sh
node benchmarks/programbench-pastel/pastel-matrix.ts evaluate "$receipt"
```

The evaluator checks the exact local cleanroom and verified archive, then evaluates a copy in a fresh ignored directory using cached test data. The receipt records build or evaluator errors, branch/test counts and the official score. A zero score is compatible with valid collaboration. A run without a timed archive has no score.

## Run an authorized hosted matrix

Follow the [experiment workflow](../../docs/workflows/experiment.md). Use a clean checkout, approved budget and one new registered EXP ID per mode. The same Worker, facility images and cached evaluator inputs are used. Export provider credentials on the host and point the manifest at a private JSON catalog. This is its relevant shape.

```json
{
  "providers": {
    "kimi_proxy": {
      "api": "openai-responses",
      "authHeader": true,
      "baseUrl": "$PROGRAMBENCH_KIMI_BASE_URL",
      "apiKey": "$PROGRAMBENCH_KIMI_API_KEY",
      "models": [{ "id": "k3" }]
    }
  }
}
```

The provider base URL ends in `/v1`. Generate pins after building the Worker and preparing the evaluator. The command rebuilds and fingerprints the compiled host code. It verifies the Worker label matches the clean checkout commit. The hosted command repeats those checks and compares all pins before any provider call.

```sh
node benchmarks/programbench-pastel/pastel-matrix.ts pins "$worker" \
  > experiments/programbench-pastel/pins.json
```

The private manifest takes `pins` as the JSON object printed above, `issue` as the approved issue URL, `experiments` as an object keyed by `subagents`, `flat` and `agensh` with registered EXP IDs, and `catalogPath` and `registryPath` as paths to the private catalog and registry with those IDs. Use absolute paths or run from the directory to which those paths are relative.

```sh
node benchmarks/programbench-pastel/pastel-matrix.ts hosted "$manifest"
```

Each mode has three concurrent Bot slots and its own 1,800-second monotonic window. The command exits nonzero if any mode misses the timed collaboration and cleanup checks. Active streams are interrupted at the deadline. The host verifies the archive and source-adoption evidence, then records the official evaluator outcome separately. Use the final matrix receipt and [experiment report template](../../docs/experiments/TEMPLATE.md) for reporting. Keep provider configuration, transcripts, databases, archives and logs in the ignored experiment directory.
