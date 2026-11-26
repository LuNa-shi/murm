---
title: How murm Works
description: The mental model behind murm — how a Harness steers a Runtime arena of isolated Sandboxes, customizable Shared Services, an external Host Gateway, and durable Run traces.
section: GET STARTED
order: 2
---

Multi-agent systems become hard to reason about when **coordination logic** (who picks up work, how agents share context, when to interrupt, when a run succeeds) is tangled with **infrastructure** (containers, sessions, API keys, network rules, trace collection, cleanup).

`murm` draws a clean line between the two: **you write the coordination; `murm` runs the infrastructure.**

## The mental model

Picture a swarm running on `murm` as five cooperating layers:

<div class="doc-diagram" role="region" aria-label="Five cooperating layers of murm">
  <div class="dd-row-2-arrow">
    <div class="dd-box dd-yellow">
      <div class="dd-box-title">HARNESS</div>
      <ul class="dd-list">
        <li>Your control loop &amp; rules</li>
        <li>Role Profiles &amp; stop policy</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄── spawn · send · onEvent ──►</div>
    <div class="dd-box dd-indigo">
      <div class="dd-box-title">RUNTIME (the arena)</div>
      <div class="dd-sandbox-stack">
        <div class="dd-sandbox-pill"><strong>SANDBOX A</strong> · Agent (Pi + workspace)</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX B</strong> · Agent (Pi + workspace)</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX C</strong> · Agent (Pi + workspace)</div>
      </div>
    </div>
  </div>

  <div class="dd-pipes">
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>registers</strong><span>v2 manifests &amp; adapters</span></span>
    </div>
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>swarm CLI · /v1/responses</strong><span>authenticated over host bridge</span></span>
    </div>
  </div>

  <div class="dd-row-3">
    <div class="dd-box dd-service">
      <div class="dd-box-title">SHARED SERVICES</div>
      <ul class="dd-list">
        <li>Customizable domain state</li>
        <li>Boards, pools, Git &amp; verifiers</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄──</div>
    <div class="dd-box dd-teal">
      <div class="dd-box-title">HOST GATEWAY</div>
      <ul class="dd-list">
        <li>Service Bridge (auth + schema)</li>
        <li>Model Gateway (host API keys)</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">──►</div>
    <div class="dd-box dd-amber">
      <div class="dd-box-title">RUN TRACES</div>
      <ul class="dd-list">
        <li>outputDir/&lt;runtimeId&gt;/</li>
        <li>Sessions, calls &amp; artifacts</li>
      </ul>
    </div>
  </div>
</div>

1. **You write the Harness**: a plain TypeScript program on the host that defines agent roles (**Profiles**), registers shared **Services**, and runs the control loop (`spawn`, `send`, `interrupt`, `onEvent`, `stop`, `close`).
2. **Runtime is the arena**: it allocates isolated **Sandboxes** up to `maxAgents`, keeps each **Agent** alive across turns, and enforces permissions and capacity limits.
3. **Every Agent runs inside a Sandbox**: one Docker container with a persistent **Pi** session, its own working directory (or an explicit shared mount), and just four local tools (`read`, `write`, `edit`, `bash`).
4. **Coordination flows through customized Services**: agents never talk directly across containers. They call your host-registered Services through the uniform `swarm` CLI over the **Host Gateway** (Service Bridge + Model Gateway), while upstream API keys never leave the host.
5. **Every Run streams full traces**: lifecycle events, Service calls, raw model requests/responses, native Pi sessions, and exported artifacts land in a self-contained directory under `outputDir/<runtimeId>/`.

---

## 1. Harness — your control loop and rules

The **Runtime is intentionally passive**. When an agent finishes a turn and emits a `settled` event, it sits in `idle` with its session and files intact. The Runtime never decides to forward a result to another agent, trigger a follow-up, or end the mission.

Your **Harness** owns all active policy:
- Which agent roles exist and which Service operations each role may call.
- When to spawn agents, when to fork a parent's conversation, and when to mount a shared workspace.
- How to react to `settled` events, chat messages, or task claims — and when to `interrupt` or `stop` an agent.
- What constitutes business success (a verified Git commit, a passed Lean check, a written artifact, or a root synthesis).

In the repository, the five built-in topologies live as ordinary Harnesses under `src/harnesses/` and `examples/`.

