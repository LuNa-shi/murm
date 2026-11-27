# Run PeerMesh from an installed package

## Run from your project

```sh
cd my-project
murm --harness peermesh --prompt "Inspect this project and explain how to verify it"
```

PeerMesh creates a shared project repository and issue from the directory and prompt. Peers work in separate Sandboxes. Configure Gitea, Mattermost and the Board before launching.

After installing the built tarball, configure the model route, compatible Worker image and other runtime resources described below. A JavaScript config can also be supplied with `--config`. The common command saves its outputs outside the input directory by default.


This example composes Core with a peer router, Board, chat and Git Services. The team and router factories are repository modules; they are not extra `@luna-shi/murm` package exports. See the [mechanism guide](../../docs/en/harnesses/peermesh.md) and [Runtime guide](../../docs/en/runtime.md) to adapt the policy.

TypeScript sources compile with `npm run build` into `dist/`. The package is currently private and consumed as a checkout-built tarball; `npm pack` builds the JavaScript and declarations before archiving.

The foreground CLI gives every peer the same project issue. The peers start automatically after the Harness prepares their separate Pi Sessions, accounts, event subscriptions and shared Board. Peers choose work and their own Git branches, send private messages, share findings and request verified PR merges into a protected `main`. While a peer is working, its router can deliver a DM or a new Board entry through Core steer at Pi's next execution boundary.

## Prerequisites

