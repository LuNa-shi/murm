# Notes Environment

Two independent Pi Bots hand off one supplied source fact through a custom Notes Service. The writer publishes the exact seeded text using `swarm notes put --input note-request.json --request-id notes-put`. The host seeds this request with a string `text` field containing `review-input.json`; passing that JSON text through `--text` would coerce it to an object and fail schema validation. The reader checks it and saves `review.md`, then copies that file to `followup.md` in a second turn. The host checks the Service author and read record and opens both files from the archive after stopping the reader.

This example requires Node.js 22.19 or newer, a running local Docker OpenSandbox provider with the Core project limits enabled, and a compatible worker image containing Pi 1.3.0. Use an absolute path to the checkout of the tested implementation to build the tarball. The rest of the example runs in an independent directory from that tarball.

```sh
repo=/absolute/path/to/SwarmEnv
example_dir=$(mktemp -d)
npm pack "$repo" --pack-destination "$example_dir"
cd "$example_dir"
npm init -y
npm install --omit=dev --ignore-scripts ./swarmenv-core-0.2.0.tgz
tar -xOf swarmenv-core-0.2.0.tgz package/examples/notes-environment/main.mjs > main.mjs
tar -xOf swarmenv-core-0.2.0.tgz package/examples/notes-environment/config.mjs > config.mjs
tar -xOf swarmenv-core-0.2.0.tgz package/src/environments/shared/run-input.js > run-input.mjs
tar -xOf swarmenv-core-0.2.0.tgz package/src/environments/shared/run-report.js > run-report.mjs
tar -xOf swarmenv-core-0.2.0.tgz package/src/environments/shared/read-result.js > read-result.mjs
```

Set `SWARMENV_NOTES_IMAGE` to your compatible worker image ID and `SWARMENV_NOTES_MODEL_URL` to the Kimi K3 Responses endpoint, including the exact `/v1/responses` path. Set `SWARMENV_NOTES_MODEL_TOKEN` if the endpoint requires a bearer token. Configure `SWARMENV_NOTES_ADVERTISE_HOST` to the host's guest-reachable IPv4 address if it differs from `172.17.0.1`. The sample `config.mjs` also reads optional lifecycle host, endpoint host and token variables. Model and lifecycle secrets stay on the host.

```sh
node main.mjs --help
node main.mjs config.mjs > notes-result.json
```

`main.mjs` imports Runtime, Service Registry and the Pi/OpenSandbox backend from the three public package exports. `run-input.mjs`, `run-report.mjs` and `read-result.mjs` are editable host modules. The Environment owns the turn order, the Notes manifest and adapter, the role grants and verification. It uses `followUp` on an idle Bot after subscribing, with one input source and a fresh ID. An unknown or queued submission remains explicit and sends no replacement.

The example runs one fixed writer turn and two reader turns, then closes. The seeded `fact` is its project input. The host exclusively owns these inputs and their request IDs. To change a later reader turn, edit its input in `main.mjs` before starting a new run. The example accepts no interactive directed input while the handoff is in progress. Ctrl+C or SIGTERM ends the current business wait and then enters the configured bounded cleanup. Check the returned per-Bot execution and cleanup receipts after either signal.

Read the final CLI report from `notes-result.json`. It contains the Runtime identity and saved report location, including when the command returned a business or cleanup failure. The shell commands below select that same identity and inspect its saved receipts.

```sh
runtime_id=$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync("notes-result.json","utf8")).runtimeId)')
run_dir=$(node -e 'const fs=require("node:fs"),path=require("node:path"); console.log(path.dirname(JSON.parse(fs.readFileSync("notes-result.json","utf8")).reportPath))')
node main.mjs --result "$run_dir" --runtime-id "$runtime_id"
```

Result inspection reads `environment-report.json` and `runtime.json`, checks both recorded identities, and projects business failure, recorded Core status, per-Bot execution/cleanup, pending count and artifact availability. It reports the Environment result's location without printing its content or interpreting business acceptance. Open the indicated Environment report's `result.verifiedFiles` and reader archive to inspect the actual checked deliverables. A pending receipt remains pending even if another recorded receipt later reports complete. This command reads saved files and does not contact or control a running Runtime.

The running command exits 0 when its business function returned and cleanup and report save succeeded, and exits 1 when any of those failed. Result inspection exits 0 when both correctly identified reports were readable, including a recorded business failure, and exits 1 for missing, invalid, unreadable or foreign records. Invalid command arguments exit 2. Configuration import and startup failures emit a safe error code on stderr and exit 1. Run inspection with only its arguments; it does not load `config.mjs` or require provider credentials.

With the default configuration, each fresh Runtime writes its own directory under `notes-runs`. Read `environment-report.json` for the business result, input receipts, Notes state, cleanup and any save failure. Core writes `runtime.json`, the ordered evidence file and, on successful collection, the reader's artifacts and manifest. A required collection failure can leave a sandbox and Slot pending. Inspect the reported Bot/provider identity and original error. Handle pending ownership in the same host process if embedding the example. The one-shot CLI has no cross-process recovery command.

To use a different source observation, set `fact` in `config.mjs` to an object with `baseline`, `source` and `finding`. Edit `createNotes` and its manifest to change the business Service and adjust Profile grants as needed. The example has no Mission, Task or Execution records. It demonstrates explicit Service handoff and continuity for one reader. Model quality and automated source review are outside its scope.
