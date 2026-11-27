---
title: Build a Swarm Harness
description: Build a real parallel multi-agent Research Swarm — 3 researchers explore concurrently over a shared board, cite each other's findings, and hand off to a synthesizer.
section: CORE BUILDING BLOCKS
order: 9
---

Now let's combine all six building blocks into a **real multi-agent Swarm** — a **Parallel Research & Synthesis Swarm**:

- **3 parallel researchers (`researcher`)**: run in isolated read-only sandboxes, investigate the same target concurrently, and use a shared `FindingsBoard` Service to publish findings, search what peers found, and cite earlier entries.
- **Two collaborative rounds**: round 1 gathers independent findings onto the board; round 2 keeps each Agent's session context alive while peers search each other's entries to fill gaps or challenge claims with explicit citations.
- **1 synthesizer (`synthesizer`)**: read-only access to the board (`board: ['search']`) plus write access to its workspace; reads the team's collective findings and writes `report.md`, exported automatically via `Profile.collect`.

Everything runs locally with **zero external databases or Git containers** once `murm setup` is done. The walkthrough below shows focused, annotated snippets; the complete runnable files are tucked at the end.

## Step 1: Write your shared board as a plain class (`board.ts`)

Start with ordinary TypeScript logic — no framework glue yet:

```ts
// board.ts — plain domain class decoupled from murm internals
export interface Finding {
  id: number;
  authorId: string; // Verified Agent ID injected by Host Gateway
  topic: string;
  summary: string;
  cites: number[]; // References to earlier peer findings
}

export class FindingsBoard {
  private entries: Finding[] = [];

  publish(authorId: string, topic: string, summary: string, cites: number[] = []): Finding {
    // Reject hallucinated citation IDs before mutating state
    for (const refId of cites) {
      if (!this.entries.some((e) => e.id === refId)) {
        throw Object.assign(new Error(`Referenced finding #${refId} does not exist`), {
          code: 'NOT_FOUND',
        });
      }
    }
    const entry: Finding = { id: this.entries.length + 1, authorId, topic, summary, cites };
    this.entries.push(entry);
    return entry;
  }

  search(query = ''): Finding[] {
    const q = query.trim().toLowerCase();
    return q
      ? this.entries.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q))
      : [...this.entries];
  }

  exportState() {
    return { total: this.entries.length, entries: this.entries };
  }
}
```

## Step 2: Wrap the class as a thin `board` Service (`board-service.ts`)

Register a thin manifest + adapter layer that routes `swarm board publish` and `swarm board search` to your class methods:

```ts
// board-service.ts — thin manifest & dispatch wrapper
import { createInProcessAdapter, type JsonValue, type ServiceRegistration } from '@luna-shi/murm';
import { FindingsBoard } from './board.js';

export function createBoardRegistration(board: FindingsBoard): ServiceRegistration {
  return {
    manifest: {
      contract_version: '2',
      id: 'board',
      title: 'Shared Research Board',
      purpose: 'Publish, search, and cite findings across parallel swarm researchers.',
      provider_version: '1.0.0',
      endpoint: { transport: 'in-process' },
      capabilities: [
        {
          name: 'publish',
          operation: 'publish',
          description: 'Publish a verified finding and optionally cite prior finding IDs.',
          side_effect: 'write',
          idempotent: false,
          help: { when: 'After discovering or cross-checking a concrete fact' },
          errors: [{ code: 'NOT_FOUND', retryable: false }],
          input_schema: { /* topic, summary, cites — see full code at bottom */ },
          output_schema: { /* finding object schema */ },
        },
        {
          name: 'search',
          operation: 'search',
          description: 'Search findings on the shared board (empty returns all).',
          side_effect: 'read',
          idempotent: true,
          help: { when: 'Before publishing or during synthesis' },
          errors: [],
          input_schema: { /* optional query string */ },
          output_schema: { /* { entries: [...] } */ },
        },
      ],
    },
    adapter: createInProcessAdapter({
      invoke({ capability, input, caller, assertAuthorized }): JsonValue {
        if (capability.operation === 'publish') {
          assertAuthorized(); // Re-check permission before mutating shared state
          const { topic, summary, cites } = input as {
            topic: string;
            summary: string;
            cites?: number[];
          };
          return board.publish(caller.agentId, topic, summary, cites) as unknown as JsonValue;
        }
        const { query } = input as { query?: string };
        return { entries: board.search(query) } as unknown as JsonValue;
      },
      exportState: () => board.exportState() as unknown as JsonValue,
    }),
  };
}
```

## Step 3: Wire Sandbox, Profiles, and Runtime

Give `researcher` read-only workspace access plus board read/write, and give `synthesizer` board read-only plus workspace write + `collect`:

```ts
// 1. Sandbox config (connects to local or remote OpenSandbox)
const sandbox = createSandbox({
  lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
  apiKey: process.env.MURM_LIFECYCLE_TOKEN,
});

