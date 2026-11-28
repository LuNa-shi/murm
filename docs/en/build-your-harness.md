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

Follow the source installation, setup, and model configuration in [Quickstart](quickstart.md). Keep the SDK tarball for the example below. The Swarm runs locally without an external database or Git service. The walkthrough shows key snippets, followed by the complete runnable files.

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
// 1. Resolve OpenSandbox settings (auto-loads the local key from `murm setup --mode local` and env vars)
const conn = resolveSandboxConnection();
const sandbox = createSandbox({
  lifecycleBaseUrl: conn.lifecycleBaseUrl,
  apiKey: conn.apiKey,
});

// 2. Register the shared board
const board = new FindingsBoard();
const services = new ServiceRegistry();
services.registerService(createBoardRegistration(board));

// 3. Create Runtime with least-privilege Profiles
const runtime = await createRuntime({
  sandbox,
  executor: process.env.MURM_EXECUTOR === 'codex' ? 'codex' : 'pi',
  connection: { advertiseHost: conn.advertiseHost },
  models: { /* configured from MURM_MODEL_URL & MURM_MODEL_TOKEN — see full code */ },
  services,
  profiles: {
    researcher: {
      prompt: 'Inspect the workspace, search peer findings with `swarm board search`, and publish verified findings via `swarm board publish`.',
      model: 'default',
      image: conn.image ?? DEFAULT_WORKER_IMAGE,
      writable: false,
      services: { board: ['publish', 'search'] },
    },
    synthesizer: {
      prompt: 'Read all team findings via `swarm board search` and write a clear `report.md` in the workspace.',
      model: 'default',
      image: conn.image ?? DEFAULT_WORKER_IMAGE,
      writable: true,
      services: { board: ['search'] },
      collect: { paths: ['report.md'], includeGit: false, maxBytes: 1_048_576, required: true },
    },
  },
  maxAgents: 4, // 3 researchers + 1 synthesizer
  outputDir: './swarm-runs',
});
```

## Step 4: Run the parallel Swarm control loop (with timeouts & verification)

In real multi-agent systems, always keep four states distinct: **input accepted** (`send` receipt) ≠ **turn completed** (`settled.outcome === 'completed'`) ≠ **business goal delivered** (verified board findings and exported `report.md`) ≠ **runtime cleanup complete** (`closeReceipt.cleanup === 'complete'`).

First, create a `runTurn()` helper with an explicit **timeout**, fail-fast handling for fatal `error` / unexpected `exit`, and an explicit check on `settled.outcome`:

```ts
type TurnWaiter = {
  resolve: (outcome: 'completed' | 'failed' | 'aborted') => void;
  reject: (err: Error) => void;
  cancel: () => void;
};

const waiters = new Map<string, TurnWaiter>();

// Subscribe before spawning or sending any input; handle settled, fatal error, and unexpected exit
const unsubscribe = runtime.onEvent((event) => {
  const waiter = 'agentId' in event ? waiters.get(event.agentId) : undefined;
  if (!waiter) return;

  if (event.type === 'settled') {
    waiters.delete(event.agentId);
    waiter.resolve(event.outcome);
  } else if (event.type === 'error' && event.fatal) {
    waiters.delete(event.agentId);
    waiter.reject(new Error(`Agent ${event.agentId} fatal error: ${event.error.message}`));
  } else if (event.type === 'exit' && !event.expected) {
    waiters.delete(event.agentId);
    waiter.reject(new Error(`Agent ${event.agentId} exited unexpectedly: ${event.reason}`));
  }
});

async function runTurn(
  agentId: string,
  text: string,
  requestId: string,
  timeoutMs = 120_000,
): Promise<void> {
  let cancelTimer = () => {};
  const settled = new Promise<'completed' | 'failed' | 'aborted'>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(agentId);
      reject(new Error(`Agent ${agentId} timed out after ${timeoutMs}ms (${requestId})`));
    }, timeoutMs);
    cancelTimer = () => clearTimeout(timer);
    waiters.set(agentId, {
      resolve: (outcome) => { cancelTimer(); resolve(outcome); },
      reject: (err) => { cancelTimer(); reject(err); },
      cancel: cancelTimer,
    });
  });

  try {
    const receipt = await runtime.send(agentId, text, { requestId, mode: 'followUp' });
    if (receipt.status !== 'accepted') {
      throw new Error(`Input not accepted for ${agentId}: ${receipt.status}`);
    }
  } catch (err) {
    waiters.get(agentId)?.cancel();
    waiters.delete(agentId);
    throw err;
  }

  // settled only means the turn stopped — explicitly require outcome === 'completed'
  const outcome = await settled;
  if (outcome !== 'completed') {
    throw new Error(`Agent ${agentId} did not complete turn: ${outcome}`);
  }
}
```

Now drive 3 researchers concurrently across two rounds, independently verify shared board artifacts between stages, and report **business delivery** separately from **Runtime cleanup**:

```ts
let synthId: string | undefined;
let businessError: string | null = null;

