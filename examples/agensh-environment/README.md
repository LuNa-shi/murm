# Run Agensh from an installed package

Repository TypeScript sources compile with `npm run build` into `dist/`. `npm pack` builds the distributable JavaScript and declarations before archiving.

The foreground CLI gives every peer the same project issue. The peers start automatically after the Environment prepares their separate Pi Sessions, Git branches, accounts, event subscriptions and shared Board. Peers choose work, send private messages, share findings and request verified PR merges into a protected `main`.

## Prerequisites

- Node.js 22.19 or newer, local Docker OpenSandbox with the [Core isolation prerequisites](../../docs/architecture/16-pi-opensandbox-backend.md), and an immutable SwarmEnv Worker image with Pi 1.3.0.
- A Gitea instance and token with the provisioning permissions described in the [Agensh manual](../../docs/architecture/18-agensh-environment.md#entry-point-and-ownership). Its repository origin must be reachable from the Bot network.
- A Mattermost instance, an existing team ID, and a token authorized to provision users and channels and issue peer tokens.
- The pinned Agensh Board source, its Python dependencies, and a MySQL database initialized with the pinned Board schema. Use a dedicated Board port. The host launches the Board process with the run's peer identities and stops it during cleanup. [Board startup and schema requirements](../../docs/architecture/18-agensh-environment.md#verification-gate)
- A Kimi K3 Responses endpoint and any token it requires.

## Install and configure

Install the verified candidate tarball in a fresh directory outside the source checkout. Replace the archive path with the actual candidate you are using.

```sh
archive=/absolute/path/to/swarmenv-core-0.2.0.tgz
consumer=$(mktemp -d)
cd "$consumer"
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts "$archive"
package=node_modules/@swarmenv/core
node "$package/dist/scripts/run-environment.js" --help
```

Set the environment variables below in the host process. Load secrets from your normal credential store. The sample reads them at configuration time and keeps facility credentials out of Bot inputs and foreground status.

| Variable | Value |
| --- | --- |
| `SWARMENV_AGENSH_PROJECT_FILE` | Path to the trusted project JSON described below. |
| `SWARMENV_AGENSH_RUN_ID` | Fresh lowercase letter/digit/hyphen identifier, up to 32 characters, beginning with a letter or digit. |
| `SWARMENV_AGENSH_IMAGE` | Absolute Worker image ID such as `sha256:<image-id>`. |
| `SWARMENV_AGENSH_MODEL_URL` | Actual Kimi K3 `/v1/responses` URL. |
| `SWARMENV_AGENSH_GITEA_ORIGIN`, `SWARMENV_AGENSH_GITEA_OWNER`, `SWARMENV_AGENSH_GITEA_TOKEN` | API origin reachable by the host and Bots, repository owner, and host provisioning token. |
| `SWARMENV_AGENSH_MATTERMOST_ORIGIN`, `SWARMENV_AGENSH_MATTERMOST_TEAM_ID`, `SWARMENV_AGENSH_MATTERMOST_TOKEN` | Host API origin, existing team identifier, and host provisioning token. |
| `SWARMENV_AGENSH_BOARD_SOURCE`, `SWARMENV_AGENSH_BOARD_MYSQL_DSN` | Pinned Board source directory containing `main.py` and the dedicated database DSN. Relative source paths resolve from the consumer directory. |

Optional settings use the same `SWARMENV_AGENSH_` prefix. `HOST` defaults to `172.17.0.1` and must be the guest-reachable host IPv4 address. `LIFECYCLE_URL` defaults to `http://127.0.0.1:8080/v1` and `ENDPOINT_HOST` to `127.0.0.1`. Set `LIFECYCLE_TOKEN` and `MODEL_TOKEN` for authenticated endpoints. `BOARD_ORIGIN` defaults to `http://127.0.0.1:8660` and `BOARD_PYTHON` to `python3`. `OUTPUT_DIR` defaults to `./agensh-runs`.

Set `SWARMENV_AGENSH_PEERS` to a number from 2 to 8. It defaults to 2. Each peer has one CPU, 1 GiB memory, 128 MiB project disk and 8,192 project inodes. The model gateway allows 2,048 output tokens per request. Project work starts after provisioning and defaults to one hour, with a separate 30-second close wait. A missing required variable produces an `AGENSH_CONFIG_*_REQUIRED` error at startup.

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

For the planned four-peer Pandoc exercise, use the official ProgramBench task `jgm__pandoc.5caad90` and set the goal to reconstruct the reference behavior. Stage the pinned reference binary and public materials in a compatible Worker image. The task goal should identify the paths inside the image and ask for a root `compile.sh` that builds `./executable`. Keep evaluator material on the host. Run with `SWARMENV_AGENSH_PEERS=4` and a project duration of 3,600,000 milliseconds. The task and evaluator configuration are specified in [upstream Agensh's reproduction guide](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/REPRODUCE.md#configure-the-experiment).

## Start, observe and stop

```sh
node "$package/dist/scripts/run-environment.js" --config "$package/dist/examples/agensh-environment/config.js"
```

The CLI emits `ready` after the peers have begun receiving work. Type one JSON line at a time to inspect the run or send a directed follow-up. Use the actual batch ID from an input reply or status when waiting for that peer. Closing stdin leaves a configured project running until its deadline.

```json
{"id":"state","operation":"status"}
{"id":"more-a","operation":"input","input":{"recipient":"a","input":"Explain which repository file supports your conclusion.","requestId":"more-a-1"}}
{"id":"close","operation":"stop"}
```

The host uses each peer's existing router for directed input. A stop command or Ctrl+C begins bounded cleanup. Read the final JSON record for the Runtime ID, report path, per-Bot execution and cleanup outcomes, and outstanding cleanup objects. The provisioner retains the run repository, channel and shared records for review. Private run files and credentials belong in the consumer's local storage.

Use the Runtime ID from the final record to inspect the saved reports, including recorded failures. Substitute the configured output root if you changed `OUTPUT_DIR`.

```sh
runtime_id=RUNTIME_ID_FROM_RESULT
node "$package/dist/scripts/read-environment-result.js" \
  --run-directory "./agensh-runs/$runtime_id" --runtime-id "$runtime_id"
```

The report records the fixed main commit, archive path and SHA-256, verified merge receipts, router activity, each peer's private artifact and cleanup outcomes. An unresolved merge or archive failure leaves delivery pending. Check the saved archive in an independent evaluator and use the repository, Board and message records to verify collaboration. To change collaboration policy, follow the peer, input and router settings in the [Agensh manual](../../docs/architecture/18-agensh-environment.md#core-admission-and-input-order). The [foreground protocol](../../docs/architecture/17-environment-reporting.md#foreground-environment-control) documents all commands and result codes.
