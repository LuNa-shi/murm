# Substrate Harness

Substrate gives a fixed pool of peers a publication Service. Peers publish,
search and visit contributions while keeping separate Sessions and project
directories. The generic project mode creates no Task records and requires no
separate database container: the example owns its SQLite publication store.

## Configure and run a project

Prepare the common
OpenSandbox/Worker infrastructure and set `MURM_MODEL_URL`, `MURM_MODEL_TOKEN`,
`MURM_MODEL_PROVIDER` and `MURM_MODEL_ID`. Pi is the default executor; select
`MURM_EXECUTOR=codex` with an explicit model ID to use Codex.
`MURM_SUBSTRATE_MODEL_*` and `MURM_SUBSTRATE_EXECUTOR` remain scoped fallbacks.

Use Node.js 22.19 or newer on Linux. Set `MURM_ARCHIVE` to the absolute path of
the SDK tarball built from this revision. The published v0.2.0 archive predates
the project author API used here. See [SDK preparation](../README.md#run-an-example-from-its-directory)
for the pack command, Sandbox setup and model configuration.

From this example directory:

```sh
npm install --no-save "$MURM_ARCHIVE"
npm run check
npm run build
npm run start -- --cwd /absolute/path/to/project \
  --prompt 'Compare implementation approaches and cite peer contributions you use'
```

With the CLI installed, run `murm --harness substrate --prompt '...'` in your
project. Each peer receives the captured files and uses the prompt as its
question. The host creates the run ID. No question/workload file is required.

The default is three peers, two rounds, a 120-second work window, a 30-second
per-turn wait and a separate 30-second close wait. The normal API isolation
policy is used; it does not promise a host-enforced disk/inode quota. Supply a
trusted module with `--config` to change limits, models, executor or provider.
Generic mode supports 3–8 peers and 2–32 rounds. It has no dynamic spawning or
interactive input during those rounds.

## Inspect and modify the mechanism

The final command record points to the saved run report, publication database,
Trace and private artifacts. Business execution, export, cleanup and report
saving are reported separately. Contributions and citations show information
flow; they do not establish correctness. Required export or uncertain execution
can leave resources pending. Review those receipts before treating a run as
fully closed.

The Harness module owns peer prompts, work order and stopping policy. Its
substrate Service owns publication permissions, ranking and persistence. See the
[mechanism guide](../../docs/en/harnesses/substrate.md) and
[implementation manual](../../docs/architecture/19-substrate-harness.md).

## Explicit fixture and benchmark entrypoints

`main.ts` remains the entry for fixed-question fixtures, saved-result inspection
for ordinary Substrate. `config.ts` is its fixed-question configuration and
requires `MURM_SUBSTRATE_RUN`; it is not the input to the normal project command.
From this directory after building:

```sh
node ../../dist/examples/substrate/main.js --help
node ../../dist/examples/substrate/main.js ../../dist/examples/substrate/config.js
```

For an installed package, replace `../../dist/examples/substrate` with
`node_modules/@luna-shi/murm/dist/examples/substrate` from your consumer project.
Keep the shipped modules in their installed location because their relative
imports are part of the package. `--result <run-directory> --runtime-id <id>`
reads saved reports without loading model credentials.

The dedicated [FATE benchmark](../../benchmarks/fate/README.md) owns its Lean
checker, paper-oriented publication policy, scoring and pinned workload
configuration. Ordinary projects use the SQLite Service described above.
