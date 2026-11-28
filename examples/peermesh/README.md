# PeerMesh Harness

PeerMesh gives independent peers a shared Git project, Board and chat channel.
Peers choose work, maintain their own branches, exchange findings and request
verified merges. The host creates per-run identities and routes Board/chat
updates through the public SDK. Its Gitea, Mattermost and MySQL facilities are
application dependencies, not default murm services.

## Prepare dependencies

Prepare the following facilities before starting the project:

- OpenSandbox and a compatible Worker image.
- A Gitea instance and host token allowed to provision the run repository and
  restricted accounts. Its origin must be reachable from the Agent network.
- A Mattermost instance, existing team ID and host token allowed to provision
  users/channels and peer credentials.
- The pinned upstream Agensh Board source, its Python dependencies and MySQL
  schema. The host starts a dedicated Board process and stops that process during
  cleanup. It does not install or own the MySQL server.

The current Git Profiles request an enforced endpoint allowlist. The default
configuration therefore retains strict local Docker isolation, including a
128 MiB/8,192-inode project quota. The generic API Provider does not support that
allowlist. Follow [the strict-host prerequisites](../../docs/architecture/16-pi-opensandbox-backend.md)
or supply a compatible provider through a trusted configuration.

Check the Gitea `/api/v1/version` and Mattermost `/api/v4/system/ping` endpoints
at the configured origins. Supply the Board directory from [Agensh commit
2dae4e14](https://github.com/microsoft/Agensh/tree/2dae4e14a653da48549fd9aa093f834841475d6c)
and set `MURM_PEERMESH_BOARD_SOURCE` to its absolute `board-service/` path.
Install that directory's `requirements.txt` for the Python executable you
select. Apply `mini-router/sql/03_board_schema.sql` to the Board database and
verify the configured DSN before launch. Startup checks that the
per-run Board is readable; the Board stores its state in MySQL. PeerMesh
connects to existing Gitea, Mattermost and MySQL installations. It closes the
Board process it creates, while the shared services and persisted data remain.

## Configure and run

Set the common `MURM_MODEL_URL`, `MURM_MODEL_TOKEN`, `MURM_MODEL_PROVIDER` and
`MURM_MODEL_ID` variables, plus `MURM_EXECUTOR` if using Codex. Pi and the default
OpenAI model are selected when omitted; Codex requires an explicit model ID.
`MURM_PEERMESH_MODEL_*` and `MURM_PEERMESH_EXECUTOR` remain scoped fallbacks.
Worker and Lifecycle settings follow the same common configuration as Quickstart.

| Required example variable | Purpose |
| --- | --- |
| `MURM_PEERMESH_GITEA_ORIGIN` | Gitea origin reachable by the host and Agents. |
| `MURM_PEERMESH_GITEA_OWNER` | Owner of the per-run repository. |
| `MURM_PEERMESH_GITEA_TOKEN` | Host provisioning token. |
| `MURM_PEERMESH_MATTERMOST_ORIGIN` | Mattermost API origin. |
| `MURM_PEERMESH_MATTERMOST_TEAM_ID` | Existing team identifier. |
| `MURM_PEERMESH_MATTERMOST_TOKEN` | Host provisioning token. |
| `MURM_PEERMESH_BOARD_SOURCE` | Pinned Board directory containing `main.py`. |
| `MURM_PEERMESH_BOARD_MYSQL_DSN` | Connection to the initialized Board database. |

Optional `MURM_PEERMESH_BOARD_ORIGIN` defaults to `http://127.0.0.1:8660` and
`MURM_PEERMESH_BOARD_PYTHON` to `python3`. The Board port must be free.
`MURM_PEERMESH_PEERS` selects 2–8 peers (default 2), and
`MURM_PEERMESH_DURATION_MS` selects the work window (default 120,000 ms).
The host has a separate 30-second close wait. Supply a trusted JavaScript module
with `--config` for further changes to limits, providers and model configuration.

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
  --prompt 'Coordinate through the Board, implement the change and verify it in Git'
```

With the CLI installed, run the equivalent command in your project:

```sh
murm --harness peermesh --prompt 'Implement the requested change and verify it'
```

The project directory seeds Git and each Agent's files. The prompt becomes the
shared issue. This entrypoint creates its run identifier; it requires neither
`MURM_PEERMESH_PROJECT_FILE` nor a workload JSON file. Outputs are stored outside
the input tree by default. Select `--mode rpc` for the common host interaction
protocol described in [CLI/RPC](../../docs/en/reference/cli.md).

## Ownership and results

The example owns its router, Board launcher, Service adapters, per-run accounts
and their cleanup. Gitea, Mattermost and MySQL remain available after the run.
The repository, channel and shared records are retained for inspection. Host
credentials stay out of Agent input; Agents receive only scoped identities.

The final result contains the run report and delivery/cleanup status. Delivery
records a fixed main commit, archive path and digest. Unresolved merges or export
failures remain pending. A completed protocol does not certify arbitrary project
correctness: inspect and independently test the exported project.

The [mechanism guide](../../docs/en/harnesses/peermesh.md) explains peer behavior;
the [implementation manual](../../docs/architecture/18-peermesh-harness.md)
describes provisioning, routing, delivery and the pinned Board schema.

## Older foreground fixture and benchmarks

`config.ts` is retained for `scripts/run-harness.ts` and its fixed project fixture.
That explicit interface reads `MURM_PEERMESH_RUN_ID` and
`MURM_PEERMESH_PROJECT_FILE`, whose JSON contains `title`, `body`, optional `seed`
and `durationMs`; its historical duration default is one hour. These settings
are not inputs to the project command above.

The four-peer Pandoc exercise is a separate ProgramBench workload. Use the
upstream [pinned reproduction guide](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/REPRODUCE.md#configure-the-experiment)
and freeze the task/image/model/budget before that benchmark. The ordinary
example does not require a ProgramBench image or claim its published results.
