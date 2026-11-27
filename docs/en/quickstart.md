---
title: Quickstart
description: Connect a Linux client to OpenSandbox or prepare a local service, then run a Harness using the CLI or SDK.
section: GET STARTED
order: 1
---

The `@luna-shi/murm` package contains the CLI, TypeScript SDK and Trace Viewer. Start with a Linux account and Node.js 22.19 or newer. Use the connection path if you already have a compatible OpenSandbox service, or let setup start a local one.

## 1. Install murm

Install the package for the implementation you are testing. When testing a change before release, install its candidate tarball.

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --ignore-scripts "$pack_dir"/*.tgz
```

Published packages are available on [GitHub Releases](https://github.com/LuNa-shi/murm/releases). Use the documentation for the version you install.

## 2. Prepare or connect to OpenSandbox

### Connect to an existing service

Configure the Lifecycle API and its key. The Controller must reach the advertised data-plane endpoints, and the Worker must reach your Controller's Bridge and Model Gateway. The Controller needs only Node.js and the murm package.

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
# Set MURM_LIFECYCLE_TOKEN from the service operator in your trusted environment.
murm setup --mode existing
```

For non-default routes, put `sandbox.endpointHost` or `sandbox.useServerProxy: true` in an ESM configuration and run `murm setup --mode existing --config ./murm.config.mjs`. The options select either a host override for returned URLs or the provider's server-proxy route. The server-proxy route requires a Worker that supports the proxy token header. Use `connection.bridge.publicUrl` and `connection.modelGateway.publicUrl` for explicit callback origins, including HTTPS. Include `{port}` in each URL template. Any TLS certificates must be trusted by the process that connects to them.

### Deploy locally

```bash
murm setup --mode local
```

Setup checks your selected local Docker context, then starts OpenSandbox and verifies its authenticated Lifecycle API before preparing the chosen Worker. It prints distribution-specific installation commands and how to rerun setup if Docker is missing. Installing Docker can require a one-time system administrator action. Access to a rootful Docker socket grants substantial host access. Day-to-day murm runs use OpenSandbox API credentials and have no murm-specific sudoers requirements.

The managed service defaults to loopback port 8080. Setup generates an owner-only Lifecycle key when needed, prefers the distributed Worker image, and can build the bundled Worker image locally if needed. A repeat uses the existing managed service and leaves user configuration and unrelated deployments in place. With no `--mode`, an explicit Lifecycle endpoint selects existing mode. The default endpoint selects local mode.

`murm doctor` reports configuration and authenticated Lifecycle readiness without allocating a Sandbox. `murm doctor --smoke` exercises the selected real Pi or Codex Worker, authenticated Bridge and model gateway, file I/O, export and deletion. It uses a controlled Responses endpoint. Model validation status is reported separately.

### Keep a stricter local policy

Carry forward `isolation: { network: 'local-docker', disk: { bytes, inodes } }` if your deployment requires measured workspace quotas, live shared mounts or the local UID network allowlist. The old byte-and-inode form also selects this policy. It relies on the explicitly administered same-host Docker, namespace and Landlock ABI 5+ facilities. The default API policy requires the provider to isolate the Agent and authenticate management operations. It uses verified CPU and memory limits and delegates egress policy to the deployment. Requests for unsupported workspace disk limits, network allowlists or live shared mounts fail with a capability error.

## 3. Configure your model endpoint

Set a streaming **OpenAI Responses-compatible endpoint (`/v1/responses`)** and token for your model. Upstream credentials stay in the host Model Gateway.

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_TOKEN='sk-...'

# Optional: defaults to Pi with provider "openai" and model "gpt-5.4".
# Select a provider and model supported by your endpoint:
# export MURM_MODEL_PROVIDER='openai'
# export MURM_MODEL_ID='gpt-4.1'
# export MURM_EXECUTOR='codex'
```

- Subagents, TaskPool, Notes, and Messages default to the matching Worker tag exported as `DEFAULT_WORKER_IMAGE` and accept `MURM_WORKER_IMAGE` for a custom image. SDK callers supply an image in each Profile, as shown below. Rebuild custom images from the matching package version so the Pi catalog and Worker startup contract match.
- **Connection defaults**: OpenSandbox defaults to `http://127.0.0.1:8080/v1` and the sandbox-visible host address defaults to `172.17.0.1`. Override with `MURM_LIFECYCLE_URL`, `MURM_LIFECYCLE_TOKEN`, and `MURM_ADVERTISE_HOST` if needed.

## 4. Option A: Run a built-in Harness with the CLI

From any project directory, run `subagents`, or use the same model setup with `messages`, `notes` or `taskpool`:

```bash
cd your-project
murm --harness subagents --prompt "Audit this project's test coverage and suggest two high-value edge-case tests"
```

PeerMesh, Substrate, and Lead–Worker have their own image, model, and Service configuration. Follow their entries in [Choose a Harness](harnesses/index.md).

When finished, stdout prints the structured JSON report (including result, artifacts, and cleanup receipt). Inspect execution traces directly in a browser with the built-in Trace Viewer (no extra package required):

```bash
murm trace --root ./subagents-runs
```

## 5. Option B: Use the SDK in your own TypeScript project

To author your own coordination Harness, install `@luna-shi/murm` in a fresh directory:

```bash
mkdir my-harness
cd my-harness
npm init -y
npm pkg set type=module
npm install --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

For an unpublished version, replace the URL in the install command with the absolute path to the tarball you packed above.

Create `handoff.ts` — this self-contained example registers a `messages` Service, spawns two isolated Agents to hand off a value through it, and verifies cleanup:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createInProcessAdapter,
  createRuntime,
  createSandbox,
  type JsonValue,
  type ServiceRegistration,
} from '@luna-shi/murm';

const store = new Map<string, string>();
const messagesService: ServiceRegistration = {
  manifest: {
    contract_version: '2',
    id: 'messages',
    title: 'Messages',
    purpose: 'Exchange short text values between Agents by key.',
    provider_version: '1.0.0',
    endpoint: { transport: 'in-process' },
    capabilities: [
      {
        name: 'put',
        operation: 'put',
        description: 'Store a text value under a key.',
        side_effect: 'write',
        idempotent: true,
        help: { when: 'Publish a value for another Agent' },
        errors: [],
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string' }, text: { type: 'string' } },
          required: ['key', 'text'],
          additionalProperties: false,
        },
        output_schema: {
          type: 'object',
          properties: { stored: { type: 'boolean' } },
          required: ['stored'],
          additionalProperties: false,
        },
      },
      {
        name: 'get',
        operation: 'get',
        description: 'Read a stored text value by key.',
        side_effect: 'read',
        idempotent: true,
        help: { when: 'Read a published value' },
        errors: [],
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        output_schema: {
          type: 'object',
          properties: { text: { type: ['string', 'null'] } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
  },
  adapter: createInProcessAdapter({
    invoke({ capability, input, assertAuthorized }): JsonValue {
      const { key, text } = input as { key: string; text: string };
      if (capability.operation === 'get') return { text: store.get(key) ?? null };
      assertAuthorized();
      store.set(key, text);
      return { stored: true };
    },
  }),
};

const services = new ServiceRegistry();
services.registerService(messagesService);

const image = process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE;
const token = process.env.MURM_MODEL_TOKEN;
const url = process.env.MURM_MODEL_URL;
if (!url) throw new Error('Set MURM_MODEL_URL before running the handoff');

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    apiKey: process.env.MURM_LIFECYCLE_TOKEN,
  }),
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      upstream: {
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    },
  },
  services,
  profiles: {
    writer: { model: 'default', image, writable: false, services: { messages: ['put'] } },
    reader: {
      model: 'default', image, writable: true, services: { messages: ['get'] },
      collect: { paths: ['received.txt'], includeGit: false, maxBytes: 4096, required: true },
    },
  },
  maxAgents: 2,
  outputDir: './handoff-runs',
});

async function runTurn(agentId: string, input: string, requestId: string) {
  let unsubscribe = () => {};
  const execution = Promise.withResolvers<void>();
  const timer = setTimeout(() => execution.reject(new Error('Agent turn timed out')), 60_000);
  try {
    unsubscribe = runtime.onEvent(event => {
      if (!('agentId' in event) || event.agentId !== agentId) return;
      if (event.type === 'settled' && event.outcome === 'completed') execution.resolve();
      else if (event.type === 'settled' || event.type === 'exit' || (event.type === 'error' && event.fatal)) {
        execution.reject(new Error('Agent execution failed'));
      }
    });
    const admission = runtime.send(agentId, input, { requestId, mode: 'followUp' }).then(receipt => {
      if (receipt.status !== 'accepted' || receipt.disposition !== 'started') {
        throw new Error('Agent input was not accepted for execution');
      }
    });
    await Promise.all([admission, execution.promise]);
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
}

const expected = 'hello from murm';
let readerId: string | undefined;
let cleanup;
try {
  const writer = await runtime.spawn({
    requestId: 'spawn-writer', profile: 'writer',
    files: { 'message.json': { encoding: 'utf8', data: JSON.stringify({ key: 'greeting', text: expected }) } },
  });
  await runTurn(writer.id, 'Run swarm messages put --input message.json --request-id put-1, then finish.', 'send-writer');
  if (store.get('greeting') !== expected) throw new Error('Writer did not publish the expected value');

  const reader = await runtime.spawn({ requestId: 'spawn-reader', profile: 'reader' });
  readerId = reader.id;
  await runTurn(reader.id, 'Run swarm messages get --key greeting --request-id get-1 | jq -er .text > received.txt and then finish.', 'send-reader');
} finally {
  cleanup = await runtime.close({ timeoutMs: 30_000 });
  console.log('Cleanup status:', cleanup.cleanup, 'Output:', cleanup.outputDir);
}

if (cleanup.cleanup !== 'complete') throw new Error('Runtime cleanup is pending');
const output = cleanup.agents.find(agent => agent.agentId === readerId)
  ?.artifacts.find(path => path.endsWith('/artifacts/files'));
if (!output || await readFile(join(output, 'received.txt'), 'utf8') !== expected + '\n') {
  throw new Error('Reader did not export the expected text');
}
console.log('Handoff verified');
```

Node.js 22.19+ runs TypeScript directly with zero build config:

```bash
node handoff.ts
```

To type-check the sample, run:

```bash
npm install -D typescript @types/node
npx tsc --noEmit --strict --target es2024 --module nodenext --types node handoff.ts
```

## Developing from source

If you are contributing to `murm` itself or running the full repository test suite:

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci --ignore-scripts
npm run build
npm test
```

## Continue from here

- Explore everything included in `v0.2.0` in [Latest (v0.2.0)](latest.md) and review release history in [Changelog](changelog.md).
- Read [Use the SDK](sdk.md) for the full Runtime lifecycle, admission receipts, artifact verification, and external HTTP Services.
- Read [Build Your Own Harness](build-your-harness.md) to design custom coordination policies and Service contracts.
- Compare the five built-in mechanisms in [Choose a Harness](harnesses/index.md) (`Subagents`, `TaskPool`, `PeerMesh`, `Substrate`, and `Lead-Worker`).
