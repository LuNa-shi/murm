---
title: Quickstart
description: Install host prerequisites, install @luna-shi/murm in one command, and run your first multi-agent Harness via the CLI or TypeScript SDK.
section: GET STARTED
order: 1
---

`murm` ships both its CLI and TypeScript SDK in the **`@luna-shi/murm`** npm package. Once your Linux host prerequisites are ready, you can run a built-in Harness against any project with one command or embed the SDK in your own TypeScript application.

## 1. Prerequisites (execution host)

The OpenSandbox isolation backend runs on a **single Linux host** (macOS, Docker Desktop, and rootless Docker are not supported) and requires five explicit host components:

| Requirement | Minimum version / profile | Purpose |
| --- | --- | --- |
| **Linux kernel** | **Landlock ABI >= 5** (typically Linux 6.10+, `x86_64` or `aarch64`) | Enforces per-Agent filesystem boundaries inside sandboxes |
| **Node.js & npm** | **Node.js 22.19+** | Runs the `murm` CLI and TypeScript SDK |
| **Docker Engine** | Local **rootful Docker Engine** (`/var/run/docker.sock`, local `/run/docker.pid` visible) | Runs the OpenSandbox server and isolated Worker containers |
| **Host utilities** | `python3`, `nftables`, `util-linux`, `coreutils`, `iproute2` | Configures per-sandbox `tmpfs` disk quotas and `nftables` egress policies |
| **Non-interactive `sudo`** | Passwordless host rules for `unshare`, `nft`, and `mount-agent-workspace.py` | Lets the trusted host isolate sandbox namespaces (Agents remain unprivileged) |

### 1.1 Check your Linux kernel and Node.js

```bash
# Confirm Node.js >= 22.19.0
node -v

# Confirm the kernel exposes Landlock ABI >= 5
python3 -c "import ctypes, platform; assert platform.machine() in ('x86_64', 'aarch64'); abi = ctypes.CDLL(None).syscall(444, 0, 0, 1); print('Landlock ABI:', abi); assert abi >= 5"
```

### 1.2 Install Docker Engine and host packages (Ubuntu / Debian)

