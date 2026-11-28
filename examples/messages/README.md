# Messages: a custom Service handoff

This small SDK tutorial shows two Agents communicating through a Service. The
writer publishes a project observation; the reader retrieves it, checks the
project and writes the transmitted text to an artifact. The host checks the
exported file independently.

The `messages` CLI alias loads this example. Its purpose is to demonstrate Service
registration, separate Profile permissions, host observation and file handoff.
For the five larger collaboration mechanisms, see [the examples index](../README.md).

## Run against a project

Build the checkout once and prepare the common infrastructure described in
[Quickstart](../../docs/en/quickstart.md). From this example directory:

```sh
node ../../dist/scripts/murm.js --harness messages \
  --cwd /absolute/path/to/project \
  --prompt 'Inspect this project and explain how to verify it'
```

With the current candidate package installed, the same entry is:

```sh
cd my-project
murm --harness messages --prompt 'Inspect this project and explain how to verify it'
```

Set `MURM_MODEL_URL`, optional `MURM_MODEL_TOKEN`, `MURM_MODEL_PROVIDER` and
`MURM_MODEL_ID`, plus the Sandbox/Worker connection when using non-default
infrastructure. Pi defaults to `openai/gpt-5.4`. Select Codex with
`MURM_EXECUTOR=codex` and its model configuration. `--config` can provide a trusted
JavaScript configuration module. The common host stores output outside the input
directory and returns its report path; `--output-dir` chooses another location.

## Define a Service and grant operations

[`messages.ts`](messages.ts) imports the public SDK and exports
`createMessageService`. The default adapter stores messages in the host process:

```ts
import { ServiceRegistry } from '@luna-shi/murm';
import { createMessageService } from './messages.js';

const services = new ServiceRegistry();
services.registerService(createMessageService());
```

Pass the registry to `createRuntime`. Give the writer
`services: { messages: ['put'] }` and the reader
`services: { messages: ['get'] }`. An Agent uses the ordinary `swarm` CLI:

```sh
printf '%s' '{"key":"review","text":"Ready to check"}' \
  | swarm messages put --stdin --request-id publish-review
printf '%s' '{"key":"review"}' \
  | swarm messages get --stdin --request-id read-review
```

The Bridge authenticates each Agent and enforces its declared operations. The
Service owns the shared message state; there is no separate default Service
container to configure.

## Connect an existing HTTP Service

Register `createMessageService({ url, token })`, or set
`MURM_SDK_MESSAGE_URL` and `MURM_SDK_MESSAGE_TOKEN` for this runner. The remote
application must already implement HTTP JSON v2. The adapter sends
`POST /v2/put` and `POST /v2/get` relative to the configured URL with
`{ input, envelope, caller }`, and expects `{ ok: true, result }` on success.

The bearer token belongs to the host. The operation identity travels in
`envelope.operation_id` and the `Idempotency-Key` header. If a write reply is
lost, reconcile using that original identity instead of creating another write.
The external Service remains running after the Harness closes.

## Verify the handoff

[`project.ts`](project.ts) consumes the user's directory and prompt.
[`handoff.ts`](handoff.ts) is a separate fixed-payload diagnostic, invoked from
the checkout root with `node dist/examples/messages/handoff.js`. It seeds a
value in the writer's files, then compares the reader's exported `received.txt`
byte for byte. Its report goes under `handoff-runs/` unless `MURM_SDK_OUTPUT`
overrides it. The common project runner has its own input and report handling.

The host subscribes to Runtime events before sending work. Service call evidence,
Agent execution, independent artifact verification and cleanup are recorded
separately. A failed task, unverified required artifact, pending cleanup or failed
report save produces a nonzero result.

For a second authoring example, see the
[GitHub issues adapter](../services/github-issues/README.md), which wraps a scoped
host CLI. See [Services](../../docs/en/services.md) for the public contract.
