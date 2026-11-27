---
title: PeerMesh
description: Peer-to-peer engineering team coordinating through soft Board claims, Mattermost channels and direct messages, and host-verified Gitea pull requests.
section: HARNESSES
order: 12
---

**PeerMesh** (`src/harnesses/peermesh/`) models a flat team of 2–8 peer engineers with no central dispatcher and no exclusive task locks. Each peer has its own Gitea account, Mattermost account, persistent Pi session, and Git checkout. Peers choose work on personal branches, post advisory `CLAIM` notes and updates on a shared Board, discuss in team chat and DMs, and land PRs into protected `main` through host verification.

## Quick run (CLI)

Configure your Gitea, Mattermost, Board, and model host variables (see [examples/peermesh/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md)), then launch against any project directory:

```bash
cd my-project
murm --harness peermesh --prompt "Fix the parser using the project tests"
```

PeerMesh creates a shared project repository and issue from the directory and prompt, giving each peer its own Sandbox and branch. See the sections below for its Services, per-peer Router, and JSON-line foreground runner.

## 1. Registered Services

[src/harnesses/peermesh/services.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/services.ts) registers three Services per run, binding every peer's container identity to its own provisioned accounts while keeping facility administrator and Service-adapter tokens on the host. Native Git uses a separate per-peer token supplied through `secretEnv`, as described below:

| Service | Operations | Purpose |
| --- | --- | --- |
| **`peermesh-context`** | `board_read`, `board_write`, `board_grep`, `board_unfold` | Shared Board entries typed as `FACT`, `OBSERVED`, `FAIL`, `PATCH_SUMMARY`, or soft `CLAIM` |
| **`message`** | `post_message`, `peer_list`, `send_dm` | Team channel announcements, peer discovery, and private peer-to-peer DMs |
| **`gitea`** | `issue_list`, `issue_read`, `issue_write`, `pull_request_list`, `pull_request_read`, `pull_request_write`, `comment_list`, `comment_write`, `pull_request_merge` | Issue/PR collaboration and host-verified merges into protected `main` |

Peers also push directly to their own Git branches using native `git` over the allowlisted Gitea origin (`Profile.network.allow`) with per-agent `secretEnv.GITEA_TOKEN`. Example commands inside a peer container:

```bash
# Share an advisory claim or finding on the Board
swarm peermesh-context board_write \
  --input claim.json --request-id claim-parser

# Send a direct message to another peer
swarm message send_dm --peer b --message 'I pushed lexer fixes on branch peer-a/lexer.' \
  --request-id dm-b-1

# Request a host-verified merge pinning the exact head commit SHA
swarm gitea pull_request_merge \
  --owner "$RUN_OWNER" --repo "$RUN_REPO" --index 3 --head-sha "$HEAD_SHA" \
  --request-id merge-pr-3
```

When a peer calls `pull_request_merge`, [delivery.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/delivery.ts) verifies the caller, repository, PR number, and pinned `head_sha` before merging into protected `main`. A stale commit SHA is rejected and requires a fresh merge check.

## 2. Per-peer router & mid-turn steering

In [team.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/team.ts) and [router.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/router.ts), each peer gets an independent serial router. Event subscriptions poll Mattermost and Gitea; successful Board writes also enqueue notices. The router delivers these events into the peer's persistent Pi session (`runInput` is the repository's shared single-turn helper from `src/harnesses/shared/run-input.ts`). This excerpt shows the project-run configuration; the complete factory also installs failure fencing and shutdown handlers:

```ts
const router = createPeerMeshRouter({
  workTimeoutMs: durationMs + 120_000,
  turnTimeoutMs: durationMs,
  maxBatches: 256,
  idleNudgeMs: 120_000,
  maxNudges: 8,
  mapping: { agentId: agent.id, workerId: peer.board.workerId },
  // Direct messages and Board updates steer an active turn at Pi's next tool boundary
  steerInput: (text: string, requestId: string) =>
    runtime.send(agent.id, text, {
      mode: 'steer',
      requestId,
      source: 'peermesh-peer-notice',
      steeringMode: 'all',
    }),
  // Full work batches run serially with a fresh Board snapshot prepended
  runInput: (text, wait) =>
    runInput(runtime, agent.id, text, { ...wait, signal }),
  readContext: async ({ signal }) =>
    (await board('GET', `/board/${boardId}/read?viewer=${peer.board.workerId}`, undefined, { signal })).rendered,
});
```

Key properties of this loop:

- **Live notices during work**: when a peer is actively running a batch, incoming DMs (`kind: 'dm'`) and new Board entries (`kind: 'board-entry'`) are delivered mid-turn via `steer` (`steeringMode: 'all'`), so peers react to teammates without waiting for the current batch to finish.
- **Idle nudges**: if a peer sits idle while the project window is still open, the router periodically nudges it to inspect shared Board state and continue useful work.
- **Closeout**: at the project deadline (or on `stop`), the host fences new deliveries, pins the final `main` commit, exports and hashes the `main` archive, then runs `runtime.close()` to collect each peer's Pi session and Git workspace (`collect: { paths: ['.'], includeGit: true, allowMissingGit: true }`). Unresolved merges, failed archives and unconfirmed execution remain explicit pending outcomes.

## 3. Configure and run PeerMesh

Create a project JSON file describing the shared issue and optional seeded files:

```json
{
  "title": "Build a color conversion CLI",
  "body": "Validate hex color input and print decimal RGB channels with usage examples.",
  "durationMs": 3600000,
  "seed": {
    "notes/requirements.txt": "Exit nonzero on invalid input."
  }
}
```

Configure the host environment variables (see [examples/peermesh/config.ts](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/config.ts) and [examples/peermesh/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md)) and launch via the foreground CLI:

```bash
export MURM_PEERMESH_PROJECT_FILE=./project.json
export MURM_PEERMESH_RUN_ID=color-cli-01
export MURM_PEERMESH_IMAGE='ghcr.io/luna-shi/murm-worker:0.2.0'
export MURM_PEERMESH_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_PEERMESH_PEERS=4
# Plus Gitea, Mattermost, and Board MySQL DSN host variables

node dist/scripts/run-harness.js --config dist/examples/peermesh/config.js
```

Once `ready` is emitted, send JSON-line commands over `stdin` to observe or steer peers, or let the team run to its configured `durationMs`:

```json
{"id":"state","operation":"status"}
{"id":"more-a","operation":"input","input":{"recipient":"a","input":"Explain which file supports your claim.","requestId":"more-a-1"}}
{"id":"close","operation":"stop"}
```

Inspect saved reports, merge receipts, and archive digests afterward:

```bash
runtime_id=RUNTIME_ID_FROM_RESULT
node dist/scripts/read-harness-result.js \
  --run-directory "./peermesh-runs/$runtime_id" \
  --runtime-id "$runtime_id"
```

## Source files

- Team assembly & lifecycle: [src/harnesses/peermesh/team.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/team.ts)
- Per-peer router, steering & nudges: [src/harnesses/peermesh/router.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/router.ts)
- Service wrappers (`peermesh-context`, `message`, `gitea`): [src/harnesses/peermesh/services.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/services.ts)
- Host PR merge verification & archive export: [src/harnesses/peermesh/delivery.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/peermesh/delivery.ts)
- Example config & guide: [examples/peermesh/config.ts](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/config.ts) · [examples/peermesh/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/peermesh/README.md)
