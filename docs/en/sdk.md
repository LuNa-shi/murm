---
title: Use the TypeScript SDK
description: Install @luna-shi/murm and build custom multi-agent Harnesses on the public Runtime, Service, and OpenSandbox interfaces.
section: BUILD
order: 5
---

Use the SDK when you want your program to decide how Agents collaborate: who receives an input, which shared state they can access, when another Agent starts, and what counts as a finished result. A **Harness** is that program. The Runtime supplies Agent execution, Service access, observation, and cleanup; your Harness supplies the coordination policy.

To run a built-in Harness against a project directory via the CLI, see the [Quickstart](./quickstart.md) or [Choose a Harness](harnesses/index.md). This guide focuses on embedding `@luna-shi/murm` in your own TypeScript application.

## Install the SDK

In a Node.js 22.19+ project, install the versioned GitHub Release asset:

```sh
npm install --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

With npm 12, use `npm ci --allow-remote=root` when reinstalling this dependency from a lockfile.

Before running live sandboxes, follow the [Quickstart host prerequisites](./quickstart.md#1-prerequisites-execution-host) to prepare Linux, Docker, OpenSandbox, and the Worker image (or run `murm setup` and verify with `murm doctor`).

The [management API](reference/api.md#runtime-management) lets you extend the Profile and Service directory and update Agent Service permissions while a Run is open.

## Public entry points

Import all public values and types from `@luna-shi/murm`. The seven runtime exports are:

- `createSandbox`: captures OpenSandbox lifecycle and disk/network isolation settings
- `createRuntime`: creates and manages the Runtime, Agent lifecycle, file controls, and cleanup
- `DEFAULT_WORKER_IMAGE`: default prebuilt Worker image tag matching this package version (`ghcr.io/luna-shi/murm-worker:0.2.0`)
- `getExecutorCapabilities`: static capability lookup for `'pi'` or `'codex'` with no network side effects
- `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`: register in-process or external HTTP JSON v2 Services

## Create the Runtime your Harness needs

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
  createSandbox,
} from '@luna-shi/murm';

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }),
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      upstream: {
        url: process.env.MURM_MODEL_URL!,
        headers: process.env.MURM_MODEL_TOKEN
          ? { authorization: `Bearer ${process.env.MURM_MODEL_TOKEN}` }
          : {},
      },
    },
  },
  services: new ServiceRegistry(),
  profiles: {
    reader: {
      model: 'default',
      image: process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
      writable: false,
      services: {},
    },
  },
  maxAgents: 2,
  outputDir: './runs',
});
```

- **Model routing**: point `upstream.url` at any streaming OpenAI Responses-compatible endpoint ending in `/v1/responses`. Pi is the default executor and accepts both shipped catalog models (`openai`, `kimi_proxy`, `gpt_proxy`) and any custom `provider` + `model` pair (the host synthesizes and attests a Pi model catalog automatically). Pass `executor: 'codex'` to use Codex.
- **Worker image**: pass `DEFAULT_WORKER_IMAGE` unless you built a custom Worker image with extra tools.
- **Isolation & credentials**: upstream credentials remain in the host Model Gateway and never enter Agent sandboxes. One `createSandbox` handle can configure multiple independent Runtimes.

## Complete two-Agent handoff example

The repository's [Messages handoff example](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services) demonstrates full production-style verification (operation-ID reconciliation, byte-level artifact verification, and optional external HTTP Service attachment):

1. Register `messages`, then create the Runtime with `writer` (`put`) and `reader` (`get`) Profiles.
2. Subscribe via `runtime.onEvent` before creating or starting either Agent.
3. Seed the writer's private directory with a random value and send the publication request.
4. Observe both the successful Service operation (by operation ID) and the writer's execution settlement.
5. Start the reader, which retrieves the value and writes `received.txt`.
6. Close the Runtime, compare exported bytes against the original value, and save `handoff-report.json`.

You can also invoke this built-in Harness directly from any project directory via the CLI:

```sh
murm --harness messages --prompt "Inspect this project and hand off a verification summary"
```

## Submit inputs and decide when work is complete

After spawning `writer` with its seeded input file, submit the publication request:

```ts
const receipt = await runtime.send(
  writer.id,
  `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`,
  { requestId: `input-${key}-put`, mode: 'followUp' },
);
```

`send` returns an **admission receipt**. `accepted` means the executor accepted the input; `started`, `queued`, and `handled` describe how it was admitted. It does not certify that a task or a Service write succeeded. An execution settlement (`settled`) is a separate observation, and business completion is a decision your Harness makes from required evidence.

Use the default `mode: 'steer'` to direct active work, or `followUp` to queue work after the current execution. `wakeIfIdle` defaults to `true`; setting it to `false` permits an explicit `not-accepted` / `idle` result. Pi supports `all` and `one-at-a-time` steering modes; Codex supports explicit `all`.

Retain the Agent ID, request ID, text, and options for each submission. If the receipt is `unknown`, repeat the exact call to reconcile that submission. Changing arguments under the same request ID returns `CONFLICT`. An application timeout or cancellation ends your wait; it does not prove the submitted input was cancelled — use `interrupt` or `stop` for lifecycle control.

## Subscribe before dispatching work

```ts
const unsubscribe = runtime.onEvent(event => {
  if (event.type === 'output') process.stdout.write(event.text);
  if (event.type === 'runtimeChanged') console.log(runtime.state);
});
try {
  const agents = await runtime.list();
  // Dispatch work while the listener is active.
} finally {
  unsubscribe();
}
```

Register `onEvent` before `spawn` or `send`, then call `get/list` and read `runtime.state` to initialize your view. `output` carries assistant text, `settled` marks an executor execution boundary, and `agentChanged` / `runtimeChanged` notify the host to refresh state. Events may arrive before the send receipt resolves.

## Close and inspect each result

Stop delivering work, then call `runtime.close({ timeoutMs })`. Read each Agent's export directory from `receipt.agents` and verify collected files. A required export failure retains the sandbox for recovery; retry `close()` on the original Runtime after resolving the obstacle. Existing external HTTP Services retain their own owners.

## Extend the collaboration mechanism

Build a Service when Agents need a shared task pool, mailbox, result store, checker, or other coordination state. [Build Your Own Harness](./build-your-harness.md) shows a complete manifest and adapter. An in-process adapter runs in your host process; an HTTP JSON adapter connects to an existing service.

- Parent-controlled spawning: grant the built-in `agent` Service operations and specify `spawnProfiles`.
- Peer coordination: route inputs and publications through your own Service and host policy.
- Exclusive task claiming: combine domain leases with the trusted file APIs (`runtime.files`).

See the [API reference](./reference/api.md) for exact signatures and recovery semantics, [Types](./reference/types.md) for public declarations, and [Run lifecycle](./run-lifecycle.md) for resource ownership and cleanup order.
