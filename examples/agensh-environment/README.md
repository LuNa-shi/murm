# Run Agensh from an installed package

This example uses the package's foreground CLI to run two peers with separate Pi Sessions, Git branches and identities. The Environment provisions a private repository, a Mattermost channel and a Board for each run. Use `kickoff` and `input` to give either peer its own work.

## Prerequisites

- Node.js 22.19 or newer, local Docker OpenSandbox with the [Core isolation prerequisites](../../docs/architecture/16-pi-opensandbox-backend.md), and an immutable SwarmEnv Worker image with Pi 1.3.0.
- A Gitea instance and token with the provisioning permissions described in the [Agensh manual](../../docs/architecture/18-agensh-environment.md#entry-point-and-ownership). Its repository origin must be reachable from the Bot network.
- A Mattermost instance, an existing team ID, and a token authorized to provision users and channels and issue peer tokens.
- The pinned Agensh Board source, its Python dependencies, and a MySQL database initialized with the pinned Board schema. Use a dedicated Board port. The host launches the Board process with the run's two member identities and stops it during cleanup. [Board startup and schema requirements](../../docs/architecture/18-agensh-environment.md#verification-gate)
- A Kimi K3 Responses endpoint and any token it requires.

## Install and configure

Install the verified candidate tarball in a fresh directory outside the source checkout. Replace the archive path with the actual candidate you are using.

```sh
archive=/absolute/path/to/swarmenv-core-0.2.0.tgz
consumer=$(mktemp -d)
cd "$consumer"
npm init -y
npm install --omit=dev --ignore-scripts "$archive"
package=node_modules/@swarmenv/core
node "$package/scripts/run-environment.mjs" --help
```

Set the environment variables below in the host process. Load secrets from your normal credential store. The sample reads them at configuration time and keeps facility credentials out of Bot inputs and foreground status.

| Variable | Value |
| --- | --- |
| `SWARMENV_AGENSH_RUN_ID` | Fresh lowercase letter/digit/hyphen identifier, up to 32 characters, beginning with a letter or digit. |
| `SWARMENV_AGENSH_IMAGE` | Absolute Worker image ID such as `sha256:<image-id>`. |
| `SWARMENV_AGENSH_MODEL_URL` | Actual Kimi K3 `/v1/responses` URL. |
| `SWARMENV_AGENSH_GITEA_ORIGIN`, `SWARMENV_AGENSH_GITEA_OWNER`, `SWARMENV_AGENSH_GITEA_TOKEN` | API origin reachable by the host and Bots, repository owner, and host provisioning token. |
| `SWARMENV_AGENSH_MATTERMOST_ORIGIN`, `SWARMENV_AGENSH_MATTERMOST_TEAM_ID`, `SWARMENV_AGENSH_MATTERMOST_TOKEN` | Host API origin, existing team identifier, and host provisioning token. |
| `SWARMENV_AGENSH_BOARD_SOURCE`, `SWARMENV_AGENSH_BOARD_MYSQL_DSN` | Pinned Board source directory containing `main.py` and the dedicated database DSN. Relative source paths resolve from the consumer directory. |

Optional settings use the same `SWARMENV_AGENSH_` prefix. `HOST` defaults to `172.17.0.1` and must be the guest-reachable host IPv4 address. `LIFECYCLE_URL` defaults to `http://127.0.0.1:8080/v1` and `ENDPOINT_HOST` to `127.0.0.1`. Set `LIFECYCLE_TOKEN` and `MODEL_TOKEN` for authenticated endpoints. `BOARD_ORIGIN` defaults to `http://127.0.0.1:8660` and `BOARD_PYTHON` to `python3`. `OUTPUT_DIR` defaults to `./agensh-runs`.

The sample uses two peers (`a` and `b`), one CPU and 1 GiB memory per peer, 128 MiB and 8,192 inodes per project, and 2,048 output tokens per model request. It sets a 120-second foreground work window and a separate 30-second close wait. A missing required variable prints its `AGENSH_CONFIG_*_REQUIRED` code before starting the Environment.

## Start, observe and stop

```sh
node "$package/scripts/run-environment.mjs" --config "$package/examples/agensh-environment/config.mjs"
```

After the CLI emits `ready`, type one JSON line at a time. Use the actual batch ID from a kickoff or input reply when waiting for that peer. Change the kickoff text and target to supply your own work.

```json
{"id":"start-a","operation":"kickoff","input":{"recipient":"a","input":"Inspect the shared repository and summarize your findings on the Board."}}
{"id":"state","operation":"status"}
{"id":"more-a","operation":"input","input":{"recipient":"a","input":"Explain which repository file supports your conclusion.","requestId":"more-a-1"}}
{"id":"close","operation":"stop"}
```

The host uses each peer's existing router for directed input. A stop command or Ctrl+C begins bounded cleanup. Read the final JSON record for the Runtime ID, report path, per-Bot execution and cleanup outcomes, and outstanding cleanup objects. The provisioner retains the run repository, channel and shared records for review. Private run files and credentials belong in the consumer's local storage.

Use the Runtime ID from the final record to inspect the saved reports, including recorded failures. Substitute the configured output root if you changed `OUTPUT_DIR`.

```sh
runtime_id=RUNTIME_ID_FROM_RESULT
node "$package/scripts/read-environment-result.mjs" \
  --run-directory "./agensh-runs/$runtime_id" --runtime-id "$runtime_id"
```

The report records execution, ownership, cleanup and artifact availability. Verify shared outcomes in the run's actual repository, Board records and messages. To change collaboration policy, follow the peer, input and router settings in the [Agensh manual](../../docs/architecture/18-agensh-environment.md#core-admission-and-input-order). The [foreground protocol](../../docs/architecture/17-environment-reporting.md#foreground-environment-control) documents all commands and result codes.