If rootful Docker Engine is not installed yet, follow the [official Docker Engine install guide](https://docs.docker.com/engine/install/), then install the host utilities and grant your user access to `/var/run/docker.sock`:

```bash
sudo apt-get update
sudo apt-get install -y python3 nftables util-linux coreutils iproute2

# Allow your user to access /var/run/docker.sock (re-login or run `newgrp docker` afterward)
sudo usermod -aG docker "$USER"
docker info --format '{{.OSType}} {{.ServerVersion}}'
```

### 1.3 Configure least-privilege non-interactive `sudo`

When spawning each Agent sandbox, `murm` applies `tmpfs` workspace quotas and `nftables` egress rules from the **host** so the sandbox can reach only the host Bridge and Model Gateway. After installing `@luna-shi/murm` (Step 2), create `/etc/sudoers.d/murm` with `sudo visudo -f /etc/sudoers.d/murm` (replace `<your-user>` and `<murm-pkg-root>` with your username and `$(npm root -g)/@luna-shi/murm`):

```text
<your-user> ALL=(root) NOPASSWD: /usr/bin/unshare --mount --net -- /usr/bin/true
<your-user> ALL=(root) NOPASSWD: /usr/sbin/nft *
<your-user> ALL=(root) NOPASSWD: /usr/bin/nsenter *
<your-user> ALL=(root) NOPASSWD: /usr/bin/mount *
<your-user> ALL=(root) NOPASSWD: /usr/bin/umount *
<your-user> ALL=(root) NOPASSWD: /usr/bin/python3 -I <murm-pkg-root>/dist/scripts/mount-agent-workspace.py *
```

Verify both checks exit 0 without prompting for a password:

```bash
sudo -n /usr/bin/unshare --mount --net -- /usr/bin/true
sudo -n /usr/sbin/nft -j list tables >/dev/null
```

## 2. Install `@luna-shi/murm` and prepare OpenSandbox & Worker

Install the CLI globally from the latest GitHub Release:

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

Or use npm directly:

```bash
npm install -g --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
```

### Install a candidate from a checkout

For an unpublished version, run these commands from the murm checkout. Keep the tarball if you also want to install the SDK in a separate project.

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --ignore-scripts "$pack_dir"/*.tgz
```

Run `murm setup` to prepare and verify the local infrastructure:

```bash
murm setup
```

`murm setup` is transparent — it runs four explicit stages and prints a structured JSON report:

1. **Host preflight**: verifies Linux/Landlock ABI, Node.js, rootful Docker, the Docker bridge gateway IP (default `172.17.0.1`), `nftables`, `unshare`, and passwordless `sudo` rules (you can re-run host checks anytime with `murm doctor`).
2. **Start local OpenSandbox**: pulls `opensandbox/server:release-1.2.0` and `opensandbox/execd:v1.1.0`, then starts the managed container `murm-opensandbox-8080` using the packaged `deploy/opensandbox/config.toml`, exposing the Lifecycle API on `http://127.0.0.1:8080/v1` with SQLite state in `~/.cache/murm/opensandbox/`.
3. **Prepare the Worker image**: pulls the prebuilt official image `ghcr.io/luna-shi/murm-worker:0.2.0` (matching the package version), or automatically falls back to building `deploy/worker/Dockerfile` locally under that same tag if offline or developing unreleased changes. The Worker image bundles `opensandbox-agent-worker`, Pi `1.3.0`, Codex CLI `0.172.0`, the `swarm` CLI, `jq`, and the Landlock filesystem policy binary.
4. **Live sandbox smoke probe**: starts a real sandbox against a loopback mock Responses server to verify execution, Bridge calls, filesystem isolation, and cleanup end to end.

<details>
<summary>Prefer manual setup? Expand for the exact Docker commands for OpenSandbox and the Worker image</summary>

1. Pull the OpenSandbox images and start the loopback Lifecycle server on `127.0.0.1:8080/v1`:

```bash
docker pull opensandbox/execd:v1.1.0
docker pull opensandbox/server:release-1.2.0

MURM_ROOT="$(npm root -g)/@luna-shi/murm"
mkdir -p ~/.cache/murm/opensandbox/manual/data
cp "$MURM_ROOT/deploy/opensandbox/config.toml" ~/.cache/murm/opensandbox/manual/config.toml

docker run -d \
  --name murm-opensandbox-8080 \
  --network host \
  --restart unless-stopped \
  -e OPENSANDBOX_INSECURE_SERVER=YES \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ~/.cache/murm/opensandbox/manual/config.toml:/config/config.toml:ro \
  -v ~/.cache/murm/opensandbox/manual/data:/root/.opensandbox \
  opensandbox/server:release-1.2.0 --config /config/config.toml
```

2. Pull the prebuilt Worker image (or build it locally from the packaged Dockerfile):

```bash
# Option 1: Pull the prebuilt official image (recommended)
docker pull ghcr.io/luna-shi/murm-worker:0.2.0

# Option 2: Or build locally (useful when adding custom sandbox tools)
docker build -f "$MURM_ROOT/deploy/worker/Dockerfile" -t ghcr.io/luna-shi/murm-worker:0.2.0 "$MURM_ROOT"
```

3. Verify the full host, OpenSandbox, and Worker contract:

```bash
murm doctor --smoke
```

</details>

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
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
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

- Read [Use the SDK](sdk.md) for the full Runtime lifecycle, admission receipts, artifact verification, and external HTTP Services.
- Read [Build Your Own Harness](build-your-harness.md) to design custom coordination policies and Service contracts.
- Compare the five built-in mechanisms in [Choose a Harness](harnesses/index.md) (`Subagents`, `TaskPool`, `PeerMesh`, `Substrate`, and `Lead-Worker`).