---

## 2. Agent & Profile — persistent actors with hard boundaries

Each **Agent** is a persistent Pi `1.3.0` coding session running inside a container. Two properties shape how you design roles:

1. **Sessions survive across turns**: finishing a turn transitions the agent from `running` back to `idle` without destroying the container or conversation history. Your Harness can send follow-up instructions into the same session and working directory.
2. **Prompts guide; Profiles enforce**: `Profile.prompt` tells the model how to collaborate, while `Profile.services`, `Profile.writable`, `Profile.network`, and `Profile.spawnProfiles` are hard-enforced by the Runtime and Bridge.

```ts
import type { Profile } from '@murm/core';

const profiles: Record<string, Profile> = {
  writer: {
    prompt: 'Inspect review-input.json and publish the finding with `swarm notes put`.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['put'] },
  },
  reader: {
    prompt: 'Read the published note via `swarm notes get` and write review.md.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['get'] },
    collect: {
      paths: ['review.md', 'followup.md'],
      includeGit: false,
      maxBytes: 64 * 1024,
      required: true,
    },
  },
};
```

At `createRuntime()` time, Profiles are deep-copied and frozen. Unknown model aliases or unregistered Service operations fail immediately before any sandbox is created.

---

## 3. Customized Services — how agents coordinate

Because containers only expose four local tools (`read`, `write`, `edit`, `bash`), **every cross-agent interaction goes through a Service** that your Harness designs and registers.

Want a shared key-value store? A hierarchical mailbox? A transactional SQLite task board? A Lean proof verifier? A Git pull-request gate? You define a v2 `ServiceManifest` (operations + strict JSON Schema draft-07 contracts) and attach either:
- **`createInProcessAdapter`**: a TypeScript handler running directly in your host Harness process; or
- **`createHttpJsonAdapter`**: a host-authenticated HTTP JSON proxy to an external server.

```ts
import { ServiceRegistry, createInProcessAdapter } from '@murm/core/services';

const records = new Map<string, { key: string; text: string; author: string }>();
const services = new ServiceRegistry();

services.registerService({
  manifest: notesManifest, // declares put & get operations + JSON Schemas
  adapter: createInProcessAdapter({
    invoke({ capability, input, caller, assertAuthorized }) {
      const req = input as { key: string; text?: string };
      const existing = records.get(req.key);
      if (capability.operation === 'get') return existing ?? null;

      if (existing) {
        if (existing.author === caller.agentId && existing.text === req.text) return existing;
        throw Object.assign(new Error('Key already exists with different content'), { code: 'CONFLICT' });
      }

      // Confirm caller authority right before mutating shared state
      assertAuthorized();
      const entry = { key: req.key, text: req.text!, author: caller.agentId };
      records.set(req.key, entry);
      return entry;
    },
  }),
});
```

Inside the sandbox, agents discover and call permitted Services through the single uniform `swarm` CLI — no custom Pi extensions or per-harness tool definitions needed:

```bash
swarm service list
swarm service view notes
swarm notes put --input note-request.json --request-id notes-put
swarm notes get --key core-service-boundary --request-id notes-get
```

Crucially, `caller` (`{ runtimeId, agentId, profile, binding? }`) is reconstructed by the host Service Bridge from the agent's container-scoped bearer token. An agent cannot spoof another agent's identity.

---

## 4. Runtime & Sandbox — the isolated execution arena

The **Runtime** manages container allocation, slot capacity (`maxAgents`), input delivery, event streaming, file controls, and teardown. Its core control surface is compact:

```ts
// 1. Spawn an agent (starts idle — no model call fires automatically)
const reader = await runtime.spawn({
  requestId: 'spawn-reader',
  profile: 'reader',
  files: { 'review-input.json': { encoding: 'utf8', data: serializedFact } },
});

// 2. Subscribe to live lifecycle events (output, settled, error, exit)
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'settled') {
    console.log(event.agentId, event.outcome, event.output);
  }
});

// 3. Deliver work or mid-flight notices with unified send()
await runtime.send(reader.id, 'Fetch the shared note and write review.md.', {
  requestId: 'reader-turn-1',
  mode: 'followUp',
});

// 4. Stop an agent (archives session & collect files before deleting sandbox)
const stopReceipt = await runtime.stop(reader.id, { timeoutMs: 30_000 });

// 5. Close the entire run and flush all traces
unsubscribe();
await runtime.close({ timeoutMs: 30_000 });
```

