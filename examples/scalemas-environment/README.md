# Editable scaleMAS host

Repository TypeScript sources compile with `npm run build` into `dist/`. `npm pack` builds the distributable JavaScript and declarations before archiving.

This example runs the existing fixed peer pool through the public Core and Pi/OpenSandbox backend. Three peers publish, search and visit immutable content through the substrate Service, with independent Sessions and private directories. It creates no Task records. Successful turns and citations do not establish that the generated content is correct.

Use Node.js 22.19 or newer, local Docker OpenSandbox with the Core isolation prerequisites, a compatible Pi 1.3.0 Worker image and a Kimi K3 Responses endpoint. Build the candidate archive from a clean checkout, then install its locked production dependencies in an independent directory:

```sh
repo=/absolute/path/to/SwarmEnv
consumer=$(mktemp -d)
npm pack "$repo" --pack-destination "$consumer"
cd "$consumer"
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts ./swarmenv-core-0.2.0.tgz
cp node_modules/@swarmenv/core/dist/examples/scalemas-environment/config.js ./config.js
```

Run the shipped host in its installed package directory and edit the copied `config.js` in the consumer root. The host imports the shipped Environment and saved-result reader using package-relative paths; the Environment itself uses public Core and Services. Keep `main.js` in its installed location if you edit the host policy. These shipped Environment files are not additional package exports.

```sh
node node_modules/@swarmenv/core/dist/examples/scalemas-environment/main.js --help
```

Set `SWARMENV_SCALEMAS_RUN` to a fresh lowercase alphanumeric/hyphen identifier (up to 64 characters), `SWARMENV_SCALEMAS_IMAGE` to your immutable Worker image ID, and `SWARMENV_SCALEMAS_MODEL_URL` to the exact Kimi K3 `/v1/responses` endpoint. Set `SWARMENV_SCALEMAS_MODEL_TOKEN` if it needs bearer authentication. `SWARMENV_SCALEMAS_HOST` defaults to `172.17.0.1`; choose the guest-reachable host IPv4 address. The config also reads optional lifecycle URL, token and endpoint-host variables. Tokens stay in host backend configuration; never include them in the question or contribution text.

Edit the copied `config.js` question and limits, then launch from the consumer root:

```sh
node node_modules/@swarmenv/core/dist/examples/scalemas-environment/main.js \
  ./config.js > scalemas-result.json
```

The default is three peers, two rounds each, a 120-second work window, a 30-second per-turn wait, a separate 30-second close wait and 2,048 output tokens per model request. The existing mechanism allows three through eight peers and two through 32 rounds. These are bounded example settings, not a one-hour endurance policy or a global request-count cap. To change collaboration, edit the question/config first; `src/environments/scalemas/index.ts` owns peer prompts, the serial drivers and stopping policy, and `substrate.ts` owns content permissions, ranking and persistence. No dynamic spawning or interactive input is provided.

Ctrl+C or SIGTERM aborts further work and enters bounded Core close. The command exits 0 only when business execution, cleanup and report saving succeeded; failures exit 1. Invalid arguments exit 2. Configuration errors print a constant diagnostic code without printing the configuration or exception message. Required export failures or unknown execution can leave resources pending. Neither the one-shot CLI nor `runScaleMASExample(config, signal)` exposes the underlying Runtime for retry or reconciliation. They return reports and leave pending ownership explicit; reconciling such resources requires a separate trusted host procedure using the recorded identities, not another call to this wrapper.

`scalemas-result.json` contains `runtimeId`, `reportPath`, per-peer turn receipts and separate business, cleanup and save failures. Under `scalemas-runs/<runtimeId>/`, Core records `runtime.json`, evidence and collected private files. `environment-report.json` also includes the substrate content/read snapshot and the database path. The persistent `scalemas-runs/substrate.sqlite` survives Bot cleanup; use a fresh output directory/run ID for each independent run. It closes after report projection even when physical cleanup is pending. Published data is not removed. Contributions, queries, artifacts and model output can contain private project text; these files are private run evidence.

Read saved receipts without importing model configuration or contacting a running Runtime:

```sh
runtime_id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("scalemas-result.json","utf8")).runtimeId)')
run_dir=$(node -e 'console.log(require("path").dirname(JSON.parse(require("fs").readFileSync("scalemas-result.json","utf8")).reportPath))')
node node_modules/@swarmenv/core/dist/examples/scalemas-environment/main.js \
  --result "$run_dir" --runtime-id "$runtime_id"
```

Inspection exits 0 when both matching reports were readable, including recorded failures, and 1 for missing or invalid reports. It summarizes receipts and artifact availability, not business acceptance. Inspect the Environment's `substrate.contents`, references and read records, and compare collected files when judging whether another peer's contribution was actually adopted. The installed-package deterministic test covers launch/import, pre-start cancellation and saved inspection. Separate native tests remain version-bound evidence for the mechanism; this wrapper introduces no new native acceptance claim.

## FATE-M with K3

The FATE-M configuration uses the same installed host entry. It freezes problem 1, gives each of four peers the original Lean and natural-language statements, and independently checks every final submission. Shared library, private library and no library are the three conditions. Each group starts after its peers are ready and runs for at most 30 minutes. No host request count, token or cost quota is imposed on K3. The task Service still limits each peer to ten working Lean checks.

