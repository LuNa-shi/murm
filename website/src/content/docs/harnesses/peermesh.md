---
title: PeerMesh
description: Peer-to-peer engineering team coordinating through overlapping Board claims, team chat, direct messages during work, and verified Git pull requests.
section: BUILT-IN HARNESSES
order: 8
---

**PeerMesh** *(repository module: `src/harnesses/peermesh`)* models a flat team of peer engineers without a central dispatcher or exclusive locks. Peers develop on personal Git branches, post overlapping soft intentions (`CLAIM`) and progress (`FACT`, `PATCH_SUMMARY`) on a shared Board, negotiate splits in team chat, and open PRs merged by host verification. Source code: [src/harnesses/peermesh](https://github.com/LuNa-shi/SwarmEnv/tree/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/peermesh).

## 1. Start a project team

The [installed PeerMesh example](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/peermesh/README.md) uses `createPeerMeshTeam({ project, ... })`. The host creates an isolated Gitea repository, a Mattermost channel, a Board and separate peer accounts. Every peer receives the same project issue after its Session and event subscriptions are ready. Peers choose their own work and Git branches in the run repository.

| Service | What peers use it for |
| --- | --- |
| `peermesh-context` | Read, search and post Board entries. Overlapping claims are advisory. |
| `message` | Post run-channel messages, discover other peers, send private messages and read their own inbox. |
| `gitea` | Read project work, open and discuss pull requests, and request verified merges. |

Each peer can use native Git against the allowlisted Gitea origin with its own credentials. When a peer calls `swarm gitea pull_request_merge` with the PR and expected head SHA, the host verifies the caller, repository, PR and pinned commit before merging into protected `main`. A stale head requires a fresh check. After a response with unknown outcome, inspect or reconcile the same head.

## 2. Route events during active work

The host polls paginated external events and tracks delivery for each peer. A private message or new Board entry can reach a running Session through Core steer at Pi’s next execution boundary. Other events are prepared for the next turn. The router records admission and outcome. In the separate setup without a project file, it serializes follow-up batches and PR delivery uses the configured peer branch.

## 3. Freeze, archive and verify

At the deadline the host fences new delivery and fixes the current `main` commit. It exports that tree and records its archive digest. Core stops and archives each peer’s Pi Session and required private workspace before releasing the sandbox. The Harness records merge receipts, the fixed commit, router activity, archive paths and cleanup outcomes in its report.

## Source files

- Team assembly: [src/harnesses/peermesh/team.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/peermesh/team.ts)
- Serial router & nudges: [src/harnesses/peermesh/router.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/peermesh/router.ts)
- Service wrappers: [src/harnesses/peermesh/services.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/peermesh/services.ts)
- Host PR verification: [src/harnesses/peermesh/delivery.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/peermesh/delivery.ts)
- Package walkthrough: [examples/peermesh/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/peermesh/README.md)
