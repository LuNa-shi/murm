---
title: Substrate
description: Zero-queue, zero-routing parallel research where equal peers publish, search, visit, and cite immutable artifacts in a single SQLite store.
section: BUILT-IN HARNESSES
order: 9
---

**Substrate** *(repository module: `src/harnesses/substrate`)* shows how minimal a multi-agent Harness can be: no task table, no central manager, and no private messages. Three to eight equal peers research concurrently around one **immutable shared substrate** — searching and reading prior findings, then publishing self-contained follow-ups with explicit citations. Source code: [src/harnesses/substrate](https://github.com/LuNa-shi/SwarmEnv/tree/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/substrate).

## 1. Registered Service

Substrate registers a single SQLite-backed **`substrate` Service** ([substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/substrate/substrate.ts)) with three operations:

| Operation | Input | Storage & Ordering Guarantees |
| --- | --- | --- |
| **`search`** | `{ query, limit }` (1–8) | Token-matches published artifacts; ranks by **term frequency desc → citation count desc → stable address asc**, logging every query to `substrate_reads` |
| **`visit`** | `{ address }` | Returns full body (up to 8 KiB), verified author, and upstream references; logs read to `substrate_reads` |
| **`publish`** | `{ content, references? }` | Validates every cited address inside a `BEGIN IMMEDIATE` transaction, assigns immutable `content:<sha256>`, and deduplicates on `(run_id, author, request_id)` |

Because published entries are immutable, revising an earlier claim means publishing a new artifact citing the old address — preserving the full knowledge graph automatically.

## 2. Runtime primitives used

Substrate touches only four baseline Runtime calls:
- `createRuntime({ services: substrate.services, maxAgents: poolSize, profiles: { peer } })`
- `runtime.spawn({ profile: 'peer', files: { 'question.txt': ... } })`
- `runInput` (`runtime.send(..., { mode: 'followUp' })` + `settled` wait)
- `runtime.stop(peerId)` (retires each peer cleanly once its rounds finish while `substrate.sqlite` remains intact)

## 3. Host control loop

In [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/substrate/index.ts), `Promise.all` drives every peer independently through `maxRounds` turns (with optional `maxConcurrentInputs` throttling and an `onCycle` correction hook):

```ts
// 1. Spawn poolSize equal peers and register their agentIds in substrate
for (let i = 0; i < poolSize; i++) {
  const agent = await runtime.spawn({
    requestId: `peer:${i}`,
    profile: 'peer',
    files: { 'question.txt': { encoding: 'utf8', data: question } },
  });
  substrate.bindPeer(agent.id);
  peers.push(agent);
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

[collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/substrate/collaboration-evidence.ts) audits the SQLite publish table alongside `substrate_reads` to verify the complete causal chain: **(1) an artifact persists after its author stops → (2) another peer runs `search` and `visit` on it → (3) that peer publishes a new artifact explicitly citing that address**.

## FATE example

The [Substrate example](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/substrate/README.md) also includes FATE-M, FATE-H and FATE-X configurations. The host fixes the problem and work window and independently grades frozen Lean candidates. The selected condition exposes a shared library, private libraries, or no library. With `fate.verifiedCompletion: true`, a peer can finish early only after Lean passes on the exact proof it submits. An unfinished reply can be followed up in the same Session within the work window.

The 30-minute verified-completion run on FATE-X problem 31 recorded reuse of another peer’s Lean code. The four frozen candidates all failed independent grading. [Run report](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/docs/experiments/EXP-20261125-20-scalemas-fatex-verified.md)

## Source files

- Concurrent round driver: [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/substrate/index.ts)
- SQLite substrate: [src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/substrate/substrate.ts)
- Collaboration evidence checker: [src/harnesses/substrate/collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/src/harnesses/substrate/collaboration-evidence.ts)
- Usage guide: [examples/substrate/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/f98eb71d0eac61ac99a1b98a9d04ef353f781fec/examples/substrate/README.md)