The host needs Linux with Bubblewrap, `prlimit`, Git, the pinned Lean 4.28.0 toolchain and the frozen FATE-M workspace with compiled dependencies. Keep the project and toolchain controlled by the host and outside agent directories. The pinned upstream preparation commands are:

```sh
git clone https://github.com/frenzymath/FATE-M.git fate-m
git -C fate-m checkout --detach 4eb33c8ccd0ff058b461cd763cc406509129743f
elan toolchain install leanprover/lean4:v4.28.0
(cd fate-m && lake exe cache get)
```

From a consumer directory containing the installed SwarmEnv tarball, set `SWARMENV_FATE_PROJECT` to that workspace and `SWARMENV_FATE_LEAN` to the installed Lean toolchain directory. Set `SWARMENV_SCALEMAS_RUN` to a fresh ID, `SWARMENV_SCALEMAS_IMAGE` to the reviewed worker image, and `SWARMENV_SCALEMAS_MODEL_URL` and `SWARMENV_SCALEMAS_MODEL_TOKEN` to the approved K3 endpoint and credential. The model URL includes its Responses route. Optional lifecycle settings are listed in the generic example above. `SWARMENV_SCALEMAS_OUTPUT` defaults to `./experiments/scalemas-fate`.

```sh
example=node_modules/@swarmenv/core/dist/examples/scalemas-environment
node "$example/main.js" --fate-prepare "$SWARMENV_FATE_PROJECT" "$SWARMENV_FATE_LEAN"
node "$example/main.js" --fate-matrix "$example/fate-config.js"
node "$example/main.js" --fate-rescore "$SWARMENV_FATE_PROJECT" "$SWARMENV_FATE_LEAN" \
  "./experiments/scalemas-fate/${SWARMENV_SCALEMAS_RUN}-shared/fate-frozen-candidates.json"
```

For a single condition, set `SWARMENV_FATE_MODE` to `shared`, `private` or `none`, then pass the configuration file directly. The matrix uses an independent directory for each condition, in that order, and stops launching groups if a prior group's cleanup is pending. A run ID cannot overwrite earlier evidence. Preparation and rescoring make no model calls. Formal runs require the repository's frozen experiment registration.

`fate-result.json` records task/peer state, score, end reasons, model usage, Core Trace and cleanup, and points to the frozen candidate bundle. A final candidate is a Lean term such as a `by` proof, with any helper lemmas declared locally inside the proof. Sources, candidate contents, peer journals and raw tool results are private run evidence. See the [architecture chapter](../../docs/architecture/19-scalemas-environment.md#fate-paper-alignment-configurations) for the contracts and the [Phase 0005 design](../../docs/phases/0005-core-environment/05-scalemas-fate.md) for acceptance.

## FATE-H with K3

The shipped FATE configuration selects `kimi_proxy/k3`. An explicit host configuration can also set the selected `backend.models` entry to `provider: 'gpt_proxy', model: 'gpt-6.1-sol'` and supply that provider's Responses URL and host credential.

Set `SWARMENV_FATE_BENCHMARK=FATE-H` and `SWARMENV_FATE_PROJECT` to the prepared workspace for FATE-H #2. Freeze [FATE-H at `17967b3`](https://github.com/frenzymath/FATE-H/tree/17967b3118082adfba7c5a5fc03b5f4a53717b59) and run `lake exe cache get` in that workspace. It uses the same Lean 4.28.0 and dependency source revisions as FATE-M. Pass `FATE-H` after the project and toolchain paths in `--fate-prepare`. A frozen bundle selects its own benchmark during rescoring, and the supplied project must match it.

```sh
export SWARMENV_FATE_BENCHMARK=FATE-H
node "$example/main.js" --fate-prepare "$SWARMENV_FATE_PROJECT" "$SWARMENV_FATE_LEAN" FATE-H
node "$example/main.js" --fate-matrix "$example/fate-config.js"
```

This configuration gives four peers up to 45 minutes of work and samples progress after 30 minutes. `fate-work-checkpoint.json` is host-only and records timestamps, peer state, candidate digests and tool/substrate evidence if the group is still working. If the group ends early, `fate-result.json` records `not_reached` and its actual closeout. Checkpoint capture does not send a wake or change the work deadline.

## FATE-X #31

Prepare [FATE-X at `a6fb49e`](https://github.com/frenzymath/FATE-X/tree/a6fb49ee85fd05bb8ce9fc66e1c66797b5a0592d) with `lake exe cache get`. It uses the same Lean 4.28.0 and Mathlib revision. Point `SWARMENV_FATE_PROJECT` at that workspace, then select FATE-X in the launcher and preparation steps. The checker uses the full original `Problem31.UFD_of_ge_5` declaration with its local definitions. The default work window is 30 minutes.

```sh
export SWARMENV_FATE_BENCHMARK=FATE-X
node "$example/main.js" --fate-prepare "$SWARMENV_FATE_PROJECT" "$SWARMENV_FATE_LEAN" FATE-X
node "$example/main.js" "$example/fate-config.js"
```
