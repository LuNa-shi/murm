---
title: Core Concepts
description: Six orthogonal abstractions — Agent, Service, Harness, Runtime, Sandbox, and Run — separating execution infrastructure from coordination logic.
section: GETTING STARTED
order: 2
---

Multi-agent systems get tangled when **infrastructure** (containers, sessions, credentials, logging, cleanup) is mixed with **coordination policy** (who decomposes tasks, who sees what, when to stop).

`murm` splits those two concerns across six orthogonal concepts:

- **Authoring side (what you write)**: author a **`Harness`** by composing **`Agent`** profiles and shared **`Service`** definitions.
- **Execution side (what `murm` manages)**: the **`Runtime`** runs each agent inside an isolated **`Sandbox`** and records every execution as a self-contained **`Run`**.

Each concept below is introduced with a short focused snippet before combining all six at the end.

---

## 1. Agent — an independent execution unit with persistent state

An **Agent** is a single reasoning and coding actor. Each agent runs a native Pi session with just four local tools: `read`, `write`, `edit`, and `bash`.

You configure an agent's role, model, container image, and service permissions through a static **Profile**:

```ts
const readerProfile = {
  prompt: 'Verify facts from shared notes and write your summary to review.md.',
  model: 'default',
  image: 'murm-worker:local',
  writable: true,
  services: { notes: ['get'] }, // read-only access to notes
};
```

Two properties define how agents behave:
1. **Persistent across turns**: finishing a turn transitions the agent back to `idle` without destroying it. Its conversation session and working directory stay intact for follow-up instructions.
2. **Prompts guide behavior; permissions enforce boundaries**: `prompt` describes how the agent should collaborate, while `services` and `writable` are hard-enforced by the Runtime and Bridge.

---

## 2. Service — composable shared coordination capabilities

Because every agent sits in an isolated sandbox with only four local tools, all cross-agent coordination happens through **Services** registered on the host.

A Service consists of two parts:
- A **`manifest`** declaring service ID, operations, descriptions, and JSON Schema contracts;
- An **implementation**, either a local host function (`createInProcessAdapter`) or an external HTTP endpoint (`createHttpJsonAdapter`).

```ts
services.registerService({
  manifest: notesManifest, // declares put / get operations + JSON Schemas
  adapter: createInProcessAdapter({
    invoke({ capability, input, caller }) {
      if (capability.operation === 'get') return records.get(input.key) ?? null;
      // caller.agentId is injected by the Runtime after token auth — unforgeable
      const entry = { key: input.key, text: input.text, author: caller.agentId };
      records.set(input.key, entry);
      return entry;
    },
  }),
});
```

Inside the sandbox, agents discover and invoke every permitted Service through a single uniform `swarm` CLI:

```bash
swarm service list
swarm notes put --input note-request.json --request-id notes-put
swarm notes get --key core-service-boundary --request-id notes-get
```

Because the interface is uniform, task pools (TaskPool), team mailboxes (Subagents), shared boards (PeerMesh), and immutable citation stores (Substrate) all plug into the exact same agent runtime without adding bespoke tools.

---

## 3. Harness — your multi-agent coordination logic

If **Runtime** is the engine that runs agents reliably, **Harness** (stored under `src/harnesses/*` in the repository) is the outer coordination system you build on top of it — such as `Subagents`, `TaskPool`, `PeerMesh`, `Substrate`, or `Lead-Worker`.

The boundary is strict:
- **Runtime is passive**: when an agent finishes a turn and emits `settled`, it rests in `idle`. The Runtime never decides to forward results to another agent or start another round.
- **Harness is active**: it registers Services, spawns roles, reacts to `onEvent` or external chat/Git streams, decides who receives the next `send`, and determines when the mission is complete.

---

## 4. Runtime — the unified control plane

The **Runtime** is the host-side engine that executes lifecycle and delivery commands against sandboxes and Pi processes. Its control surface comes down to four operations:

