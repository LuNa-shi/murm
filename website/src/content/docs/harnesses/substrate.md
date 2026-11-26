---
title: Substrate
description: Zero-queue, zero-routing parallel research where equal peers publish, search, visit, and cite immutable artifacts in a single SQLite store.
section: BUILT-IN HARNESSES
order: 10
---

**Substrate** (`src/harnesses/substrate/`) shows how small a multi-agent Harness can be: no task queue, no manager, and no private messages. Three to eight equal peers explore concurrently around one **immutable SQLite substrate** — searching and reading each other's publications, then publishing self-contained follow-ups with explicit citations.

## 1. Registered Service (`substrate`)

[src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/main/src/harnesses/substrate/substrate.ts) registers a single in-process SQLite Service (`substrate`) with three operations:

| Operation | Input | Guarantees |
| --- | --- | --- |
| **`search`** | `{ query, limit }` *(limit 1–8)* | Matches query tokens across published content; ranks by **term occurrences desc → incoming citations desc → stable address asc**; logs every query in `substrate_reads` |
| **`visit`** | `{ address }` | Returns full content (up to 8 KiB), verified `author`, `version: 1`, and cited `references`; logs the read in `substrate_reads` |
| **`publish`** | `{ content, references? }` *(up to 16 unique addresses)* | Validates every referenced address inside a `BEGIN IMMEDIATE` transaction, assigns `content:<sha256>`, and deduplicates on `(run_id, author, request_id)` |

Inside a peer container, agents interact through `swarm substrate`:

```bash
swarm substrate search --query 'boundary condition' --limit 5
swarm substrate visit --address content:7f83b165...
swarm substrate publish \
  --content 'Lemma proof for the k >= 5 case...' \
  --references '["content:7f83b165..."]' \
  --request-id peer0-round1-pub
```

Because entries are immutable, correcting or extending an earlier finding means publishing a new artifact that cites the original address — preserving the full citation DAG automatically.

## 2. Host control loop

Substrate uses just four baseline Runtime calls: `createRuntime`, `spawn`, `runInput`, and `stop`. In [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/main/src/harnesses/substrate/index.ts), `Promise.all` drives every peer concurrently across `maxRounds` turns (2–32), with optional `maxConcurrentInputs` throttling and an `onCycle` hook for host-side correction turns:

```ts
// 1. Spawn poolSize (3..8) equal peers and bind their IDs to the substrate Service
for (let index = 0; index < poolSize; index++) {
  const agent = await runtime.spawn({
    requestId: `peer:${index}`,
    profile: 'peer',
    files: { 'question.txt': { data: question, encoding: 'utf8' } },
  });
  substrate.bindPeer(agent.id);
  peers.push({ index, agentId: agent.id, turns: [] });
}

// 2. Drive every peer concurrently in its own persistent session
await Promise.all(
  peers.map(async (peer) => {
    try {
      for (let round = 0; round < maxRounds; round++) {
        const text = `Substrate peer=${peer.index} cycle=${round}\n${question}\n${cyclePrompt}`;
        const receipt = await runInput(runtime, peer.agentId, text, {
          requestId: `${peer.agentId}:cycle:${round}`,
          timeoutMs: turnTimeoutMs,
          signal: workSignal,
        });
        // Optional onCycle hook can inspect substrate.snapshot() and trigger a bounded correction turn
      }
    } finally {
      substrate.retirePeer(peer.agentId);
      await runtime.stop(peer.agentId, { timeoutMs: closeTimeoutMs });
    }
  }),
);
```

When each peer finishes its rounds, `substrate.retirePeer(peer.agentId)` revokes further Service writes for that peer and `runtime.stop()` archives its private files and Pi session while `substrate.sqlite` remains intact for remaining peers.

## 3. Running Substrate & inspecting reuse

```bash
export MURM_SUBSTRATE_RUN=research-01
export MURM_SUBSTRATE_IMAGE=$(docker image inspect murm-worker:local --format '{{.Id}}')
export MURM_SUBSTRATE_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBSTRATE_MODEL_TOKEN='your-bearer-token'

node dist/examples/substrate/main.js dist/examples/substrate/config.js > substrate-result.json

# Read saved receipts without loading model configuration:
node dist/examples/substrate/main.js --result "./substrate-runs/$runtime_id" --runtime-id "$runtime_id"
```

[collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/main/src/harnesses/substrate/collaboration-evidence.ts) audits `substrate_contents`, `substrate_references`, and `substrate_reads` to verify the complete cross-peer reuse chain:
1. Peer A publishes an artifact that persists after Peer A retires;
2. Peer B discovers it via `search` and reads it via `visit`;
3. Peer B publishes a new artifact explicitly citing Peer A's `content:<sha256>` address.

## 4. Formal theorem proving with FATE (Lean 4)

The [Substrate example](https://github.com/LuNa-shi/SwarmEnv/blob/main/examples/substrate/README.md) also ships **FATE-M**, **FATE-H**, and **FATE-X** Lean `4.28.0` benchmark configurations on the exact same host runner. By adding a host-side Lean checking Service (`check_lean`) alongside the substrate Service, you can compare three experimental conditions on the same Runtime:
- `shared`: all peers share one substrate library;
- `private`: each peer has only its own isolated library;
- `none`: no substrate library.

Setting `fate.verifiedCompletion: true` lets a peer finish early only after `check_lean` returns `passed` on the exact proof it submits; otherwise the host sends follow-up turns in the same persistent session until the proof passes or the work deadline expires.

```bash
export MURM_FATE_BENCHMARK=FATE-X
export MURM_FATE_PROJECT=/path/to/fate-x
export MURM_FATE_LEAN=/path/to/lean-4.28.0

node dist/examples/substrate/main.js --fate-prepare "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN" FATE-X
node dist/examples/substrate/main.js dist/examples/substrate/fate-config.js
```

## Source files

- Concurrent round driver: [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/SwarmEnv/blob/main/src/harnesses/substrate/index.ts)
- SQLite `substrate` Service: [src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/SwarmEnv/blob/main/src/harnesses/substrate/substrate.ts)
- Cross-peer reuse auditor: [src/harnesses/substrate/collaboration-evidence.ts](https://github.com/LuNa-shi/SwarmEnv/blob/main/src/harnesses/substrate/collaboration-evidence.ts)
- CLI & FATE Lean configs: [examples/substrate/README.md](https://github.com/LuNa-shi/SwarmEnv/blob/main/examples/substrate/README.md) · [FATE-X #31 run report](https://github.com/LuNa-shi/SwarmEnv/blob/main/docs/experiments/EXP-20261125-20-scalemas-fatex-verified.md)
