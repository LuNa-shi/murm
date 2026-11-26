# Subagents Harness

Repository TypeScript sources compile with `npm run build` into `dist/`. `npm pack` builds the distributable JavaScript and declarations before archiving.

Give Root a task. Root looks for independent work it can delegate early, chooses the assignments, and works on a complementary part while the team is active. A Child can delegate again. Team members can send notices, assign more work, wait and interrupt. A Child's result goes to its direct parent.

From the checkout, prepare the host and initialize the editable project.

```sh
./scripts/setup
node dist/scripts/murm.js init --template subagents --dir ../my-murm
cd ../my-murm
```

With an installed binary, use `murm setup` for host preparation and `murm init --template subagents --dir ./my-murm` for project creation. Setup verifies the Worker and OpenSandbox infrastructure with a local Responses endpoint. Init installs a candidate tarball in the project directory so the project runs with its own dependencies. Use `murm doctor` for host checks or `npm run doctor -- --smoke` from the project to check its configuration and run a temporary Sandbox probe. [Host requirements and diagnostics](../../docs/architecture/07-run-configuration.md#local-setup-and-doctor)

Set `MURM_SUBAGENTS_MODEL_URL` in the generated `.env` to a streaming Responses endpoint accepting `k3`, including its `/v1/responses` path. Fill in `MURM_SUBAGENTS_MODEL_TOKEN` if the endpoint requires a bearer token. Set `MURM_SUBAGENTS_LIFECYCLE_TOKEN` if an existing provider requires it. The editable `config.js` reads the same environment for the project and doctor. From the project directory, run `murm` or use `npm start` to resolve the project-local binary. You can also run the entry directly.

```sh
node main.js config.js 'Review the task files and write a short explanation.'
node main.js config.js --interactive
```

In interactive mode, enter a task or a follow-up as a line, use `/status` to inspect the team, and use `/exit` to close the whole run. A Root reply leaves the team available for further input. End of input and host cancellation also close the team. A host can instead supply `config.goal` or use the exported input, reply, status and close methods.

The example config defaults to four live Agents including Root and three child edges. Set `MURM_SUBAGENTS_MAX_AGENTS` and `MURM_SUBAGENTS_MAX_DEPTH` to adjust the limits. Models can be configured as `rootModel` and `childModel` on the host. The default work limit is 120 seconds and cleanup has its own 30-second limit. Set `files` to seed Root, and use a required `collect` specification for files that must be exported. Work directories are private by default. Set `workspace.root` and `workspace.child` to supported Core workspace mounts to enable sharing. Private children can send patches as text to Root.

## Use the packaged example with Codex

The generated template defaults to Pi. To use the packaged Codex example from the installed project, set `MURM_SUBAGENTS_EXECUTOR=codex`, `MURM_SUBAGENTS_MODEL_ID`, and `MURM_SUBAGENTS_MODEL_URL` in the host shell. Set `MURM_SUBAGENTS_IMAGE` to the immutable ID of a Worker built with Codex. The optional `MURM_SUBAGENTS_MODEL_PROVIDER` label defaults to `openai` for Codex. Supply any required model or lifecycle token through the host environment.

```sh
example=node_modules/@murm/core/dist/examples/subagents
node "$example/main.js" "$example/config.js" --interactive
```

The configured `doctor --smoke` path covers Pi projects. The installed Codex example runs through the same local OpenSandbox provider and its own executor. [Codex startup and capabilities](../../docs/architecture/16-pi-opensandbox-backend.md#codex-app-server)

Use `--fork-turns none` when delegating with Codex. Use `swarm service view collaboration` to see the authenticated operations and arguments. A typical pair of calls looks like this.

```sh
swarm collaboration spawn_agent --task-name reviewer --message 'Check the implementation plan' --fork-turns none --request-id reviewer-start
swarm collaboration wait_agent --request-id reviewer-result
```

A plain notice or child result can reach active work or be taken through a wait. Idle members keep the notice for later. Explicit follow-up can start work on the same Agent. Closing exports the configured files and time-stamped Sessions, model requests and Service calls to the private run directory. `harness-report.json` records task and cleanup outcomes.

## Verification

The [Subagents verification guide](../../test/README.md#subagents-verification) describes the regression and native OpenSandbox checks. The [ProgramBench fd experiment](../../docs/experiments/EXP-20261125-10-issue199-fd.md) records a real three-Agent run, including the file handoff, follow-up and independent score.
