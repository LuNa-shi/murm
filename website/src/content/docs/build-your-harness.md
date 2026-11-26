---
title: Build Your Own Harness
description: Step-by-step guide to building a custom multi-agent harness on @murm/core — shared Services, frozen Profiles, host control loops, and resilient closeout.
section: BUILD ON MURM
order: 5
---

Building a new multi-agent system in `murm` means writing a standard TypeScript program on the host against `@murm/core`. You never modify the Runtime, rebuild the worker image, or extend the `swarm` CLI.

Every Harness combines four pieces:
1. **Shared Services** that define how agents exchange state or call domain tools;
2. **Role Profiles** that bind instructions, models, permissions, and export rules;
3. **A host control loop** that decides when to `spawn`, `send`, `interrupt`, and stop;
4. **Resilient closeout** that archives deliverables and keeps business, cleanup, and report errors separate.

## 1. Decide your coordination shape

Answer three questions before writing code:

| Question | Common choices |
| --- | --- |
| **Where does shared state live?** | In-memory host `Map` (Notes, Subagents), local SQLite (Substrate, Lead-Worker), or external HTTP/Git/chat services (PeerMesh, TaskPool) |
| **What drives the next agent turn?** | Fixed serial turns (`runInput`), reactive event + mailbox steering (`wakeIfIdle: false`), or a periodic lease/reconciliation loop |
| **What proves the run succeeded?** | A Service record reaching a target state, verified Git commits/PRs, a passed verifier check, or archived files checked on the host |

## 2. Define and register a shared Service

A Service pairs a declarative **v2 manifest** (`ServiceManifest`) with either an **in-process adapter** (`createInProcessAdapter`) or an **HTTP adapter** (`createHttpJsonAdapter`).

### In-process Service (TypeScript inside your Harness)

This example mirrors [examples/notes/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/notes/main.ts) and demonstrates four core habits: strict draft-07 schemas, trusting the Bridge-injected `caller.agentId`, idempotent retries, and calling `assertAuthorized()` immediately before mutating state:

```ts
import {
  ServiceRegistry,
  createInProcessAdapter,
  type ServiceManifest,
} from '@murm/core/services';

const keyField = { type: 'string', minLength: 1, maxLength: 64 };
const textField = { type: 'string', minLength: 1, maxLength: 4096 };
const noteSchema = {
  type: 'object',
  properties: { key: keyField, text: textField, author: { type: 'string' } },
  required: ['key', 'text', 'author'],
  additionalProperties: false,
};

const notesManifest: ServiceManifest = {
  id: 'notes',
  title: 'Notes',
  purpose: 'Share verified findings between collaborating agents',
  provider_version: '1',
  contract_version: '2',
  endpoint: { transport: 'in-process' },
  capabilities: [
    {
      name: 'put',
      operation: 'put',
      description: 'Publish a note by key',
      side_effect: 'write',
      idempotent: true,
      help: { when: 'Pass a verified finding to downstream agents' },
      input_schema: {
        type: 'object',
        properties: { key: keyField, text: textField },
        required: ['key', 'text'],
        additionalProperties: false,
      },
      output_schema: noteSchema,
      errors: [{ code: 'CONFLICT', retryable: false }],
    },
    {
      name: 'get',
      operation: 'get',
      description: 'Read a published note by key',
      side_effect: 'read',
      idempotent: true,
      help: { when: 'Inspect a finding published by another agent' },
      input_schema: {
        type: 'object',
        properties: { key: keyField },
        required: ['key'],
        additionalProperties: false,
      },
      output_schema: { anyOf: [noteSchema, { type: 'null' }] },
      errors: [],
    },
  ],
};

export function createNotesService() {
  const records = new Map<string, { key: string; text: string; author: string }>();
  const services = new ServiceRegistry();

  services.registerService({
    manifest: notesManifest,
    adapter: createInProcessAdapter({
      invoke({ capability, input, caller, assertAuthorized }) {
        const req = input as { key: string; text?: string };
        const existing = records.get(req.key);
        if (capability.operation === 'get') return existing ?? null;

        if (existing) {
          if (existing.author === caller.agentId && existing.text === req.text) return existing;
          throw Object.assign(new Error('Key already exists with different content'), { code: 'CONFLICT' });
        }

        // Recheck live Bridge authority right before mutating shared state
        assertAuthorized();
        const entry = { key: req.key, text: req.text!, author: caller.agentId };
        records.set(req.key, entry);
        return entry;
      },
      // Optional: Core writes service-state.notes.json automatically on runtime.close()
      exportState: () => [...records.values()],
    }),
  });

  return { services, records };
}
```

