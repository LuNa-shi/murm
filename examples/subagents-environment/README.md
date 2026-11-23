# Subagents Environment

One host-created parent delegates two complementary text subproblems to two child Bots through the built-in Bot Service. The host routes child round snapshots and user supplements to the parent. The parent follows up with one original child and integrates three conclusions into a checked JSON text deliverable.

This example requires Node.js 22.19 or newer and the same local Docker OpenSandbox provider and Pi 1.3.0 Worker image as the [Notes example](../notes-environment/README.md). Build and install a tarball in an independent directory:

```sh
repo=/absolute/path/to/SwarmEnv
example_dir=$(mktemp -d)
npm pack "$repo" --pack-destination "$example_dir"
cd "$example_dir"
npm init -y
npm install --omit=dev --ignore-scripts ./swarmenv-core-0.2.0.tgz
for name in main controller prompts config; do
  tar -xOf swarmenv-core-0.2.0.tgz "package/examples/subagents-environment/$name.mjs" > "$name.mjs"
done
tar -xOf swarmenv-core-0.2.0.tgz package/src/environments/shared/run-report.js > run-report.mjs
```

Set `SWARMENV_SUBAGENTS_IMAGE` to the tested immutable Worker image and `SWARMENV_SUBAGENTS_MODEL_URL` to a Responses endpoint ending in `/v1/responses`. Optional host variables use the `SWARMENV_SUBAGENTS_` prefix: `MODEL_TOKEN`, `ADVERTISE_HOST`, `LIFECYCLE_URL`, `ENDPOINT_HOST` and `LIFECYCLE_TOKEN`. Tokens stay on the host. Then run:

```sh
node main.mjs config.mjs
```

The sample uses `kimi_proxy/k3`, three concurrent Slots, one CPU and 1 GiB memory per Bot, 64 MiB and 4,096 project inodes per Bot, 2,048 output tokens per request, a 120-second business wait and a separate 30-second close wait. The parent has `bot.spawn/get/send/stop` and can spawn only the child Profile. Children have no Bot Service grants, parent bindings or parent secret environment. Each Bot owns its native Session, sandbox and work directory. Capacity bounds concurrent children; it is not a lifetime spawn counter. The fixed example retains exactly two child identities until final delivery and rejects a third observed child in the host controller.

The parent uses native Bash commands such as:

```sh
swarm bot spawn --input child.json --request-id child-one
swarm bot get --bot-id CHILD_ID
swarm bot send --input followup.json --request-id child-followup
```

`child.json` is a JSON object with `profile: "child"`, a text `input` and `mode: "followUp"`. `followup.json` has `bot_id`, a text `input` and `mode: "followUp"`. Spawn returns a Bot and an initial input receipt, not the child result. The host queue returns immutable event snapshots as JSON containing `childId`, `eventSeq`, `outcome`, optional `output` and `error`. User `goal` and up to four `supplements` in the host config use that same explicit followUp route. Receipts retain original request and input identities; no route treats the next settled event as completion of a particular parent input. Unknown admission fences further dispatch and ends the example rather than changing IDs and resubmitting.

The final parent output is a JSON object with a nonempty `summary` and three `conclusions`, each containing `childId`, `eventSeq` and a verbatim `quote` from the delivered completed snapshot. Two distinct children and two different rounds from one child are required. This verifies text adoption and provenance, not the truth of the model's explanation. Private file paths do not transfer artifacts; this example does not claim a programming handoff.

`environment-report.json` separates business failure, whole-Runtime cleanup and report-save failure. Its routing section retains parent turns, input admission receipts, undelivered results, child exits, bounded errors and pending jobs. Failed or aborted child rounds remain failures; fatal and unexpected exit without a settled event also produce failure results. A previously reported failure followed by exit, or explicit stop followed by expected exit, does not create a duplicate failure task. Idle children retain Slots until explicit stop or Runtime close. Stopping the parent alone does not close children. Ending the controller stops new dispatch, synchronously calls Runtime close to fence dynamic creation, keeps the listener through close, and drains existing route jobs within the bounded host close wait. Pending execution or cleanup remains visible for operator reconciliation; this one-shot CLI has no cross-process recovery command.
