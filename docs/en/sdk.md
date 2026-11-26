---
title: Use the TypeScript SDK
description: Install the current package, run a complete two-Agent handoff, and build on the public Runtime, Service and OpenSandbox interfaces.
section: BUILD
order: 5
---

Use the SDK when you want your program to decide how Agents collaborate: who receives an input, which shared state they can access, when another Agent starts, and what counts as a finished result. A **Harness** is that program. The Runtime supplies Agent execution, Service access, observation and cleanup; your Harness supplies the coordination policy.

This guide starts with the repository's [Messages handoff](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services). It runs two Agents in separate sandboxes, transfers a value through a Service, checks the exported result and saves a final report. Its TypeScript sources are included in the package and compiled by the repository build.

## Install the current package

The current package is `@murm/core` version `0.2.0`. Its manifest has `private: true`; the supported installation recipe here uses a tarball built from a checkout you can access.

On a machine with Node.js 22.19 or newer, build the package from the repository root:

```sh
npm ci
npm pack
```

`npm pack` runs the package build and produces `murm-core-0.2.0.tgz`. In a separate project, install that file and copy the maintained example:

```sh
mkdir my-harness
cd my-harness
npm init -y
npm pkg set type=module
npm install --save-exact /absolute/path/to/murm-core-0.2.0.tgz
npm install -D typescript @types/node
cp node_modules/@murm/core/examples/bridge-services/{handoff.ts,handoff-config.ts,messages.ts,tsconfig.handoff.json} .
```

The copied example imports only the public package entry points. You can run it without `murm init` or a repository-relative import into `src/`.

