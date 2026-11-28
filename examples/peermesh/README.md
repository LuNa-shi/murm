# PeerMesh Harness

PeerMesh gives independent peers a shared Git project, Board and chat channel.
Peers choose work, maintain their own branches, exchange findings and request
verified merges. The host creates per-run identities and routes Board/chat
updates through the public SDK. Its Gitea, Mattermost and MySQL facilities are
application dependencies, not default murm services.

## Prepare dependencies

Build the checkout with `npm ci --ignore-scripts && npm run build`, or install a
release as described in [Quickstart](../../docs/en/quickstart.md). Prepare:

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

From this directory after the root build:

```sh
node ../../dist/scripts/murm.js --harness peermesh \
  --cwd /absolute/path/to/project \
  --prompt 'Implement the project requirements, coordinate through the Board and verify the result'
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
