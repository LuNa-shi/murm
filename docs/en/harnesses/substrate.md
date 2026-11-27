---
title: Substrate
description: Equal peers share immutable publications, with a small generic runner and separate FATE theorem-proving configurations.
section: HARNESSES
order: 10
---

## Run an ordinary project

```sh
cd my-project
murm --harness substrate --prompt "Fix the parser using the project tests"
```

Each peer receives the captured files and uses the prompt as the question in every cycle. FATE remains an explicit benchmark through prepare, run, matrix and rescore flags. The sections below also cover direct SDK embedding and explicit benchmark fixtures.

**Substrate** (`src/harnesses/substrate/`) shows how small a multi-agent Harness can be: no task queue, no manager, and no private messages. Three to eight equal peers explore concurrently around one **immutable SQLite substrate** — searching and reading each other's publications, then publishing self-contained follow-ups with explicit citations.

The example host creates its Runtime through the [SDK](../sdk.md) and uses the generic OpenSandbox backend. The `runSubstrate` runner and SQLite Service are editable repository modules, not package exports. The basic example below and the FATE runner share the publication-based coordination idea, but use different Service schemas and retrieval policies.

## 1. Generic publication Service (`substrate`)

[src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/substrate.ts) registers a single in-process SQLite Service (`substrate`) with three operations:

| Operation | Input | Guarantees |
| --- | --- | --- |
| **`search`** | `{ query, limit }` *(limit 1–8)* | Matches query tokens across published content; ranks by **term occurrences desc → incoming citations desc → stable address asc**; logs every query in `substrate_reads` |
| **`visit`** | `{ address }` | Returns full content (up to 8 KiB), verified `author`, `version: 1`, and cited `references`; logs the read in `substrate_reads` |
| **`publish`** | `{ content, references? }` *(up to 16 unique addresses)* | Validates every referenced address inside a `BEGIN IMMEDIATE` transaction, assigns `content:<sha256>`, and deduplicates on `(run_id, author, request_id)` |

Inside a peer container, agents interact through `swarm substrate`:

```bash
swarm service view substrate --json
swarm substrate search --query 'boundary condition' --limit 5
swarm substrate publish \
  --content 'The k = 5 boundary still needs a separate argument.' \
  --references '[]' --request-id peer0-boundary-note
```

To read and cite an existing publication, use its complete address from a search or publish receipt in `visit --address` and in the next publication's `references` array.

Because entries are immutable, correcting or extending an earlier finding means publishing a new artifact that cites the original address — preserving the full citation DAG automatically.

## 2. Host control loop

The host uses `createRuntime`, `spawn`, input delivery, events and `stop`/`close`. `runInput` is a repository helper for one host-owned input on an idle Agent; it subscribes before sending and checks the settlement. It is not a Runtime method or public package export. In [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/index.ts), `Promise.all` drives every peer concurrently across `maxRounds` turns (2–32), with optional `maxConcurrentInputs` throttling and an `onCycle` hook for host-side correction turns. The following excerpt omits the deadline and error bookkeeping:

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

When each peer finishes its rounds, `substrate.retirePeer(peer.agentId)` rejects further Service calls from that peer. `runtime.stop()` attempts to stop the execution, collect required private files and dispose of the sandbox. The receipt can remain pending if execution or required export is unconfirmed. Published data remains readable by active peers and survives the final database connection close.

## 3. Running Substrate & inspecting reuse

Use a built checkout or `@luna-shi/murm` installation with a compatible Pi Worker image, running OpenSandbox provider, and configured Responses endpoint. See the [example README](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md) for environment options.

```bash
export MURM_SUBSTRATE_RUN=research-01
export MURM_SUBSTRATE_IMAGE=$(docker image inspect murm-worker:local --format '{{.Id}}')
export MURM_SUBSTRATE_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBSTRATE_MODEL_TOKEN='your-bearer-token'

node dist/examples/substrate/main.js dist/examples/substrate/config.js > substrate-result.json

# Read saved receipts without loading model configuration:
runtime_id=RUNTIME_ID_FROM_RESULT
node dist/examples/substrate/main.js --result "./substrate-runs/$runtime_id" --runtime-id "$runtime_id"
```

[collaboration-evidence.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/collaboration-evidence.ts) audits `substrate_contents`, `substrate_references`, and `substrate_reads` to inspect a cross-peer reuse chain:

1. Peer A publishes an artifact that persists after Peer A retires;
2. Peer B discovers it via `search` and reads it via `visit`;
3. Peer B publishes a new artifact explicitly citing Peer A's `content:<sha256>` address.

## 4. Formal theorem proving with FATE (Lean 4)

The same example CLI selects a separate FATE runner when `config.fate` is present. It ships **FATE-M**, **FATE-H** and **FATE-X** configurations for Lean `4.28.0`. The runner exposes a `fate` Service with `search_mathlib`, `check_lean` and `submit`, plus the paper-aligned publication Service when a library is enabled. The three conditions are:
- `shared`: all peers share one substrate library;
- `private`: each peer has only its own isolated library;
- `none`: no substrate library.

The FATE publication implementation is [paper-substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/paper-substrate.ts). It publishes `{ sub_task, artifact, rationale, refs }`, visits an `addresses` array, and ranks search results using normalized BM25 plus citation weight. Those contracts differ from the generic `content` / `references` store above. Use `swarm service view substrate` in the selected run to inspect the actual schema.

Setting `fate.verifiedCompletion: true` requires a `passed` check on the exact proof submitted for early completion. An unfinished reply can trigger another input in the same Session while the work deadline and remaining Service/check allowances permit it. Host checks of the frozen candidate determine correctness; a publication or citation alone does not.

Prepare the pinned benchmark and toolchain listed in the example README before using this launcher:

```bash
export MURM_FATE_BENCHMARK=FATE-X
export MURM_FATE_PROJECT=/path/to/fate-x
export MURM_FATE_LEAN=/path/to/lean-4.28.0

node dist/examples/substrate/main.js --fate-prepare "$MURM_FATE_PROJECT" "$MURM_FATE_LEAN" FATE-X
node dist/examples/substrate/main.js --fate-run dist/examples/substrate/fate-config.js
```

## Source files

- Concurrent round driver: [src/harnesses/substrate/index.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/index.ts)
- SQLite `substrate` Service: [src/harnesses/substrate/substrate.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/substrate.ts)
- Cross-peer reuse auditor: [src/harnesses/substrate/collaboration-evidence.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/substrate/collaboration-evidence.ts)
- CLI & FATE Lean configs: [examples/substrate/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/substrate/README.md)