// 2. Register the shared board
const board = new FindingsBoard();
const services = new ServiceRegistry();
services.registerService(createBoardRegistration(board));

// 3. Create Runtime with least-privilege Profiles
const runtime = await createRuntime({
  sandbox,
  executor: process.env.MURM_EXECUTOR === 'codex' ? 'codex' : 'pi',
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: { /* configured from MURM_MODEL_URL & MURM_MODEL_TOKEN — see full code */ },
  services,
  profiles: {
    researcher: {
      prompt: 'Inspect the workspace, search peer findings with `swarm board search`, and publish verified findings via `swarm board publish`.',
      model: 'default',
      image: DEFAULT_WORKER_IMAGE,
      writable: false,
      services: { board: ['publish', 'search'] },
    },
    synthesizer: {
      prompt: 'Read all team findings via `swarm board search` and write a clear `report.md` in the workspace.',
      model: 'default',
      image: DEFAULT_WORKER_IMAGE,
      writable: true,
      services: { board: ['search'] },
      collect: { paths: ['report.md'], includeGit: false, maxBytes: 1_048_576, required: true },
    },
  },
  maxAgents: 4, // 3 researchers + 1 synthesizer
  outputDir: './swarm-runs',
});
```

## Step 4: Run the parallel Swarm control loop

First, create a tiny `runTurn()` helper backed by `runtime.onEvent()` so waiting for parallel Agents stays clean:

```ts
const waiters = new Map<string, (outcome: string) => void>();

// Subscribe before spawning or sending any input
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'settled') {
    const resolve = waiters.get(event.agentId);
    if (resolve) {
      waiters.delete(event.agentId);
      resolve(event.outcome);
    }
  }
});

async function runTurn(agentId: string, text: string, requestId: string): Promise<string> {
  let resolveTurn!: (outcome: string) => void;
  const done = new Promise<string>((r) => { resolveTurn = r; });
  waiters.set(agentId, resolveTurn);

  const receipt = await runtime.send(agentId, text, { requestId, mode: 'followUp' });
  if (receipt.status !== 'accepted') {
    waiters.delete(agentId);
    throw new Error(`Input not accepted: ${receipt.status}`);
  }
  return done;
}
```

Now drive 3 researchers concurrently across two rounds, then synthesize and close cleanly:

```ts
// 1. Spawn 3 researchers concurrently with the same read-only seed files
const peers = await Promise.all(
  [1, 2, 3].map((i) =>
    runtime.spawn({ requestId: `spawn-r${i}`, profile: 'researcher', files: seedFiles }),
  ),
);

// 2. Round 1: independent parallel exploration
await Promise.all(
  peers.map((peer, i) =>
    runTurn(
      peer.id,
      `Goal: ${goal}\nYou are researcher #${i + 1}. Inspect the files, check the board, and publish your key findings.`,
      `r1-peer-${i + 1}`,
    ),
  ),
);

// 3. Round 2: cross-check teammates' findings in the same persistent sessions
await Promise.all(
  peers.map((peer, i) =>
    runTurn(
      peer.id,
      'Run `swarm board search` to read every teammate entry, then publish a follow-up finding with `cites` covering gaps or counterpoints.',
      `r2-peer-${i + 1}`,
    ),
  ),
);

// 4. Retire researchers and spawn the synthesizer to write report.md
await Promise.all(peers.map((peer) => runtime.stop(peer.id)));
const synth = await runtime.spawn({ requestId: 'spawn-synth', profile: 'synthesizer', files: seedFiles });
await runTurn(synth.id, `Synthesize all ${board.search().length} board findings into report.md.`, 'synth-1');

// 5. Archive traces & exported report.md, then verify cleanup
const receipt = await runtime.close({ timeoutMs: 60_000 });
unsubscribe();
console.log('Findings:', board.search().length, 'Cleanup:', receipt.cleanup);
```

## Step 5: Run it and inspect the Swarm in Trace Viewer

```bash
npx tsx run-swarm.ts
murm trace --root ./swarm-runs --port 8787 --open
```

Trace Viewer shows all 3 parallel researcher swimlanes, their shared `board` calls, the synthesizer turn, and the exported `report.md` side by side.

<details>
<summary>Expand complete runnable source files (strict TypeScript, ready to save and execute)</summary>

Initialize a project and install `@luna-shi/murm`:

```bash
mkdir research-swarm && cd research-swarm
npm init -y && npm pkg set type=module
npm install --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

### Complete file 1: `board.ts`

