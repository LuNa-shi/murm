---
title: PeerMesh
description: Peer-to-peer engineering team coordinating through overlapping Board claims, team chat channels, per-peer serial routers, and Git pull requests.
section: BUILT-IN HARNESSES
order: 8
---

**PeerMesh** *(repository module: `src/environments/agensh`)* models a flat team of peer engineers without a central dispatcher or exclusive locks. Peers develop on personal Git branches, post overlapping soft intentions (`CLAIM`) and progress (`FACT`, `PATCH_SUMMARY`) on a shared Board, negotiate splits in team chat, and open PRs merged by host verification. Source code: [src/environments/agensh](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/agensh).

## 1. Registered Services

Before spawning agents, the host provisions an isolated Gitea repository, Mattermost channel, per-peer credentials, and a local Board process, exposing three scoped Services ([services.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/services.ts)):

| Service | Operations | Guardrails |
| --- | --- | --- |
| **`agensh-context`** | `board_read`, `board_write`, `board_grep`, `board_unfold` | Soft overlapping `CLAIM`, `FACT`, `OBSERVED`, `FAIL`, `PATCH_SUMMARY` rendered per `viewer` |
| **`message`** | `post_message` | Scoped strictly to the run's `channel_id`; Mattermost tokens stay in the host adapter |
| **`gitea`** | `issue_read`, `issue_write`, `pull_request_write` | PRs allowed only from the peer's own `WORK_BRANCH` into `main`; direct merges stay host-only |

Native `git clone / commit / push` inside the sandbox communicates with Gitea via `Profile.network.allow` and per-peer `secretEnv`.

## 2. Runtime primitives used

1. **Per-peer Profiles & `bindings`**: `createAgenshTeam` creates dedicated Profiles (`peer-a`, `peer-b`, …), injects `WORK_BRANCH` / `RUN_REPOSITORY` / `RUN_CHANNEL` via `Profile.env`, restricts outbound network to Gitea, binds external accounts via `spawn({ bindings })`, and delivers each peer's `GITEA_TOKEN` through `secretEnv`.
2. **Required Git archive (`collect`)**: every peer spawns with `collect: { paths: ['.'], includeGit: true, maxBytes: exportLimit, required: true }` so unpushed commits and working trees are always preserved.
3. **Serial `followUp` batching**: each peer has one dedicated router feeding `runInput` (`mode: 'followUp'`), ensuring one batch of external events settles cleanly before the next starts.

## 3. Host control loop

Each peer runs an independent **EventSource → Router** loop ([router.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/router.ts)):

```ts
// 1. Ingest Mattermost mentions and Gitea events into each peer's router
eventSource.onExternalEvent((event) => {
  // Deduplicates by [source, eventId, targetWorker] and ignores self-authored events
  router.ingest(event);
});

// 2. Serial pump attaching a fresh Board snapshot before every turn
async function pump() {
  while (accepting && queue.length) {
    const batch = queue.shift()!;
    const boardContext = await readContext({ signal });
    const payload = `${routerInstruction}\n${JSON.stringify({ ...batch, context: boardContext })}`;

    await runInput(runtime, peerBotId, payload, {
      requestId: batch.requestId,
      timeoutMs: turnTimeoutMs,
    });
  }

  // Optionally schedule an idle nudge when the queue stays quiet
  scheduleIdleNudgeIfConfigured();
}
```

When peers open PRs, [delivery.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/delivery.ts) (`createAgenshDelivery`) checks author, branch, pinned commit SHA, and target `main` before merging. On teardown, routers stop first, `runtime.close()` confirms container export and deletion, and only then are the Board process and temporary credentials torn down.

## Source files

- Team assembly: [src/environments/agensh/team.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/team.ts)
- Serial router & nudges: [src/environments/agensh/router.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/router.ts)
- Service wrappers: [src/environments/agensh/services.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/services.ts)
- Host PR verification: [src/environments/agensh/delivery.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/agensh/delivery.ts)
- Package walkthrough: [examples/agensh-environment/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/agensh-environment/README.md)