### External HTTP Service (`createHttpJsonAdapter`)

When a Service lives in a separate process (for example a Python verifier or existing microservice), set `endpoint: { transport: 'http-json', url: 'http://127.0.0.1:9000' }` and register it with `createHttpJsonAdapter`:

```ts
import { createHttpJsonAdapter } from '@murm/core/services';

services.registerService({
  manifest: verifierManifest, // endpoint: { transport: 'http-json', url: 'http://127.0.0.1:9000' }
  adapter: createHttpJsonAdapter({
    token: process.env.VERIFIER_HOST_TOKEN, // stays on the host; redacted from traces
    timeoutMs: 60_000,
  }),
});
```

Core POSTs `{ input, envelope, caller }` with an `Idempotency-Key: <operation_id>` header to `endpoint.url + (capability.path ?? '/v2/' + capability.operation)` and expects `{ "ok": true, "result": <output> }` (2 MiB response limit, redirects disabled). Agents invoke it with the exact same `swarm <service> <operation>` CLI.

> **CLI flag parsing tip**: `swarm` automatically parses flag values that look like JSON objects or arrays (`--foo '{"a":1}'`). When passing a JSON string that must remain a `string` under your schema (as in `examples/notes`), pass a JSON file via `--input request.json` or `--stdin`.

## 3. Configure frozen role Profiles

Profiles pair role instructions (`prompt`) with hard Runtime permissions (`services`, `writable`, `network`, `collect`):

```ts
import type { Profile } from '@murm/core';

const profiles: Record<string, Profile> = {
  writer: {
    prompt: 'Inspect review-input.json and publish your finding via `swarm notes put`.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['put'] },
  },
  reader: {
    prompt: 'Verify findings with `swarm notes get` and write a concise summary to review.md.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['get'] },
    collect: {
      paths: ['review.md'],
      includeGit: false,
      maxBytes: 256 * 1024,
      required: true,
    },
  },
};
```

Common optional capabilities you can enable per role:
- **Built-in child agent control**: grant `{ agent: ['spawn', 'get', 'send', 'stop'] }`, restrict child roles with `spawnProfiles: ['worker']`, and allow session inheritance with `allowContextFork: true`. (Alternatively, wrap `runtime.spawn`/`send`/`interrupt` inside your own domain Service as [Subagents](../harnesses/subagents/) does.)
- **Shared workspace**: pass `workspace: { id: 'shared-repo', mode: 'read-write' }` (or `'read-only'`) in `runtime.spawn()`.
- **Internal network access (such as Gitea)**: list the concrete non-loopback IPv4 origin in `Profile.network: { allow: ['http://172.17.0.1:3000'] }` and inject per-agent tokens via `spawn({ secretEnv })`.

## 4. Write the host control loop

Assemble the Runtime once per Run:

```ts
import { createRuntime } from '@murm/core';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';

const runtime = await createRuntime({
  backend: createPiOpenSandboxBackend(config.backend),
  services,
  profiles,
  maxAgents: 4,
  outputDir: './runs',
});
```

Pick the control-loop pattern that fits your topology:

### Pattern A: Serial turns with `runInput()`

Best for fixed pipelines, staged lead/worker rounds, or parallel independent peers where each agent has one exclusive input source at a time. Reuse [`runInput`](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/shared/run-input.ts):

