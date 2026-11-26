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

Cursor and event kind appear on stderr; stdout contains a JSON result. The saved report is `handoff-runs/<runtime-id>/run-finalization.json` unless `MURM_SDK_OUTPUT` selects another root. Check `business`, `artifactVerification`, `coreClose` and `reportSaveFailure` together. The example exits unsuccessfully if the handoff fails, the file is unverified, Core cleanup is pending, or saving the report fails.

For a checkout-based run, `npm run build` followed by `node dist/examples/bridge-services/handoff.js` runs the same implementation. The [Quickstart](./quickstart.md) covers that path.

## Public entry points

These are import paths in **one npm package**:

| Import path | Use it for |
| --- | --- |
| `@murm/core` | `createRuntime`, `finalizeRun`, and Runtime, Profile, observation and result types |
| `@murm/core/services` | `ServiceRegistry`, in-process and HTTP JSON adapters, Service contracts and validation helpers |
| `@murm/core/backends/opensandbox` | `createOpenSandboxBackend`, executor capabilities and backend configuration |
| `@murm/core/backends/pi-opensandbox` | Deprecated Pi-specific convenience factory; use the general OpenSandbox entry point |

The first three are the usual imports for a new Harness. The backend handle is opaque and belongs to one Runtime. Create a fresh handle for another Run.

## Create the Runtime your Harness needs

This assembly is the central part of the runnable handoff. `handoffConfig` and `createMessageService` are the files copied above:

```ts
import { createRuntime } from '@murm/core';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';
import { ServiceRegistry } from '@murm/core/services';
import { handoffConfig } from './handoff-config.js';
import { createMessageService } from './messages.js';

const config = handoffConfig();
const services = new ServiceRegistry();
services.registerService(createMessageService(config.externalMessages));
const profile = { model: 'default', image: config.image, writable: true };

const runtime = await createRuntime({
  backend: createOpenSandboxBackend(config.backend),
  services,
  maxAgents: 2,
  outputDir: config.outputDir,
  profiles: {
    writer: { ...profile, services: { messages: ['put'] } },
    reader: {
      ...profile,
      services: { messages: ['get'] },
      collect: {
        paths: ['received.txt'], includeGit: false,
        maxBytes: 4096, required: true,
      },
    },
  },
});
```

This is an assembly excerpt; the complete `handoff.ts` also bounds the work, handles cancellation, observes results and calls `finalizeRun` on success and failure. Keep that closeout when adapting the example.

`createRuntime` snapshots Profiles and Service registrations, validates their references, creates the Run directory, and opens host entry points. It allocates no Agent sandbox. Later changes to your configuration object or Registry do not change this Runtime. Define the startup roles and operations before assembly. For later changes, use `runtime.profiles` to register Profiles, `runtime.services` to register or retire Services, and `runtime.access` to manage Service permissions for an Agent. [API reference](reference/api.md#runtime-management)

`spawn({ requestId, profile })` allocates a sandbox and initializes an idle session. It starts no model work. Send the first input after you have recorded the new Agent ID and connected any Harness routing or ownership state. Idle sessions continue to occupy a Slot until cleanup confirms sandbox deletion.

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

The handoff can wait for one Agent's settlement because it exclusively controls that Agent's inputs and also verifies the matching Service operation and exported file. A general multi-source Harness must keep its own task and result identities: current execution events report `association: 'unknown'` because native boundaries do not identify the inputs they consumed.

## Observe state without a snapshot/subscribe race

```ts
const observation = runtime.observe({ signal: shutdownSignal });
console.log(observation.snapshot);

try {
  for await (const update of observation.events) {
    if (update.type === 'gap') {
      // Reopen observe() and rebuild the view from its fresh snapshot.
      break;
    }
    console.log(update.cursor, update.type);
  }
} finally {
  observation.cancel();
}
```

`observe()` returns a current snapshot and the stream immediately after that snapshot's cursor. Open it before dispatching work and consume it concurrently with your Harness. `observe({ after: cursor })` returns `snapshot: null` and replays cached updates after that cursor. Keep the previous view when resuming; request a fresh snapshot after a gap.

The Runtime retains 256 updates and permits 64 active subscriptions. A cursor belongs to the current Runtime instance; it is not a persisted restart token. Observation continues until the caller cancels it, even after Runtime close. `onEvent` remains useful for output text and the four Agent event kinds; `observe` adds Runtime, input, Service and cleanup state. [API reference](./reference/api.md#live-observation) defines the sequence fields and limits.

## Finalize and inspect each result

The handoff first classifies its business outcome, then uses the public finalizer:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finalizeRun } from '@murm/core';

const report = await finalizeRun({
  runtime,
  outputDir: config.outputDir,
  business,
  cleanupTimeoutMs: 30_000,
  ...(readerId === undefined ? {} : {
    async verifyArtifacts(receipt, signal) {
      const reader = receipt.agents.find(agent => agent.agentId === readerId);
      const files = reader?.artifacts.find(path => path.endsWith('/artifacts/files'));
      if (!files || await readFile(join(files, 'received.txt'), {
        encoding: 'utf8', signal,
      }) !== `${expected}\n`) {
        throw new Error('HANDOFF_ARTIFACT_MISMATCH');
      }
    },
  }),
});
```

Here `business` is the typed `RunBusinessOutcome`, while `readerId` and `expected` are state retained by the handoff. Verification is requested once a reader was created; the complete success, failure and cancellation paths are in `handoff.ts`. The finalizer calls `runtime.close`, runs your artifact check when a close receipt is available, then closes only the facilities you explicitly listed in `ownedFacilities` and only after confirmed Core cleanup.

| Report field | Question it answers |
| --- | --- |
| `business` | Did the Harness achieve its declared outcome, fail, or get cancelled? |
| `coreClose` | Is Core cleanup confirmed complete, pending, or unknown? |
| `artifactVerification` | Did the application check exported results, fail that check, defer it, or omit it? |
| `facilities` | Were application-owned facilities closed? |
| `reportSaveFailure` | Was the report itself saved successfully? |

A required export failure retains the sandbox and appears in the pending cleanup receipt. Keep external facilities available while Core still needs them. The finalizer accepts one call per Runtime object; reconcile pending cleanup with the original `runtime.close()` and facility handles. A timed-out facility callback can produce a separate late receipt through `lateFacilityCleanup`.

## Extend the collaboration mechanism

Build a Service when Agents need a shared task pool, mailbox, result store, checker or other coordination state. [Build Your Own Harness](./build-your-harness.md) shows a complete manifest and adapter. An in-process adapter runs in your host process; an HTTP JSON adapter connects to an existing service. Services can live in independently deployed containers or external applications. Registering one does not give the Runtime ownership of that deployment.

For parent-controlled spawning, grant the built-in `agent` Service operations and specify `spawnProfiles`. For peer coordination, route inputs and publications through your own Service and host policy. For task claiming, combine domain ownership with the trusted file handoff APIs. The [Harness catalogue](./harnesses/index.md) explains how TaskPool, PeerMesh, Subagents, Substrate and Lead-Worker use these same primitives differently.

Use the [API reference](./reference/api.md) for exact arguments and recovery behavior, [Types](./reference/types.md) for public declarations, and [Anatomy of a Run](./run-lifecycle.md) for resource ownership and cleanup order.