- Node.js 22.19 or newer, local Docker OpenSandbox with the [Core isolation prerequisites](../../docs/architecture/16-pi-opensandbox-backend.md), and an immutable murm Worker image with Pi 1.3.0.
- A Gitea instance and token with the provisioning permissions described in the [PeerMesh manual](../../docs/architecture/18-peermesh-harness.md#entry-point-and-ownership). Its repository origin must be reachable from the Agent network.
- A Mattermost instance, an existing team ID, and a token authorized to provision users and channels and issue peer tokens.
- The pinned upstream Agensh Board source, its Python dependencies, and a MySQL database initialized with the pinned Board schema. Use a dedicated Board port. The host launches the Board process with the run's peer identities and stops it during cleanup. [Board startup and schema requirements](../../docs/architecture/18-peermesh-harness.md#verification-gate)
- A Kimi K3 Responses endpoint and any token it requires.

## Install and configure

Build a tarball with `npm pack` after installing dependencies in the checkout, then install it in a fresh directory. Replace the archive path below with the archive you built.

```sh
archive=/absolute/path/to/luna-shi-murm-0.2.0.tgz
consumer=$(mktemp -d)
cd "$consumer"
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts "$archive"
package=node_modules/@luna-shi/murm
node "$package/dist/scripts/run-harness.js" --help
```

Set the environment variables below in the host process. Load secrets from your normal credential store. The sample reads them at configuration time and keeps facility credentials out of Agent inputs and foreground status.

| Variable | Value |
| --- | --- |
| `MURM_PEERMESH_PROJECT_FILE` | Path to the trusted project JSON described below. |
| `MURM_PEERMESH_RUN_ID` | Fresh lowercase letter/digit/hyphen identifier, up to 32 characters, beginning with a letter or digit. |
| `MURM_PEERMESH_IMAGE` | Absolute Worker image ID such as `sha256:<image-id>`. |
| `MURM_PEERMESH_MODEL_URL` | Actual Kimi K3 `/v1/responses` URL. |
| `MURM_PEERMESH_GITEA_ORIGIN`, `MURM_PEERMESH_GITEA_OWNER`, `MURM_PEERMESH_GITEA_TOKEN` | API origin reachable by the host and Agents, repository owner, and host provisioning token. |
| `MURM_PEERMESH_MATTERMOST_ORIGIN`, `MURM_PEERMESH_MATTERMOST_TEAM_ID`, `MURM_PEERMESH_MATTERMOST_TOKEN` | Host API origin, existing team identifier, and host provisioning token. |
| `MURM_PEERMESH_BOARD_SOURCE`, `MURM_PEERMESH_BOARD_MYSQL_DSN` | Pinned Board source directory containing `main.py` and the dedicated database DSN. Relative source paths resolve from the consumer directory. |

Optional settings use the same `MURM_PEERMESH_` prefix. `HOST` defaults to `172.17.0.1` and must be the guest-reachable host IPv4 address. `LIFECYCLE_URL` defaults to `http://127.0.0.1:8080/v1` and `ENDPOINT_HOST` to `127.0.0.1`. Set `LIFECYCLE_TOKEN` and `MODEL_TOKEN` for authenticated endpoints. `BOARD_ORIGIN` defaults to `http://127.0.0.1:8660` and `BOARD_PYTHON` to `python3`. `OUTPUT_DIR` defaults to `./peermesh-runs`.

Set `MURM_PEERMESH_PEERS` to a number from 2 to 8. It defaults to 2. Each peer has one CPU, 1 GiB memory, 128 MiB project disk and 8,192 project inodes. The model gateway allows 2,048 output tokens per request. Project work starts after provisioning and defaults to one hour, with a separate 30-second close wait. The example gives each sandbox enough lifetime from allocation to cover the foreground host window and the close wait, so the host can still export private work at the project deadline. A missing required variable produces an `PEERMESH_CONFIG_*_REQUIRED` error at startup.

The project file supplies the issue title and body. Optional `seed` maps up to 64 normalized repository-relative paths to UTF-8 text (up to 64 KiB per file). Use `durationMs` to choose the work window.

```json
{
  "title": "Build a small color conversion CLI",
  "body": "Produce a program that validates a hexadecimal color and prints its decimal RGB channels. Include a usage example.",
  "durationMs": 3600000,
  "seed": {
    "notes/requirements.txt": "Use nonzero exit status for invalid input."
  }
}
```

For the four-peer Pandoc exercise, use the official ProgramBench task `jgm__pandoc.5caad90`. Use `MURM_PEERMESH_PEERS=4` and a project duration of 3,600,000 milliseconds. Give the peers the goal of reconstructing the behavior of `/opt/programbench/executable` and producing a root `compile.sh` that builds their own `./executable`. Point them to `/opt/programbench/MANUAL.txt`. Keep the official evaluator and its data on the host. See [upstream Agensh's reproduction guide](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/REPRODUCE.md#configure-the-experiment).

Build the matching Worker from the source revision to be evaluated. The following image copies the reference program and the public instructions from the official v6 cleanroom.

```sh
docker build -f deploy/worker/Dockerfile \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  -t murm-peermesh-worker:local .
docker build -t murm-peermesh-pandoc:local - <<'DOCKERFILE'
FROM programbench/jgm_1776_pandoc.5caad90@sha256:02add2de637e9b5f42ecb3600944a15f7a6311107a872f2a95b31eb97c279681 AS cleanroom
FROM murm-peermesh-worker:local
COPY --from=cleanroom --chown=0:0 --chmod=0111 /workspace/executable /opt/programbench/executable
COPY --from=cleanroom --chown=0:0 --chmod=0444 /workspace/README.md /workspace/MANUAL.txt /workspace/COPYING.md /workspace/COPYRIGHT /opt/programbench/
DOCKERFILE
export MURM_PEERMESH_IMAGE=$(docker image inspect murm-peermesh-pandoc:local --format '{{.Id}}')
```

## Start, observe and stop

```sh
node "$package/dist/scripts/run-harness.js" --config "$package/dist/examples/peermesh/config.js"
```

The CLI emits `ready` after the peers have begun receiving work. Type one JSON line at a time to inspect the run or send a directed follow-up. Use the actual batch ID from an input reply or status when waiting for that peer. Closing stdin leaves a configured project running until its deadline.

```json
{"id":"state","operation":"status"}
{"id":"more-a","operation":"input","input":{"recipient":"a","input":"Explain which repository file supports your conclusion.","requestId":"more-a-1"}}
{"id":"close","operation":"stop"}
```

The host uses each peer's existing router for directed input. A stop command or Ctrl+C begins bounded cleanup. Read the final JSON record for the Runtime ID, report path, per-Agent execution and cleanup outcomes, and outstanding cleanup objects. The provisioner retains the run repository, channel and shared records for review. Private run files and credentials belong in the consumer's local storage.

Use the Runtime ID from the final record to inspect the saved reports, including recorded failures. Substitute the configured output root if you changed `OUTPUT_DIR`.

```sh
runtime_id=RUNTIME_ID_FROM_RESULT
node "$package/dist/scripts/read-harness-result.js" \
  --run-directory "./peermesh-runs/$runtime_id" --runtime-id "$runtime_id"
```

The report records the fixed main commit, archive path and SHA-256, verified merge receipts, router activity, each peer's private artifact and cleanup outcomes. An unresolved merge or archive failure leaves delivery pending. Check the saved archive in an independent evaluator and use the repository, Board and message records to verify collaboration. To change collaboration policy, follow the peer, input and router settings in the [PeerMesh manual](../../docs/architecture/18-peermesh-harness.md#core-admission-and-input-order). The [foreground protocol](../../docs/architecture/17-harness-reporting.md#foreground-harness-control) documents all commands and result codes.