```ts
export interface Finding {
  id: number;
  authorId: string;
  topic: string;
  summary: string;
  cites: number[];
}

export class FindingsBoard {
  private entries: Finding[] = [];

  publish(authorId: string, topic: string, summary: string, cites: number[] = []): Finding {
    for (const refId of cites) {
      if (!this.entries.some((e) => e.id === refId)) {
        throw Object.assign(new Error(`Referenced finding #${refId} does not exist`), {
          code: 'NOT_FOUND',
        });
      }
    }
    const entry: Finding = { id: this.entries.length + 1, authorId, topic, summary, cites };
    this.entries.push(entry);
    return entry;
  }

  search(query = ''): Finding[] {
    const q = query.trim().toLowerCase();
    return q
      ? this.entries.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q))
      : [...this.entries];
  }

  exportState() {
    return { total: this.entries.length, entries: this.entries };
  }
}
```

### Complete file 2: `board-service.ts`

```ts
import {
  createInProcessAdapter,
  type JsonValue,
  type ServiceRegistration,
} from '@luna-shi/murm';
import { FindingsBoard } from './board.js';

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    authorId: { type: 'string' },
    topic: { type: 'string' },
    summary: { type: 'string' },
    cites: { type: 'array', items: { type: 'integer' } },
  },
  required: ['id', 'authorId', 'topic', 'summary', 'cites'],
  additionalProperties: false,
} as const;