```ts
// 1. Spawn and inspect agents
const agent = await runtime.spawn({ requestId: 'a1', profile: 'reader', files: seedFiles });

// 2. Deliver input (prefer unified send with explicit mode & wakeIfIdle)
await runtime.send(agent.id, 'Read the shared note and write review.md.', {
  requestId: 'turn-1',
  mode: 'followUp',
});

// 3. Subscribe to live lifecycle events (output, settled, error, exit)
const off = runtime.onEvent((event) => {
  if (event.type === 'settled') console.log(event.agentId, event.outcome);
});

// 4. Stop an agent or close the entire run
await runtime.stop(agent.id);
await runtime.close();
```

> **About `send`, `start`, and `steer`**: in `@murm/core`, `runtime.start` and `runtime.steer` are thin aliases over `runtime.send` (`mode: 'followUp'` and `mode: 'steer'`, respectively). Only `send` exposes the full option set, including conditional non-waking delivery (`wakeIfIdle: false`). Prefer `runtime.send` in new Harnesses.

---

## 5. Sandbox — isolated execution space

Every agent runs inside its own **Sandbox** (currently an OpenSandbox-managed Docker container), giving you three guarantees:

- **Filesystem isolation with opt-in sharing**: by default each agent owns a private directory and can edit files concurrently without conflicts. When a group needs to edit the same repository together, `spawn` can mount a shared runtime workspace (`workspace: { id, mode: 'read-write' }`).
- **Network and secret isolation**: containers can only reach the host's Service Bridge, Model Gateway, and explicit IPv4 allowlists in `Profile.network`. Upstream model API keys never leave the host.
- **Export-before-delete teardown**: stopping an agent halts Pi first, archives its native session and `collect` files to the host, and deletes the container only after exports succeed.

---

## 6. Run — one concrete execution and its durable archive

Every Runtime instance corresponds to one **Run** identified by a unique `runId` (`runtime.id`).

A Run has a private directory under `outputDir/<runtimeId>/` containing the effective config snapshot, ordered event log (`evidence.jsonl`), full Service call log (`service-calls.jsonl`), raw model request/response traces (`model-trace/`), native per-agent session JSONL files, and exported deliverables.

---

## Putting all six together

Combining the fragments above produces a complete multi-agent Harness skeleton:

For source builds with executor selection, `config.backend.executor` selects `pi` or `codex`. Omitting it selects Pi.

```ts
import { createRuntime } from '@murm/core';
import { ServiceRegistry } from '@murm/core/services';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';

// 1. Register shared Services
const services = new ServiceRegistry();
services.registerService({ manifest: notesManifest, adapter: createNotesAdapter() });

// 2. Start a Runtime (begins a Run)
const runtime = await createRuntime({
  backend: createOpenSandboxBackend(config.backend),
  services,
  profiles: { writer: writerProfile, reader: readerProfile },
  maxAgents: 2,
  outputDir: './runs',
});

// 3. Orchestrate collaboration in your Harness
const writer = await runtime.spawn({ requestId: 'spawn-w', profile: 'writer', files: seedFiles });
await runInput(runtime, writer.id, 'Publish your finding with swarm notes put', { requestId: 't1', timeoutMs: 30_000 });

const reader = await runtime.spawn({ requestId: 'spawn-r', profile: 'reader', files: seedFiles });
await runInput(runtime, reader.id, 'Verify via swarm notes get and write review.md', { requestId: 't2', timeoutMs: 30_000 });

// 4. Close and archive sessions, traces, and deliverables
await runtime.close();
```

## Symbol mapping to `@murm/core`

| `murm` concept | `@murm/core` symbol / path | Responsibility |
| --- | --- | --- |
| `Agent` | `AgentInfo`, `AgentEvent` | Independent execution unit inside a sandbox |
| `Harness` | `src/harnesses/` and `examples/` | Host-side coordination logic and policies |
| `Runtime` | `Runtime` (`createRuntime`) | Control plane and lifecycle engine |
| `Run` | `runtime.id` + `outputDir/<runtimeId>/` | Concrete execution and durable trace archive |
| `Sandbox` | OpenSandbox container + `Worker` | Filesystem, network, and process boundary |
| `Service` | `Service` (`ServiceRegistry`) | Composable shared operations and state |

Continue to [System Architecture](../architecture/) to follow the exact trust boundaries and request flows between host and sandboxes.
