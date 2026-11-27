# murm

Build your own multi-agent Harness.

`murm` is a TypeScript SDK and CLI for running isolated Agents and connecting them to shared Services. You write the collaboration policy: who starts work, how Agents communicate, what they share, and when the job is done. The Runtime manages Agent lifecycles, input delivery, Service access, execution records, and cleanup. The OpenSandbox backend runs Pi or Codex inside each Agent's isolated sandbox.

[Website](https://luna-shi.github.io/murm/) · [Documentation](docs/en/overview.md) · [中文文档](docs/zh/overview.md) · [Quickstart](docs/en/quickstart.md) · [SDK Guide](docs/en/sdk.md) · [Architecture](docs/architecture/INDEX.md)

## Quick start

On a Linux host with Node.js 22.19+, rootful Docker Engine, Landlock ABI 5+, and the host isolation utilities (`python3`, `nftables`, `util-linux`, `iproute2`, plus non-interactive `sudo` rules — see [Prerequisites](docs/en/quickstart.md#1-prerequisites-execution-host)):

```sh
# 1. Install the CLI globally
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh

# 2. Verify host prerequisites, start local OpenSandbox, pull/build the Worker image, and run a smoke probe
murm setup

# 3. Point murm at any streaming OpenAI Responses-compatible endpoint
export MURM_MODEL_URL="https://api.openai.com/v1/responses"
export MURM_MODEL_TOKEN="sk-..."

# 4. Run a built-in Harness against your project
cd my-project
murm --harness subagents --prompt "Fix the parser and add tests"
```

To install directly with npm, run:

```sh
npm install -g --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
```

For an unpublished version, [install the candidate from a checkout](docs/en/quickstart.md#install-a-candidate-from-a-checkout) before running `murm setup`.

The Subagents CLI configuration defaults to the matching Worker image tag, exported as `DEFAULT_WORKER_IMAGE`. Override it with `MURM_WORKER_IMAGE` when using a custom image. SDK Profiles take an explicit image.

Use `--harness` to select any built-in (`subagents`, `taskpool`, `peermesh`, `substrate`, `lead-worker`, `notes`, `messages`), a local ESM file, or an installed npm package. In `--mode rpc`, tasks arrive over JSONL with live `status` and `stop` control.

## Build with the TypeScript SDK

Install the versioned Release asset in your own project:

```sh
npm install --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

Install a candidate tarball by passing its path in place of the URL. Import `createSandbox`, `createRuntime`, `DEFAULT_WORKER_IMAGE`, `getExecutorCapabilities`, `ServiceRegistry`, `createInProcessAdapter`, and `createHttpJsonAdapter` from `@luna-shi/murm`. Pi is the default executor. Pi and Codex use streaming Responses endpoints that support their request formats.

See the [Quickstart](docs/en/quickstart.md#5-option-b-use-the-sdk-in-your-own-typescript-project) for a self-contained runnable `handoff.ts`, and the [SDK Guide](docs/en/sdk.md) for observation, file controls, external HTTP Services, and cleanup semantics.

## Built-in Harnesses

The repository includes five substantial Harnesses sharing the same Runtime with different collaboration rules:

| Harness | How Agents coordinate | Start here |
| --- | --- | --- |
| Subagents | A parent creates and directs children through a scoped Service; Pi can fork conversation context. | [Guide](docs/en/harnesses/subagents.md) · [Example](examples/subagents/README.md) |
| TaskPool | Agents exclusively take Tasks and publish Materials and Workspace revisions toward a shared Mission. | [Guide](docs/en/harnesses/taskpool.md) · [Example](examples/taskpool/README.md) |
| PeerMesh | Peers use Git, messages, and a shared Board, each with its own identity and branch. | [Guide](docs/en/harnesses/peermesh.md) · [Example](examples/peermesh/README.md) |
| Substrate | A fixed peer pool publishes, searches, reads, and cites durable contributions. | [Guide](docs/en/harnesses/substrate.md) · [Example](examples/substrate/README.md) |
| Lead-Worker | A lead and fixed helpers coordinate through a Board and retain deliveries in Git. | [Guide](docs/en/harnesses/lead-worker.md) · [Example](examples/lead-worker/README.md) |

Compare policies in [Choose a Harness](docs/en/harnesses/index.md) or create your own in [Build Your Own Harness](docs/en/build-your-harness.md).

## Built-in Trace Viewer

Inspect saved or live Run timelines in a local web UI (bundled inside `@luna-shi/murm` — no extra package required):

```sh
murm trace --root ./subagents-runs --port 8787
```

## Contributing & developing from source

```sh
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci --ignore-scripts
npm run build
npm test
```

Check the [Architecture manual](docs/architecture/INDEX.md) for the deeper implementation contracts, generated API/schema references, and prompt composition. The [research context](docs/PROJECT.md) describes the questions behind `murm`, and [ProgramBench Pastel](benchmarks/programbench-pastel/README.md) / [PutnamBench TaskPool](benchmarks/putnambench-taskpool/README.md) document the evaluation drivers. [Experiment reports](docs/experiments/INDEX.md) preserve observations tied to their original code, model and inputs.

## License

[MIT](LICENSE)
