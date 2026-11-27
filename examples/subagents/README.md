# Subagents Harness

## Run from your project

```sh
cd my-project
murm --harness subagents --prompt "Inspect this project and explain how to verify it"
```

Subagents sends the prompt to Root and supplies the captured project to Root and each Child. The application uses separate Sandbox directories. Optional RPC input goes to Root.

After installing the built tarball, configure the model route, compatible Worker image and other runtime resources described below. A JavaScript config can also be supplied with `--config`. The common command saves its outputs outside the input directory by default.


This example builds a recursive team using the public Runtime, Services and OpenSandbox SDK entries. Its `createSubagentsHarness` factory and `collaboration` controller are local example modules, not exports from `@luna-shi/murm`. See the [mechanism guide](../../docs/en/harnesses/subagents.md) and [SDK guide](../../docs/en/sdk.md).

TypeScript sources compile with `npm run build` into `dist/`. The package is currently marked private and distributed as a checkout-built tarball; `npm pack` builds the JavaScript and declarations before archiving.

Give Root a task. Root looks for independent work it can delegate early, chooses the assignments, and works on a complementary part while the team is active. A Child can delegate again. Team members can send notices, assign more work, wait and interrupt. A Child's result goes to its direct parent.

## Run from the checkout

Use Node.js 22.19 or newer and npm on the Linux Controller. If you have a compatible Worker image and an OpenSandbox provider, build from the checkout root.

```sh
npm ci
npm run build
cd examples/subagents
```

If you need to prepare the host, run `./scripts/setup` from the checkout root in place of the install and build commands. It builds the checkout, prepares the Worker and OpenSandbox, and verifies them with a local Responses endpoint. The setup JSON reports the image ID as `worker.id`. [Host requirements and diagnostics](../../docs/architecture/07-run-configuration.md#local-setup-and-doctor)

Create `examples/subagents/.env` with your Worker image ID and a streaming `/v1/responses` endpoint that accepts `k3` and supports tool calls. Fill in the token if the endpoint requires bearer authentication.

```sh
MURM_SUBAGENTS_IMAGE="sha256:<your-worker-image-id>"
MURM_SUBAGENTS_MODEL_URL="https://your-gateway.example/v1/responses"
MURM_SUBAGENTS_MODEL_TOKEN=""
```

The example defaults to a local OpenSandbox lifecycle URL of `http://127.0.0.1:8080/v1`. Set `MURM_SUBAGENTS_LIFECYCLE_URL` for another port and `MURM_SUBAGENTS_LIFECYCLE_TOKEN` if your provider requires authentication.

From `examples/subagents/`, run one task.

```sh
node --env-file=.env ../../dist/examples/subagents/main.js \
  ../../dist/examples/subagents/config.js \
  'Suggest two checks to make before merging a pull request.'
```

The entry waits for Root's reply, closes the team, and writes the task result and cleanup receipts to `subagents-runs/<runtimeId>/harness-report.json`. Edit `config.ts` or `main.ts` here and rebuild from the checkout root to try changes.

## Interactive mode

Pass `--interactive` in place of the task to keep the example open.

In interactive mode, enter a task or a follow-up as a line, use `/status` to inspect the team, and use `/exit` to close the whole run. A Root reply leaves the team available for further input. End of input and host cancellation also close the team. A host can instead supply `config.goal` or use the exported input, reply, status and close methods.

The example config defaults to four live Agents including Root, with a maximum depth of three child edges from Root. Set `MURM_SUBAGENTS_MAX_AGENTS` and `MURM_SUBAGENTS_MAX_DEPTH` to adjust the limits. Models can be configured as `rootModel` and `childModel` on the host. The default work limit is 120 seconds and cleanup has its own 30-second limit. Set `files` to seed Root, and use a required `collect` specification for files that must be exported. Work directories are private by default. Set `workspace.root` and `workspace.child` to supported Core workspace mounts to enable sharing. Private children can send patches as text to Root.

## Use the packaged example with Codex

Install the versioned `@luna-shi/murm` tarball from GitHub Release (see the [SDK guide](../../docs/en/sdk.md#install-the-sdk)). The example defaults to Pi. To use Codex from that consumer project, set `MURM_EXECUTOR=codex` (or `MURM_SUBAGENTS_EXECUTOR=codex`), `MURM_MODEL_ID`, and `MURM_MODEL_URL` in the host shell. The Worker image defaults to `DEFAULT_WORKER_IMAGE` (`ghcr.io/luna-shi/murm-worker:0.2.0`) and can be overridden with `MURM_WORKER_IMAGE` or `MURM_SUBAGENTS_IMAGE`. Supply any required model or lifecycle token through the host environment.

```sh
example=node_modules/@luna-shi/murm/dist/examples/subagents
node "$example/main.js" "$example/config.js" --interactive
```

The configured `doctor --smoke` path covers Pi projects. The installed Codex example runs through the same local OpenSandbox provider and its own executor. [Codex startup and capabilities](../../docs/architecture/16-pi-opensandbox-backend.md#codex-app-server)

Use `--fork-turns none` when delegating with Codex. Use `swarm service view collaboration` to see the authenticated operations and arguments. A typical pair of calls looks like this.

```sh
swarm collaboration spawn_agent --task-name reviewer --message 'Check the implementation plan' --fork-turns none --request-id reviewer-start
swarm collaboration wait_agent --request-id reviewer-result
```

Pi supports copying parent context with `fork_turns: all`; Codex currently advertises only fresh conversations with `fork_turns: none`. Files remain private unless the host explicitly supplies supported shared-workspace mounts.

A plain notice or child result can reach active work or be taken through a wait. Idle members keep the notice for later. Explicit follow-up can start work on the same Agent. Closing exports the configured files and time-stamped Sessions, model requests and Service calls to the private run directory. `harness-report.json` records task and cleanup outcomes.

## Embed the example

Import `createSubagentsHarness` from the local example module after building. The returned handle provides `input`, `status`, `onReply`, `lastReply`, `waitForReply` and `close`. Check the input receipt, then check the reply outcome. For repeated inputs, pass the preceding reply sequence as `waitForReply({ after, signal })`. Supply a bounded host signal and call `close` in a `finally` block; inspect its execution and cleanup receipts. The [mechanism guide](../../docs/en/harnesses/subagents.md) shows a complete host call.

## Verification

The [Subagents verification guide](../../test/README.md#subagents-verification) describes the regression and native OpenSandbox checks. The [ProgramBench fd experiment](../../docs/experiments/EXP-20261125-10-issue199-fd.md) records a real three-Agent run, including the file handoff, follow-up and independent score.
