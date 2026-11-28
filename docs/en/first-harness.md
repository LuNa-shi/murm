---
title: Build your first SDK Harness
description: Install a fixed murm archive and run a two-Agent handoff with a terminal reply, byte verification, and cleanup.
section: GET STARTED
order: 4
---

A publisher reads a reference from its workspace and asks you where to send it. You choose the channel in the terminal. A second Agent retrieves the reference through a Service and writes a checked delivery file. Start with the [Linux prerequisites in Quickstart](quickstart.md#prerequisites). Use Node.js 22.19+ with npm, rootful Docker for the released v0.2.0 path, and a model endpoint that supports streaming and tool calls.

## 1. Pick your SDK archive

### Published v0.2.0

Complete the [v0.2.0 host requirements](latest.md#host-requirements), including Landlock ABI 5+, local rootful Docker and the documented non-interactive sudo setup. The default Ubuntu 24.04 kernel does not provide ABI 5.

```bash
mkdir -p "$HOME/murm-first-harness" && cd "$HOME/murm-first-harness"
curl -fLO https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
curl -fLO https://github.com/LuNa-shi/murm/releases/download/v0.2.0/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
export MURM_LEGACY_020=1
export MURM_ADVERTISE_HOST="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
export MURM_WORKER_IMAGE=ghcr.io/luna-shi/murm-worker:0.2.0
export MURM_SDK_ARCHIVE="$PWD/luna-shi-murm-0.2.0.tgz"
```

Use the same Docker context for setup and the example. This archive uses explicit strict-local Sandbox configuration. The version check below uses npm because this release predates `murm --version`.

### Candidate built from current docs

If you are testing a candidate, obtain its exact tarball and checksum from the candidate provider. Set `MURM_SDK_ARCHIVE` to the tarball's absolute path, verify the checksum, and run the remaining steps in a new empty directory. Leave `MURM_LEGACY_020` unset. A candidate may retain the previous manifest version during development, so record the archive SHA-256 as well as the version. For a repository build, use the [source Quickstart](quickstart.md#option-b-build-and-install-from-source-main) to generate an archive.

## 2. Install and connect

Use the same archive for the global CLI and your project dependency.

```bash
npm install -g --prefix "$HOME/.local" --ignore-scripts "$MURM_SDK_ARCHIVE"
export PATH="$HOME/.local/bin:$PATH"
command -v murm
if [ "${MURM_LEGACY_020:-}" = 1 ]; then
  npm ls --global --prefix "$HOME/.local" @luna-shi/murm --depth=0
else
  murm --version
fi
set -o pipefail
murm setup | tee setup.json
```

Wait for `"infrastructure": "ready"` and `"ok": true`. Keep the same environment when running the Harness. On a candidate, `connection` in `setup.json` identifies the Lifecycle and callback addresses and the Worker tag. The example uses `resolveSandboxConnection()` in that same environment, including the private local key or the exported credential for an existing service. For a custom Worker, set `MURM_WORKER_IMAGE` for both commands. For a custom local port, pass `murm setup --mode local` with `MURM_LIFECYCLE_URL` set.

The host connects to Lifecycle and starts a real Worker. The Worker reaches the Bridge and Model Gateway at the advertised host address. The **host** connects to the actual model endpoint you set below. The setup smoke uses a controlled upstream. A passed smoke records the infrastructure checks and deletion of its temporary Sandbox.

### Recover from a wrong Lifecycle address

On the candidate, run the following read-only preflight, then retry with your original environment. The inline assignment applies to that command only.

```bash
MURM_LIFECYCLE_URL=http://127.0.0.1:1/v1 murm doctor
murm doctor
```

The first preflight should fail at `provider.health` with the configuration entry to check. The second should pass. Use `murm doctor --smoke` to repeat the Worker and callback checks. [Quickstart](quickstart.md#2-set-up-opensandbox--build-the-worker) covers image and Docker failures.

## 3. Make it your project

Install the pinned dependency in the directory where you will save the example. Set your model endpoint, model ID and credential. Omit the token for an upstream that requires none. Candidate Pi Workers also support `MURM_MODEL_PROTOCOL=chat-completions` with a streaming `/v1/chat/completions` endpoint.

```bash
npm init -y
npm pkg set type=module
npm install --ignore-scripts "$MURM_SDK_ARCHIVE"
npm install --save-dev typescript @types/node
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_ID='gpt-5-mini'
read -rsp 'Model API token: ' MURM_MODEL_TOKEN && export MURM_MODEL_TOKEN && printf '\n'
```

### Candidate Harness and client

Save [harness.ts](../../examples/first-harness/harness.ts), [session.ts](../../examples/first-harness/session.ts), [handoff.ts](../../examples/first-harness/handoff.ts), [config.ts](../../examples/first-harness/config.ts) and [tsconfig.json](../../examples/first-harness/tsconfig.json). The module's default export is a `Harness` with `apiVersion: 1`, `id: 'first-harness'` and `run(context)`.

The Harness owns two Profiles and the Handoff Service. The publisher reads the unique reference from its Sandbox and publishes it with a question. `runInput` waits for the exclusive publisher turn. The Harness checks the Service's authenticated publisher, then calls `context.askUser` with that Agent and the Run signal. The writer fetches the same reference with its own permission and uses your answer in `delivery.txt`. The Harness checks the bytes in the Sandbox, requests required export and checks the exported bytes again. The Session manages question identities, answer admission, observation and the final Run report.

`session.ts` handles terminal input and passes the reply to `respond`. Compile the files and run the same definition in process, over RPC, or in one-shot foreground mode.

```bash
./node_modules/.bin/tsc
mkdir -p input
node dist/session.js ./input 'Prepare a release handoff.'
node dist/session.js --rpc ./input 'Prepare a release handoff.'
MURM_FIRST_CHANNEL=beta-east murm --harness ./dist/harness.js --cwd ./input --prompt 'Prepare a release handoff.'
```

Use a separate input directory so capture excludes the example's dependencies and Run output. Both clients prompt for a channel such as `beta-east`. The one-shot foreground takes its channel from `MURM_FIRST_CHANNEL` and prints a final JSON record. JSONL clients may run explicit foreground with `--interaction questions` and answer by `questionId`. A successful run has `outcome: "completed"`, `acceptance.status: "verified"`, `export.status: "complete"` and `cleanup.status: "complete"`. Read the file named by the acceptance receipt, check its `channel=` line and compare its SHA‑256. Use the same Run's `reportPath` for the complete Host report.

### Published v0.2.0 example

For the released archive, save these five versioned files to the project directory. All application imports use the package root.

- [main.ts](../../examples/first-harness/main.ts) runs the two turns, prints the question, verifies the bytes, and reports cleanup.
- [handoff.ts](../../examples/first-harness/handoff.ts) registers `publish` and `take`. `take` returns the reference and question in one operation. The writer pipes `swarm service invoke handoff take --request-id take-release` into a formatter that writes two newline-terminated lines.
- [turn.ts](../../examples/first-harness/turn.ts) is the version 1 reusable turn helper.
- [config.ts](../../examples/first-harness/config.ts) selects the Sandbox and model settings for the installed archive.
- [tsconfig.json](../../examples/first-harness/tsconfig.json) compiles the project.

```bash
./node_modules/.bin/tsc
node dist/main.js
```

In the v0.2.0 example, wait for the publisher’s question. Enter a channel such as `beta-east`. Success requires a verified `delivery.txt`, a SHA-256 receipt, `business.ok: true`, and `cleanup.status: "complete"`. The handoff receipt names both Agent IDs and Service request IDs. Verify the exported file with `sha256sum` and read its `channel=` line. Each run creates a new reference, so use the file path from that run's summary.

## 4. Diagnose and extend

- Inside an Agent, `swarm service invoke handoff publish --help` shows the authorized schema. With the candidate CLI it also lists required fields and shows example calls when a valid example can be derived. Try a number for the reference and then correct it to the 12-character reference. `SERVICE_INPUT_INVALID` and `request_outcome: not_executed` mean the adapter did not run. For an unknown outcome, query or retry with the same request ID and payload. Use a new request ID when you correct the payload. See [Services](services.md).
- Keep writes in the writable Agent workspace. For temporary files there, make a temporary subdirectory and remove it before collection. An image can restrict `/tmp`. For a large input pass a short summary and selected files or ranges. Set `MURM_CONTEXT_WINDOW` when you know the upstream's actual per-request limit. The Runtime trace can show provider-reported input and output tokens. Treat missing usage as unknown.
- Use `murm trace --root ./runs` and select the runtime ID. The failure summary gives the role, phase, error code, and available Agent and request IDs. Search `evidence.jsonl` and `service-calls.jsonl` in that run directory for those IDs. A closed or settled Agent does not attest business success. If cleanup is pending or unknown, inspect the close report before discarding the run directory.
- Call the candidate SDK’s `runInput` only on idle Agents whose input your application reserves. Distinct Agents can run in parallel. The helper subscribes before sending, requires accepted admission and a successful settlement, and disposes its waiter on completion, error, abort or timeout. If admission or execution was uncertain, inspect `runtime.get` and close the Runtime or explicitly reconcile the request before reusing that Agent. A cancelled wait does not cancel Worker execution. See [Runtime](runtime.md) for `interrupt` and `close`.

Continue with the [source-based parallel Swarm tutorial](build-your-harness.md) to add parallel research rounds and synthesis.
