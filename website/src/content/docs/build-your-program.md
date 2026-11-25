---
title: Build Your Own Program
description: Assemble custom Services, role Profiles, host control loops, and safe closeout to implement a new multi-agent topology without editing the Runtime.
section: DEVELOPERS
order: 11
---

Building a new multi-agent system in `murm` means writing a plain TypeScript application (**Program**) against `@swarmenv/core` — zero edits to the Runtime, Worker image, or `swarm` CLI.

Every Program combines four building blocks: **shared Services**, **role Profiles**, a **host control loop**, and **resilient closeout**.

## 1. Answer three design questions first

1. **Where does shared state live?** In-memory host `Map`, local SQLite, an external database, or Git + chat servers?
2. **What drives the next turn?** Fixed sequential turns, reactive `onEvent`/mailbox routing, or a periodic reconciliation loop?
3. **What defines completion?** A Service record reaching a target state, a verified Git PR, or a final synthesis from `/root`?

## 2. Define and register a shared Service

A Service pairs a declarative **manifest** (operations + JSON Schemas) with either an **in-process function** (`createInProcessAdapter`) or an **HTTP adapter** (`createHttpJsonAdapter`).

Below is a production-ready local Service pattern demonstrating three key habits: **trusting the Runtime-injected `caller`**, **idempotent retries**, and **calling `assertAuthorized()` right before mutating state**:

```ts
import {
  ServiceRegistry,
  createInProcessAdapter,
  type ServiceManifest,
} from '@swarmenv/core/services';

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
      help: { when: 'Share a finding for downstream agents' },
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 },
          text: { type: 'string', minLength: 1, maxLength: 4096 },
        },
        required: ['key', 'text'],
        additionalProperties: false,
      },
      output_schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          text: { type: 'string' },
          author: { type: 'string' },
        },
        required: ['key', 'text', 'author'],
        additionalProperties: false,
      },
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
        properties: { key: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['key'],
        additionalProperties: false,
      },
      output_schema: { anyOf: [{ type: 'object' }, { type: 'null' }] },
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
          if (existing.author === caller.botId && existing.text === req.text) return existing;
          throw Object.assign(new Error('Key already exists with different content'), { code: 'CONFLICT' });
        }

        // Confirm the caller is still authorized right before committing state
        assertAuthorized();
        const entry = { key: req.key, text: req.text!, author: caller.botId };
        records.set(req.key, entry);
        return entry;
      },
      // Optional: automatically writes service-state.notes.json on runtime.close()
      exportState: () => [...records.values()],
    }),
  });

  return { services, records };
}
```

If your Service runs in a separate process, switch `endpoint` to `{ transport: 'http-json', url: 'http://127.0.0.1:9000' }` and pass `createHttpJsonAdapter({ token, timeoutMs })` — the agent's `swarm` commands stay identical.

## 3. Configure role Profiles and boundaries

Use Profiles to pair role instructions with hard runtime permissions:

```ts
import type { Profile } from '@swarmenv/core';

const profiles: Record<string, Profile> = {
  researcher: {
    prompt: 'Inspect the codebase and publish findings via `swarm notes put`.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['put'] },
  },
  reviewer: {
    prompt: 'Verify findings with `swarm notes get` and write a report to review.md.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['get'] },
    collect: { paths: ['review.md'], includeGit: false, maxBytes: 256 * 1024, required: true },
  },
};
```

Common optional capabilities:
- **Let agents spawn sub-agents**: grant built-in `bot` operations (`{ bot: ['spawn', 'get', 'send', 'stop'] }`), restrict allowed roles with `spawnProfiles`, enable context inheritance via `allowContextFork: true`, or wrap them in a domain Service like [Subagents](../programs/subagents/).
- **Share a repository across agents**: pass `workspace: { id: 'shared-repo', mode: 'read-write' }` in `runtime.spawn()`.
- **Access internal services (such as Gitea)**: whitelist the origin in `Profile.network.allow` and inject per-agent tokens via `spawn({ secretEnv })`.

## 4. Write the host control loop (three standard patterns)

```ts
import { createRuntime } from '@swarmenv/core';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';

const runtime = await createRuntime({
  backend: createPiOpenSandboxBackend(config.backend),
  services,
  profiles,
  maxBots: 4,
  outputDir: './runs',
});
```

### Pattern A: Serial turn helper (fixed pipelines or parallel fixed rounds)

When each agent has a single input source and runs one turn at a time, reuse [runInput](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/shared/run-input.ts):

```ts
const researcher = await runtime.spawn({ requestId: 'spawn-1', profile: 'researcher', files: seedFiles });
await runInput(runtime, researcher.id, 'Audit parser boundaries and publish notes.', {
  requestId: 'turn-1',
  timeoutMs: 60_000,
});
```

### Pattern B: Event + non-waking mailbox (dynamic delegation & real-time messaging)

Listen to `runtime.onEvent`, attempt non-waking `steer` delivery first, and buffer in a per-agent mailbox if the recipient is idle:

```ts
runtime.onEvent((event) => {
  if (event.type !== 'settled') return;
  const payload = JSON.stringify({ from: event.botId, outcome: event.outcome, output: event.output ?? '' });
  void runtime.send(targetId, payload, {
    requestId: `deliver:${event.botId}:${event.seq}`,
    mode: 'steer',
    wakeIfIdle: false,
  }).then((receipt) => {
    if (receipt.status === 'not-accepted') enqueueMailbox(targetId, payload);
  });
});
```

### Pattern C: Reconciliation loop (task pools, leases, and automatic replacement)

Treat your domain database as the source of truth: on `settled`, continue with `mode: 'followUp'` if the business task is still active; run a periodic `setInterval` to renew heartbeats, stop expired workers, and refill idle slots (see [Flat Controller](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/controller.ts)).

## 5. Resilient closeout and verification

Wrap your Program with [runWithReport](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/shared/run-report.ts) so **program errors**, **cleanup errors**, and **report-save errors** are preserved independently without masking one another:

```ts
const report = await runWithReport({
  outputDir: './runs',
  closeTimeoutMs: 30_000,
  createRuntime: () => createRuntime({ ... }),
  async run(runtime) {
    return { delivered: true };
  },
  afterClose: async () => {
    // Tear down external resources only after the Runtime confirms container cleanup
    await closeExternalResources();
  },
});
```

After your first run finishes, inspect `outputDir/<runId>/` (`runtime.json`, `evidence.jsonl`, `service-calls.jsonl`, and `bots/*/artifacts/files/`) to verify three invariants:
1. Agents spawned and overlapped as intended;
2. Downstream agents actually read upstream Service outputs and acted on them;
3. `runtime.json` reports `cleanup: 'complete'` with every required deliverable archived.
