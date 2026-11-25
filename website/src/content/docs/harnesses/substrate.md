---
title: Substrate
description: Zero-queue, zero-routing parallel research where equal peers publish, search, visit, and cite immutable artifacts in a single SQLite store.
section: BUILT-IN HARNESSES
order: 9
---

**Substrate** *(repository module: `src/environments/scalemas`)* shows how minimal a multi-agent Harness can be: no task table, no central manager, and no private messages. Three to eight equal peers research concurrently around one **immutable shared substrate** — searching and reading prior findings, then publishing self-contained follow-ups with explicit citations. Source code: [src/environments/scalemas](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/scalemas).

## 1. Registered Service

Substrate registers a single SQLite-backed **`substrate` Service** ([substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/substrate.ts)) with three operations:

| Operation | Input | Storage & Ordering Guarantees |
| --- | --- | --- |
| **`search`** | `{ query, limit }` (1–8) | Token-matches published artifacts; ranks by **term frequency desc → citation count desc → stable address asc**, logging every query to `substrate_reads` |
| **`visit`** | `{ address }` | Returns full body (up to 8 KiB), verified author, and upstream references; logs read to `substrate_reads` |
| **`publish`** | `{ content, references? }` | Validates every cited address inside a `BEGIN IMMEDIATE` transaction, assigns immutable `content:<sha256>`, and deduplicates on `(run_id, author, request_id)` |

Because published entries are immutable, revising an earlier claim means publishing a new artifact citing the old address — preserving the full knowledge graph automatically.

## 2. Runtime primitives used

Substrate touches only four baseline Runtime calls:
- `createRuntime({ services: substrate.services, maxBots: poolSize, profiles: { peer } })`
- `runtime.spawn({ profile: 'peer', files: { 'question.txt': ... } })`
- `runInput` (`runtime.send(..., { mode: 'followUp' })` + `settled` wait)
- `runtime.stop(peerId)` (retires each peer cleanly once its rounds finish while `substrate.sqlite` remains intact)

## 3. Host control loop

In [src/environments/scalemas/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/index.ts), `Promise.all` drives every peer independently through `maxRounds` turns (with optional `maxConcurrentInputs` throttling and an `onCycle` correction hook):

```ts
// 1. Spawn poolSize equal peers and register their botIds in substrate
for (let i = 0; i < poolSize; i++) {
  const bot = await runtime.spawn({
    requestId: `peer:${i}`,
    profile: 'peer',
    files: { 'question.txt': { encoding: 'utf8', data: question } },
  });
  substrate.bindPeer(bot.id);
  peers.push(bot);
}

// 2. Drive all peers concurrently across maxRounds turns inside persistent sessions
await Promise.all(
  peers.map(async (peer, idx) => {
    try {
      for (let round = 0; round < maxRounds; round++) {
        const prompt = `scaleMAS peer=${idx} cycle=${round}\n${question}\n${cyclePrompt}`;
        await runInput(runtime, peer.id, prompt, {
          requestId: `${peer.id}:cycle:${round}`,
          timeoutMs: turnTimeoutMs,
        });
        // Optional onCycle hook can inspect output and issue a follow-up correction
      }
    } finally {
      substrate.retirePeer(peer.id);
      await runtime.stop(peer.id, { timeoutMs: closeTimeoutMs });
    }
  })
);
```

## 4. Verifying cross-agent knowledge reuse

[collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/collaboration-evidence.ts) audits the SQLite publish table alongside `substrate_reads` to verify the complete causal chain: **(1) an artifact persists after its author stops → (2) another peer runs `search` and `visit` on it → (3) that peer publishes a new artifact explicitly citing that address**.

## Source files

- Concurrent round driver: [src/environments/scalemas/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/index.ts)
- SQLite substrate: [src/environments/scalemas/substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/substrate.ts)
- Collaboration evidence checker: [src/environments/scalemas/collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/scalemas/collaboration-evidence.ts)
- Usage guide: [examples/scalemas-environment/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/scalemas-environment/README.md)