```ts
import { runInput } from './run-input.js';

const writer = await runtime.spawn({ requestId: 'spawn-writer', profile: 'writer', files: seedFiles });
const { settled } = await runInput(
  runtime,
  writer.id,
  'Read review-input.json and publish it with `swarm notes put`.',
  { requestId: 'writer-turn-1', timeoutMs: 60_000 },
);
console.log('Writer settled:', settled.outcome);
```

### Pattern B: Event + non-waking mailbox

Best for dynamic delegation, peer chat, or interactive steering where messages can arrive while an agent is either busy or idle. Offer notices with `mode: 'steer', wakeIfIdle: false` and buffer only when the agent is confirmed idle:

```ts
runtime.onEvent((event) => {
  if (event.type !== 'settled' || event.outcome === 'aborted') return;
  const payload = JSON.stringify({
    from: event.agentId,
    outcome: event.outcome,
    output: event.output ?? '',
  });

  void runtime
    .send(parentId, payload, {
      requestId: `child-result:${event.agentId}:${event.seq}`,
      source: event.agentId,
      mode: 'steer',
      wakeIfIdle: false,
    })
    .then((receipt) => {
      if (receipt.status === 'not-accepted') enqueueMailbox(parentId, payload);
      if (receipt.status === 'unknown') recordUnknownDelivery(event, payload);
    })
    .catch(recordDeliveryError);
});
```

### Pattern C: Periodic reconciliation loop

Best for long-running task pools where workers may stall, time out, or finish and need slot replacement:
- Treat your Service database as authoritative state.
- On `settled`, check whether the agent's business execution is still `RUNNING`; if so, send a `mode: 'followUp'` continuation prompt; if `CLOSING`, call `runtime.stop()` and refill the freed Slot.
- Run a bounded `setInterval` heartbeat to renew leases, expire stalled workers, and keep capacity filled.
- Optionally pass `modelAccessPolicy` to `createRuntime()` so the Model Gateway aborts stale-lease requests mid-stream.

See [TaskPool](../harnesses/taskpool/) for the complete production implementation.

## 5. Wrap closeout with `runWithReport()`

Never let a cleanup error overwrite your original business failure (or vice versa). Wrap your Harness in [`runWithReport`](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/shared/run-report.ts), which keeps `result`, `businessFailure`, `cleanup`, `cleanupFailure`, and `reportSaveFailure` as independent fields and atomically writes `outputDir/<runtimeId>/harness-report.json`:

```ts
import { runWithReport } from './run-report.js';

const report = await runWithReport({
  outputDir: './runs',
  closeTimeoutMs: 30_000,
  redact: (value) => scrubConfiguredSecrets(value),
  createRuntime: () =>
    createRuntime({
      backend: createPiOpenSandboxBackend(config.backend),
      services,
      profiles,
      maxAgents: 2,
      outputDir: './runs',
    }),
  async run(runtime) {
    // Spawn agents, run your control loop, and verify deliverables
    const stopped = await runtime.stop(reader.id, { timeoutMs: 30_000 });
    return { readerId: reader.id, artifacts: stopped.artifacts };
  },
  async afterClose(closeReceipt) {
    // Only close external DBs or revoke external tokens after Core cleanup is complete
    if (closeReceipt.cleanup === 'complete') {
      await closeExternalResources();
    }
  },
});
```

## 6. Verify your first Run

After your first run exits, inspect `outputDir/<runtimeId>/` to verify four invariants:

1. **`runtime.json`**: `status === 'closed'` and `cleanup === 'complete'` with zero pending cleanup objects.
2. **`evidence.jsonl`**: expected spawn order, input receipts, and `settled` events with zero `subscriber-error` rows.
3. **`service-calls.jsonl`**: downstream agents actually invoked your Services with valid schemas and received upstream outputs.
4. **`<agentId>/artifacts/files/` & `<agentId>/session/`**: declared deliverables match your acceptance checks and full Pi session transcripts are archived.

Next, explore how the five built-in topologies apply these exact patterns in [Five Topologies Overview](../harnesses/).
