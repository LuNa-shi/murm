# Subagents Harness

Repository TypeScript sources compile with `npm run build` into `dist/`. `npm pack` builds the distributable JavaScript and declarations before archiving.

Give Root a task. Root looks for independent work it can delegate early, chooses the assignments, and works on a complementary part while the team is active. A Child can delegate again. Team members can send notices, assign more work, wait and interrupt. A Child's result goes to its direct parent.

This example requires Node.js 22.19 or newer and the same local Docker OpenSandbox provider and Pi 1.3.0 Worker image as the [Notes example](../notes-environment/README.md). Build and install a tarball in an independent directory:

```sh
repo=/absolute/path/to/SwarmEnv
example_dir=$(mktemp -d)
npm pack "$repo" --pack-destination "$example_dir"
cd "$example_dir"
npm init -y
npm pkg set type=module
npm install --omit=dev --ignore-scripts ./murm-core-0.2.0.tgz
for name in main controller collaboration-service prompts config; do
  tar -xOf murm-core-0.2.0.tgz "package/dist/examples/subagents/$name.js" > "$name.js"
done
tar -xOf murm-core-0.2.0.tgz package/dist/src/harnesses/shared/run-report.js > run-report.js
```

Set `SWARMENV_SUBAGENTS_IMAGE` to the tested immutable Worker image and `SWARMENV_SUBAGENTS_MODEL_URL` to a Responses endpoint ending in `/v1/responses`. Optional host variables use the `SWARMENV_SUBAGENTS_` prefix: `MODEL_TOKEN`, `ADVERTISE_HOST`, `LIFECYCLE_URL`, `ENDPOINT_HOST` and `LIFECYCLE_TOKEN`. Tokens stay on the host. Then run a one-shot task or open an interactive session.

```sh
node main.js config.js 'Review the task files and write a short explanation.'
node main.js config.js --interactive
```

In interactive mode, enter a task or a follow-up as a line, use `/status` to inspect the team, and use `/exit` to close the whole run. A Root reply leaves the team available for further input. End of input and host cancellation also close the team. A host can instead supply `config.goal` or use the exported input, reply, status and close methods.

The example config defaults to four live Agents including Root and three child edges. Set `SWARMENV_SUBAGENTS_MAX_AGENTS` and `SWARMENV_SUBAGENTS_MAX_DEPTH` to adjust the limits. Models can be configured as `rootModel` and `childModel` on the host. The default work limit is 120 seconds and cleanup has its own 30-second limit. Set `files` to seed Root, and use a required `collect` specification for files that must be exported. Work directories are private by default. Set `workspace.root` and `workspace.child` to supported Core workspace mounts to enable sharing. Private children can send patches as text to Root.

Use `swarm service view collaboration` to see the authenticated operations and arguments. A typical pair of calls looks like this.

```sh
swarm collaboration spawn_agent --task-name reviewer --message 'Check the implementation plan' --fork-turns none --request-id reviewer-start
swarm collaboration wait_agent --request-id reviewer-result
```

A plain notice or child result can reach active work or be taken through a wait. Idle members keep the notice for later. Explicit follow-up can start work on the same Agent. Closing exports the configured files and time-stamped Sessions, model requests and Service calls to the private run directory. `environment-report.json` records task and cleanup outcomes.

## Verification

The [Subagents verification guide](../../test/README.md#subagents-verification) describes the regression and native Pi/OpenSandbox checks. The [ProgramBench fd experiment](../../docs/experiments/EXP-20261125-10-issue199-fd.md) records a real three-Bot run, including the file handoff, follow-up and independent score.