The [management API](reference/api.md#runtime-management) can extend the Profile and Service directory and change Service permissions during the Run.

## Run a complete handoff

Follow the [Quickstart host setup](./quickstart.md#1-prepare-the-checkout-and-execution-host) to prepare Linux, Docker, OpenSandbox and a compatible murm Worker image with `jq`. The host must reach the Lifecycle API and Worker endpoints. The sandboxes must reach the host's Bridge and Model Gateway.

Set the image and a full OpenAI Responses-compatible model endpoint:

```sh
export MURM_SDK_IMAGE='your-worker-image'
export MURM_SDK_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SDK_MODEL_TOKEN='your-token-if-required'

npx tsc --project tsconfig.handoff.json
node build/handoff.js
```

The example defaults to Pi with the `kimi_proxy/k3` model pair. For Codex, set `MURM_SDK_EXECUTOR=codex` and `MURM_SDK_MODEL_ID` to your model; its default provider is `openai`. Both executors accept an explicit `MURM_SDK_MODEL_PROVIDER` and `MURM_SDK_MODEL_ID`. The Worker image must contain the selected supported executor.

The same-host defaults use `http://127.0.0.1:8080/v1` for the Lifecycle API, `127.0.0.1` for Worker endpoints and `172.17.0.1` as the host address visible to sandboxes. Override these with `MURM_SDK_LIFECYCLE_URL`, `MURM_SDK_ENDPOINT_HOST` and `MURM_SDK_ADVERTISE_HOST`. Supply `MURM_SDK_LIFECYCLE_TOKEN` when required. The [example README](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/README.md) documents the optional external Messages Service.

The executable follows this order:

1. Register `messages`, then create the Runtime with writer and reader Profiles. The writer may `put`; the reader may `get`.
2. Open an observation subscription before creating or starting either Agent.
3. Seed the writer's private directory with a random value and send it the publication request.
4. Observe both the successful Service operation, identified by its operation ID, and the writer's execution settlement.
5. Start the reader, which retrieves the value and writes `received.txt` in its own directory.
6. Finalize the Runtime, export the reader's file, compare its bytes with the original value, and save the report.

Event kinds appear on stderr; stdout contains a JSON result. The saved report is `handoff-runs/<runtime-id>/handoff-report.json` unless `MURM_SDK_OUTPUT` selects another root. Check `business`, `artifactVerification`, `coreClose` and `reportSaveFailure` together. The example exits unsuccessfully if the handoff fails, the file is unverified, Core cleanup is pending, or saving the report fails.

For a checkout-based run, `npm run build` followed by `node dist/examples/bridge-services/handoff.js` runs the same implementation. The [Quickstart](./quickstart.md) covers that path.

## Public entry points

Import every public value or type from `@murm/core`. The six runtime exports are `createSandbox`, `createRuntime`, `getExecutorCapabilities`, `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`. When migrating, pass deployment settings to `createSandbox` and supply the executor, model routes and host connection settings to the Runtime. The optional capability query takes an executor name and has no network or allocation work.

## Create the Runtime your Harness needs

```ts
import { createRuntime, createSandbox, ServiceRegistry } from '@murm/core';

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    isolation: { disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }),
  connection: { advertiseHost: '172.17.0.1' },
  models: {
    default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: modelUrl, headers: modelHeaders } },
  },
  services: new ServiceRegistry(),
  profiles: { reader: { model: 'default', image, writable: false, services: {} } },
  maxAgents: 2,
  outputDir,
});
```

Supply `modelUrl` ending in `/v1/responses` and host-owned `modelHeaders`. OpenSandbox and Pi are the Sandbox and executor defaults. Runtime assembly snapshots Profiles, model settings and Service registrations and opens host endpoints. `spawn` allocates each Agent sandbox. The same Sandbox configuration handle can configure multiple independently owned Runtimes.

## Submit inputs and decide when work is complete

After the handoff has spawned `writer` with its seeded input file, it submits the publication request:

```ts
const receipt = await runtime.send(
  writer.id,
  `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`,
  { requestId: `input-${key}-put`, mode: 'followUp' },
);
```

`send` returns an **admission receipt**. `accepted` means the executor accepted the input; `started`, `queued` and `handled` describe how it was admitted. It does not certify that a task or a Service write succeeded. An execution settlement is another observation, and business completion is a decision your Harness makes from the required evidence.

Use the default `mode: 'steer'` to direct active work, or `followUp` to queue work after the current execution. `wakeIfIdle` defaults to `true`; setting it to `false` permits an explicit `not-accepted` / `idle` result. Executor capabilities determine supported steering modes. Pi supports `all` and `one-at-a-time`; Codex supports explicit `all`.

Retain the Agent ID, request ID, text and options for each submission. If the receipt is `unknown`, repeat the exact call to reconcile that submission. Changing its arguments under the same request ID is a conflict. An application timeout or cancellation ends your wait; it does not prove the submitted input was cancelled. Use `interrupt` or `stop` for that lifecycle action.

The handoff can wait for one Agent's settlement because it exclusively controls that Agent's inputs and also verifies the matching Service operation and exported file. A general multi-source Harness must keep its own task and result identities: executor boundaries do not identify the inputs they consumed.

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

Register `onEvent` before `spawn` or `send`. Use `get/list` and `runtime.state` to read current state. `output` contains assistant text, `settled` marks an executor execution boundary, and `agentChanged` and `runtimeChanged` tell the host to refresh its view. Early events can arrive before the send receipt. Read business results from your adapter, domain store or artifacts. A Harness that shares an Agent among input sources needs its own task receipts.

## Close and inspect each result

Stop delivering work, then call `runtime.close({ timeoutMs })`. Find the reader's export directory in `receipt.agents` and compare the bytes of `received.txt`. A required export failure retains the sandbox for recovery. Retry cleanup on the original Runtime after removing the obstacle. The existing HTTP Service keeps its own owner.

The handoff writes independent business, artifact verification, Core close and report-save outcomes to `handoff-report.json`.

## Extend the collaboration mechanism

Build a Service when Agents need a shared task pool, mailbox, result store, checker or other coordination state. [Build Your Own Harness](./build-your-harness.md) shows a complete manifest and adapter. An in-process adapter runs in your host process; an HTTP JSON adapter connects to an existing service. Services can live in independently deployed containers or external applications. Registering one does not give the Runtime ownership of that deployment.

For parent-controlled spawning, grant the built-in `agent` Service operations and specify `spawnProfiles`. For peer coordination, route inputs and publications through your own Service and host policy. For task claiming, combine domain ownership with the trusted file handoff APIs. The [Harness catalogue](./harnesses/index.md) explains how TaskPool, PeerMesh, Subagents, Substrate and Lead-Worker use these same primitives differently.

Use the [API reference](./reference/api.md) for exact arguments and recovery behavior, [Types](./reference/types.md) for public declarations, and [Anatomy of a Run](./run-lifecycle.md) for resource ownership and cleanup order.