try {
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

  // Independently verify shared state before advancing
  const round1Count = board.search().length;
  if (round1Count === 0) throw new Error('Round 1 produced zero findings on the shared board');

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
  if (board.search().length <= round1Count) {
    throw new Error('Round 2 produced no follow-up findings');
  }

  // 4. Retire researchers and spawn the synthesizer to write report.md
  await Promise.all(peers.map((peer) => runtime.stop(peer.id)));
  const synth = await runtime.spawn({ requestId: 'spawn-synth', profile: 'synthesizer', files: seedFiles });
  synthId = synth.id;
  await runTurn(synth.id, `Synthesize all ${board.search().length} board findings into report.md.`, 'synth-1');
} catch (err) {
  businessError = err instanceof Error ? err.message : String(err);
} finally {
  // 5. Always archive and clean up containers regardless of business errors
  const closeReceipt = await runtime.close({ timeoutMs: 60_000 });
  unsubscribe();

  // 6. Independently verify exported report.md, keeping delivery separate from cleanup
  const synthFiles = closeReceipt.agents
    .find((agent) => agent.agentId === synthId)
    ?.artifacts.find((p) => p.endsWith('/artifacts/files'));
  let reportBytes = 0;
  if (synthFiles) {
    try {
      reportBytes = (await readFile(join(synthFiles, 'report.md'), 'utf8')).trim().length;
    } catch { /* Report file missing or unreadable; reportBytes stays 0 */ }
  }

  const businessOk = !businessError && board.search().length >= 2 && reportBytes > 0;
  const cleanupOk = closeReceipt.cleanup === 'complete';
  console.log(JSON.stringify({ businessOk, businessError, findings: board.search().length, reportBytes, cleanupOk }, null, 2));
  if (!businessOk || !cleanupOk) process.exitCode = 1;
}
```

## Step 5: Run it and inspect the Swarm in Trace Viewer

```bash
npx tsx run-swarm.ts
murm trace --root ./swarm-runs --port 8787 --open
```

Trace Viewer shows all 3 parallel researcher swimlanes, their shared `board` calls, the synthesizer turn, and the exported `report.md` side by side.

<details>
<summary>Expand complete runnable source files (strict TypeScript, ready to save and execute)</summary>

Initialize a project and install `@luna-shi/murm` from the source tarball you built in Quickstart. Use the same shell so `pack_dir` is available, or set it to the absolute path of the directory containing the tarball.

```bash
mkdir research-swarm && cd research-swarm
npm init -y && npm pkg set type=module
npm install --ignore-scripts "$pack_dir"/*.tgz
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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
  createSandbox,
  resolveSandboxConnection,
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

const conn = resolveSandboxConnection();
const sandbox = createSandbox({
  lifecycleBaseUrl: conn.lifecycleBaseUrl,
  apiKey: conn.apiKey,
});

const modelUrl = process.env.MURM_MODEL_URL;
if (!modelUrl) throw new Error('Set MURM_MODEL_URL before running');

const runtime = await createRuntime({
  sandbox,
  executor: process.env.MURM_EXECUTOR === 'codex' ? 'codex' : 'pi',
  connection: { advertiseHost: conn.advertiseHost },
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
      image: conn.image ?? DEFAULT_WORKER_IMAGE,
      writable: false,
      services: { board: ['publish', 'search'] },
    },
    synthesizer: {
      prompt:
        'Call `swarm board search` to read every team finding and citation, then write a concise `report.md` in the workspace.',
      model: 'default',
      image: conn.image ?? DEFAULT_WORKER_IMAGE,
      writable: true,
      services: { board: ['search'] },
      collect: { paths: ['report.md'], includeGit: false, maxBytes: 1_048_576, required: true },
    },
  },
  maxAgents: 4,
  outputDir: './swarm-runs',
});

type TurnWaiter = {
  resolve: (outcome: 'completed' | 'failed' | 'aborted') => void;
  reject: (err: Error) => void;
  cancel: () => void;
};

const waiters = new Map<string, TurnWaiter>();
const unsubscribe = runtime.onEvent((event) => {
  const waiter = 'agentId' in event ? waiters.get(event.agentId) : undefined;
  if (!waiter) return;

  if (event.type === 'settled') {
    waiters.delete(event.agentId);
    waiter.resolve(event.outcome);
  } else if (event.type === 'error' && event.fatal) {
    waiters.delete(event.agentId);
    waiter.reject(new Error(`Agent ${event.agentId} fatal error: ${event.error.message}`));
  } else if (event.type === 'exit' && !event.expected) {
    waiters.delete(event.agentId);
    waiter.reject(new Error(`Agent ${event.agentId} exited unexpectedly: ${event.reason}`));
  }
});

async function runTurn(
  agentId: string,
  text: string,
  requestId: string,
  timeoutMs = 120_000,
): Promise<void> {
  let cancelTimer = () => {};
  const settled = new Promise<'completed' | 'failed' | 'aborted'>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(agentId);
      reject(new Error(`Agent ${agentId} timed out after ${timeoutMs}ms (${requestId})`));
    }, timeoutMs);
    cancelTimer = () => clearTimeout(timer);
    waiters.set(agentId, {
      resolve: (outcome) => { cancelTimer(); resolve(outcome); },
      reject: (err) => { cancelTimer(); reject(err); },
      cancel: cancelTimer,
    });
  });

  try {
    const receipt = await runtime.send(agentId, text, { requestId, mode: 'followUp' });
    if (receipt.status !== 'accepted') {
      throw new Error(`Input not accepted for ${agentId}: ${receipt.status}`);
    }
  } catch (err) {
    waiters.get(agentId)?.cancel();
    waiters.delete(agentId);
    throw err;
  }

  const outcome = await settled;
  if (outcome !== 'completed') {
    throw new Error(`Agent ${agentId} did not complete turn: ${outcome}`);
  }
}

let synthId: string | undefined;
let businessError: string | null = null;

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

  const round1Count = board.search().length;
  if (round1Count === 0) {
    throw new Error('Round 1 produced zero findings on the shared board');
  }

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

  if (board.search().length <= round1Count) {
    throw new Error('Round 2 produced no follow-up findings');
  }

  await Promise.all(peers.map((peer) => runtime.stop(peer.id)));

  // Synthesize final report.md
  const synth = await runtime.spawn({
    requestId: 'spawn-synth',
    profile: 'synthesizer',
    files: seedFiles,
  });
  synthId = synth.id;
  await runTurn(
    synth.id,
    `Synthesize all ${board.search().length} findings on the board into report.md.`,
    'synth-1',
  );
} catch (err) {
  businessError = err instanceof Error ? err.message : String(err);
} finally {
  const closeReceipt = await runtime.close({ timeoutMs: 60_000 });
  unsubscribe();

  // Independently verify collected report.md and separate delivery from cleanup
  const synthFiles = closeReceipt.agents
    .find((agent) => agent.agentId === synthId)
    ?.artifacts.find((p) => p.endsWith('/artifacts/files'));
  let reportBytes = 0;
  if (synthFiles) {
    try {
      reportBytes = (await readFile(join(synthFiles, 'report.md'), 'utf8')).trim().length;
    } catch {
      // Missing report keeps reportBytes at 0
    }
  }

  const allFindings = board.search();
  const businessOk = !businessError && allFindings.length >= 2 && reportBytes > 0;
  const cleanupOk = closeReceipt.cleanup === 'complete';

  console.log(
    JSON.stringify(
      {
        runtimeId: runtime.id,
        business: {
          ok: businessOk,
          error: businessError,
          findings: allFindings.length,
          citedFindings: allFindings.filter((f) => f.cites.length > 0).length,
          reportBytes,
        },
        cleanup: {
          ok: cleanupOk,
          status: closeReceipt.cleanup,
          pending: closeReceipt.pending.length,
          reportPath: closeReceipt.reportPath,
        },
      },
      null,
      2,
    ),
  );
  if (!businessOk || !cleanupOk) process.exitCode = 1;
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