> **Note on `send`, `start`, and `steer`**: `runtime.start()` and `runtime.steer()` are convenience aliases over `runtime.send()` (`mode: 'followUp'` and `mode: 'steer'`, respectively, both with `wakeIfIdle: true`). Prefer `runtime.send()` in new Harnesses — it is the only form that exposes conditional non-waking delivery (`wakeIfIdle: false`).

Every Sandbox enforces three defaults out of the box:
- **Private filesystems with explicit sharing**: each agent gets its own bounded disk quota (`bytes` and `inodes`). Mount a shared workspace only when you explicitly pass `workspace: { id, mode: 'read-write' | 'read-only' }`.
- **Default-deny network**: containers can reach only the host Service Bridge, host Model Gateway, and explicit IPv4 origins listed in `Profile.network.allow`.
- **Archive-before-delete cleanup**: `stop()` halts Pi first, exports the native session and any `collect` files, and removes the container only after required exports succeed.

---

## 5. Run — durable records for debugging and evaluation

Every `createRuntime()` call generates a fresh `runtime.id` and creates `outputDir/<runtimeId>/`.

Without adding any logging code to your Harness, a Run records:
- `runtime.json` — effective configuration, prompt digests, stop receipts, and cleanup status.
- `evidence.jsonl` — ordered host timeline of spawns, inputs, receipts, events, and errors.
- `service-calls.jsonl` — every authenticated Service call with full inputs, outputs, and errors.
- `model-trace/<attemptId>/` — received/forwarded JSON payloads, raw upstream SSE stream, and usage/status metadata.
- `<agentId>/session/` and `<agentId>/artifacts/` — native Pi JSONL conversation logs and exported deliverables.

---

## Putting it all together

Combine the pieces above into a complete minimal Harness (adapted directly from [examples/notes/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/notes/main.ts)):

For source builds with executor selection, `config.backend.executor` selects `pi` or `codex`. Omitting it selects Pi.

```ts
import { createRuntime } from '@murm/core';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';
import { runInput } from './run-input.js';

const { services, records } = createNotesService();

const runtime = await createRuntime({
  backend: createOpenSandboxBackend(config.backend),
  services,
  profiles,
  maxAgents: 2,
  outputDir: './notes-runs',
});

try {
  const writer = await runtime.spawn({
    requestId: 'writer',
    profile: 'writer',
    files: seedFiles,
  });
  await runInput(runtime, writer.id, 'Publish the seeded note with swarm notes put.', {
    requestId: 'writer-turn-1',
    timeoutMs: 30_000,
  });

  const reader = await runtime.spawn({
    requestId: 'reader',
    profile: 'reader',
    files: readerSeedFiles,
  });
  await runInput(runtime, reader.id, 'Read the note via swarm notes get and write review.md.', {
    requestId: 'reader-turn-1',
    timeoutMs: 30_000,
  });
  await runInput(runtime, reader.id, 'Copy review.md unchanged to followup.md.', {
    requestId: 'reader-turn-2',
    timeoutMs: 30_000,
  });
} finally {
  await runtime.close({ timeoutMs: 30_000 });
}
```

## Concept-to-code map

| Concept | `@murm/core` symbol / location | Responsibility |
| --- | --- | --- |
| **Harness** | Your code (`src/harnesses/`, `examples/`) | Control loop, role Profiles, Service definitions, acceptance checks |
| **Runtime** | `createRuntime`, `Runtime` | Host control plane for lifecycle, delivery, file controls, and teardown |
| **Agent** | `AgentInfo`, `AgentStatus`, `AgentEvent` | Persistent Pi session inside a container with a bounded working directory |
| **Sandbox** | `createPiOpenSandboxBackend` + Worker | Docker container boundary for filesystem, network, and process isolation |
| **Service** | `ServiceRegistry`, `ServiceManifest`, `ServiceAdapter` | Schema-validated shared operations invoked through `swarm` CLI |
| **Run** | `runtime.id` + `outputDir/<runtimeId>/` | Concrete execution and complete trace/artifact archive |

Continue to [System Architecture](../architecture/) to follow the exact trust boundaries and request flows between the host and sandboxes.
