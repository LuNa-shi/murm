# Editable scaleMAS host

This example runs the existing fixed peer pool through the public Core and Pi/OpenSandbox backend. Three peers publish, search and visit immutable content through the substrate Service, with independent Sessions and private directories. It creates no Task records. Successful turns and citations do not establish that the generated content is correct.

Use Node.js 22.19 or newer, local Docker OpenSandbox with the Core isolation prerequisites, a compatible Pi 1.3.0 Worker image and a Kimi K3 Responses endpoint. Build the candidate archive from a clean checkout, then install its locked production dependencies in an independent directory:

```sh
repo=/absolute/path/to/SwarmEnv
consumer=$(mktemp -d)
npm pack "$repo" --pack-destination "$consumer"
cd "$consumer"
npm init -y
npm install --omit=dev --ignore-scripts ./swarmenv-core-0.2.0.tgz
cp node_modules/@swarmenv/core/examples/scalemas-environment/config.mjs ./config.mjs
```

Run the shipped host in its installed package directory and edit the copied `config.mjs` in the consumer root. The host imports the shipped Environment and saved-result reader using package-relative paths; the Environment itself uses public Core and Services. Keep `main.mjs` in its installed location if you edit the host policy. These shipped Environment files are not additional package exports.

```sh
node node_modules/@swarmenv/core/examples/scalemas-environment/main.mjs --help
```

Set `SWARMENV_SCALEMAS_RUN` to a fresh lowercase alphanumeric/hyphen identifier (up to 64 characters), `SWARMENV_SCALEMAS_IMAGE` to your immutable Worker image ID, and `SWARMENV_SCALEMAS_MODEL_URL` to the exact Kimi K3 `/v1/responses` endpoint. Set `SWARMENV_SCALEMAS_MODEL_TOKEN` if it needs bearer authentication. `SWARMENV_SCALEMAS_HOST` defaults to `172.17.0.1`; choose the guest-reachable host IPv4 address. The config also reads optional lifecycle URL, token and endpoint-host variables. Tokens stay in host backend configuration; never include them in the question or contribution text.

Edit the copied `config.mjs` question and limits, then launch from the consumer root:

```sh
node node_modules/@swarmenv/core/examples/scalemas-environment/main.mjs \
  ./config.mjs > scalemas-result.json
```

The default is three peers, two rounds each, a 120-second work window, a 30-second per-turn wait, a separate 30-second close wait and 2,048 output tokens per model request. The existing mechanism allows three through eight peers and two through 32 rounds. These are bounded example settings, not a one-hour endurance policy or a global request-count cap. To change collaboration, edit the question/config first; `src/environments/scalemas/index.js` owns peer prompts, the serial drivers and stopping policy, and `substrate.js` owns content permissions, ranking and persistence. No dynamic spawning or interactive input is provided.

Ctrl+C or SIGTERM aborts further work and enters bounded Core close. The command exits 0 only when business execution, cleanup and report saving succeeded; failures exit 1. Invalid arguments exit 2. Configuration errors print a constant diagnostic code without printing the configuration or exception message. Required export failures or unknown execution can leave resources pending. The one-shot CLI cannot reconcile them across processes; embed `runScaleMASExample(config, signal)` when you need to retain host ownership for reconciliation.

`scalemas-result.json` contains `runtimeId`, `reportPath`, per-peer turn receipts and separate business, cleanup and save failures. Under `scalemas-runs/<runtimeId>/`, Core records `runtime.json`, evidence and collected private files. `environment-report.json` also includes the substrate content/read snapshot and the database path. The persistent `scalemas-runs/substrate.sqlite` survives Bot cleanup; use a fresh output directory/run ID for each independent run. It closes after report projection even when physical cleanup is pending. Published data is not removed. Contributions, queries, artifacts and model output can contain private project text; these files are private run evidence.

Read saved receipts without importing model configuration or contacting a running Runtime:

```sh
runtime_id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("scalemas-result.json","utf8")).runtimeId)')
run_dir=$(node -e 'console.log(require("path").dirname(JSON.parse(require("fs").readFileSync("scalemas-result.json","utf8")).reportPath))')
node node_modules/@swarmenv/core/examples/scalemas-environment/main.mjs \
  --result "$run_dir" --runtime-id "$runtime_id"
```

Inspection exits 0 when both matching reports were readable, including recorded failures, and 1 for missing or invalid reports. It summarizes receipts and artifact availability, not business acceptance. Inspect the Environment's `substrate.contents`, references and read records, and compare collected files when judging whether another peer's contribution was actually adopted. The installed-package deterministic test covers launch/import, pre-start cancellation and saved inspection. Separate native tests remain version-bound evidence for the mechanism; this wrapper introduces no new native acceptance claim.