export function createBoardRegistration(board: FindingsBoard): ServiceRegistration {
  return {
    manifest: {
      contract_version: '2',
      id: 'board',
      title: 'Shared Research Board',
      purpose: 'Publish, search, and cite findings across parallel swarm researchers.',
      provider_version: '1.0.0',
      endpoint: { transport: 'in-process' },
      capabilities: [
        {
          name: 'publish',
          operation: 'publish',
          description: 'Publish a verified finding and optionally cite prior finding IDs.',
          side_effect: 'write',
          idempotent: false,
          help: { when: 'After discovering or cross-checking a concrete fact' },
          errors: [{ code: 'NOT_FOUND', retryable: false }],
          input_schema: {
            type: 'object',
            properties: {
              topic: { type: 'string', minLength: 1, maxLength: 120 },
              summary: { type: 'string', minLength: 1, maxLength: 2000 },
              cites: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 8 },
            },
            required: ['topic', 'summary'],
            additionalProperties: false,
          },
          output_schema: FINDING_SCHEMA,
        },
        {
          name: 'search',
          operation: 'search',
          description: 'Search findings published on the shared board (empty returns all).',
          side_effect: 'read',
          idempotent: true,
          help: { when: 'Before publishing or during synthesis' },
          errors: [],
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', maxLength: 120 } },
            additionalProperties: false,
          },
          output_schema: {
            type: 'object',
            properties: { entries: { type: 'array', items: FINDING_SCHEMA } },
            required: ['entries'],
            additionalProperties: false,
          },
        },
      ],
    },
    adapter: createInProcessAdapter({
      invoke({ capability, input, caller, assertAuthorized }): JsonValue {
        if (capability.operation === 'publish') {
          assertAuthorized();
          const { topic, summary, cites } = input as {
            topic: string;
            summary: string;
            cites?: number[];
          };
          return board.publish(caller.agentId, topic, summary, cites) as unknown as JsonValue;
        }
        const { query } = input as { query?: string };
        return { entries: board.search(query) } as unknown as JsonValue;
      },
      exportState: () => board.exportState() as unknown as JsonValue,
    }),
  };
}
```

### Complete file 3: `run-swarm.ts`

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
  createSandbox,
  type FileTree,
} from '@luna-shi/murm';
import { FindingsBoard } from './board.js';
import { createBoardRegistration } from './board-service.js';

const goal =
  process.env.SWARM_GOAL ??
  'Audit the cache implementation for memory leaks and concurrency risks, then recommend fixes.';

const seedFiles: FileTree = {
  'cache.ts': {
    encoding: 'utf8',
    data: [
      'export class SimpleCache<V> {',
      '  private store = new Map<string, { value: V; expiresAt: number }>();',
      '  set(key: string, value: V, ttlMs = 60_000) {',
      '    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });',
      '  }',
      '  get(key: string): V | undefined {',
      '    const hit = this.store.get(key);',
      '    if (!hit || hit.expiresAt < Date.now()) return undefined;',
      '    return hit.value;',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
};

const board = new FindingsBoard();
const services = new ServiceRegistry();
services.registerService(createBoardRegistration(board));

const sandbox = createSandbox({
  lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
  apiKey: process.env.MURM_LIFECYCLE_TOKEN,
});

const modelUrl = process.env.MURM_MODEL_URL;
if (!modelUrl) throw new Error('Set MURM_MODEL_URL before running');

const runtime = await createRuntime({
  sandbox,
  executor: process.env.MURM_EXECUTOR === 'codex' ? 'codex' : 'pi',
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      upstream: {
        url: modelUrl,
        headers: process.env.MURM_MODEL_TOKEN
          ? { authorization: `Bearer ${process.env.MURM_MODEL_TOKEN}` }
          : {},
      },
    },
  },
  services,
  profiles: {
    researcher: {
      prompt:
        'You are part of a parallel research swarm. Inspect the workspace, run `swarm board search` to see peer findings, and call `swarm board publish` with concrete verified insights.',
      model: 'default',
      image: process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
      writable: false,
      services: { board: ['publish', 'search'] },
    },
    synthesizer: {
      prompt:
        'Call `swarm board search` to read every team finding and citation, then write a concise `report.md` in the workspace.',
      model: 'default',
      image: process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
      writable: true,
      services: { board: ['search'] },
      collect: { paths: ['report.md'], includeGit: false, maxBytes: 1_048_576, required: true },
    },
  },
  maxAgents: 4,
  outputDir: './swarm-runs',
});

const waiters = new Map<string, (outcome: string) => void>();
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'settled') {
    const resolve = waiters.get(event.agentId);
    if (resolve) {
      waiters.delete(event.agentId);
      resolve(event.outcome);
    }
  }
});

async function runTurn(agentId: string, text: string, requestId: string): Promise<string> {
  let resolveTurn!: (outcome: string) => void;
  const done = new Promise<string>((r) => { resolveTurn = r; });
  waiters.set(agentId, resolveTurn);

  const receipt = await runtime.send(agentId, text, { requestId, mode: 'followUp' });
  if (receipt.status !== 'accepted') {
    waiters.delete(agentId);
    throw new Error(`Input not accepted for ${agentId}: ${receipt.status}`);
  }
  return done;
}

try {
  const peers = await Promise.all(
    [1, 2, 3].map((i) =>
      runtime.spawn({ requestId: `spawn-r${i}`, profile: 'researcher', files: seedFiles }),
    ),
  );

  // Round 1: independent parallel exploration
  await Promise.all(
    peers.map((peer, i) =>
      runTurn(
        peer.id,
        `Goal: ${goal}\nYou are researcher #${i + 1}. Inspect cache.ts and publish your key findings to the board.`,
        `r1-peer-${i + 1}`,
      ),
    ),
  );

  // Round 2: cross-check and cite peers
  await Promise.all(
    peers.map((peer, i) =>
      runTurn(
        peer.id,
        'Run `swarm board search` to read teammates’ entries, then publish a follow-up finding with `cites` addressing gaps or disagreements.',
        `r2-peer-${i + 1}`,
      ),
    ),
  );

  await Promise.all(peers.map((peer) => runtime.stop(peer.id)));

  // Synthesize final report.md
  const synth = await runtime.spawn({
    requestId: 'spawn-synth',
    profile: 'synthesizer',
    files: seedFiles,
  });
  await runTurn(
    synth.id,
    `Synthesize all ${board.search().length} findings on the board into report.md.`,
    'synth-1',
  );
} finally {
  const receipt = await runtime.close({ timeoutMs: 60_000 });
  unsubscribe();
  console.log(
    JSON.stringify(
      {
        runtimeId: runtime.id,
        findings: board.search().length,
        cleanup: receipt.cleanup,
        reportPath: receipt.reportPath,
      },
      null,
      2,
    ),
  );
}
```

</details>

## Where to take your Swarm next

Once the baseline Swarm runs, you can evolve the coordination policy without touching the Runtime:

| What you want to add | How to extend it | Built-in reference |
| --- | --- | --- |
| **Push urgent updates mid-turn** | After `publish`, notify busy peers via `runtime.send(..., { mode: 'steer', wakeIfIdle: false })` | [Subagents](harnesses/subagents.md) · [PeerMesh](harnesses/peermesh.md) |
| **Prevent duplicate work** | Add time-bounded exclusive claims and unlock writes on handoff via `files.replace({ writable: true })` | [TaskPool](harnesses/taskpool.md) |
| **Reuse an existing Python / verifier backend** | Keep your domain code in Python/Lean/SQLite and mount it via `createHttpJsonAdapter` | [Services & Permissions](services.md#3-connecting-external-http-services-python-go-existing-backends) · [Substrate](harnesses/substrate.md) |
| **Package for the `murm` CLI** | Export `runHarness(context)` and invoke `murm --harness ./my-swarm.mjs --prompt "..."` | [CLI Reference](reference/cli.md) |

---

**Next section:** explore the five production-ready patterns already built into `murm` in **[Choose a Harness](harnesses/index.md)**.
