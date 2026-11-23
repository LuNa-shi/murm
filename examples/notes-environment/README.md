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
```

Set `SWARMENV_NOTES_IMAGE` to your compatible worker image ID and `SWARMENV_NOTES_MODEL_URL` to the Kimi K3 Responses endpoint, including the exact `/v1/responses` path. Set `SWARMENV_NOTES_MODEL_TOKEN` if the endpoint requires a bearer token. Configure `SWARMENV_NOTES_ADVERTISE_HOST` to the host's guest-reachable IPv4 address if it differs from `172.17.0.1`. The sample `config.mjs` also reads optional lifecycle host, endpoint host and token variables. Model and lifecycle secrets stay on the host.

```sh
node main.mjs config.mjs
```

`main.mjs` imports Runtime, Service Registry and the Pi/OpenSandbox backend from the three public package exports. `run-input.mjs` and `run-report.mjs` are editable host modules. The Environment owns the turn order, the Notes manifest and adapter, the role grants and verification. It uses `followUp` on an idle Bot after subscribing, with one input source and a fresh ID. An unknown or queued submission remains explicit and sends no replacement. Ctrl+C ends the business wait and lets Core use its separate cleanup window.

With the default configuration, each fresh Runtime writes its own directory under `notes-runs`. Read `environment-report.json` for the business result, input receipts, Notes state, cleanup and any save failure. Core writes `runtime.json`, the ordered evidence file and, on successful collection, the reader's artifacts and manifest. A required collection failure can leave a sandbox and Slot pending. Inspect the reported Bot/provider identity and original error. Handle pending ownership in the same host process if embedding the example. The one-shot CLI has no cross-process recovery command.

To use a different source observation, set `fact` in `config.mjs` to an object with `baseline`, `source` and `finding`. Edit `createNotes` and its manifest to change the business Service and adjust Profile grants as needed. The example has no Mission, Task or Execution records. It demonstrates explicit Service handoff and continuity for one reader. Model quality and automated source review are outside its scope.
