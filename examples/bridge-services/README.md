# Connect existing Services through Bridge

## Run from your project

```sh
cd my-project
murm --harness messages --prompt "Inspect this project and explain how to verify it"
```

The writer publishes a project observation to the Messages Service. The reader verifies it against the project and saves the exact transmitted text. Existing authenticated HTTP Services can be supplied in configuration.

After installing the built tarball, configure the model route, compatible Worker image and other runtime resources described below. A JavaScript config can also be supplied with `--config`. The common command saves its outputs outside the input directory by default.


Two Agents exchange a value through a Service, and the host verifies the exported file independently. The same TypeScript example imports the Runtime, Sandbox and Service APIs from `@murm/core` in a checkout or an installed project.

## Define and grant a Service

Copy the example adapters into a TypeScript Harness that depends on `@murm/core`. Register them before calling `createRuntime` and grant each Profile only the operations it needs.

```ts
import { ServiceRegistry } from '@murm/core';
import { createMessageService } from './messages.js';
import { createGhIssuesService } from './gh-issues.js';

const services = new ServiceRegistry();
services.registerService(createMessageService());
services.registerService(createGhIssuesService({
  repository: 'OWNER/REPO',
  token: process.env.GH_TOKEN!,
}));
```

Give one Agent `{ messages: ['put'] }` and another `{ messages: ['get'] }` in their respective `Profile.services`. The writer can publish a message and the reader can read it with the same key.

```sh
printf '%s' '{"key":"review","text":"Ready to check"}' | swarm messages put --stdin --request-id publish-review
printf '%s' '{"key":"review"}' | swarm messages get --stdin --request-id read-review
```

For an existing HTTP JSON v2 service, register `createMessageService({ url, token })` instead. The adapter uses the host-supplied bearer token and sends `POST /v2/put` and `POST /v2/get` relative to the URL. The service authenticates the application and receives `{ input, envelope, caller }`. It returns `{ ok: true, result }` for a successful operation. The operation ID travels in `envelope.operation_id` and the `Idempotency-Key` header. A write whose reply is lost can have taken effect. Use the original operation identity to inspect the service's state before retrying. The remote instance stays reachable after Runtime close. An adapter for a different native protocol can implement the same `ServiceAdapter.invoke` interface.

For the GitHub example, install `gh` on the application host and supply a credential with read access to the configured `github.com` repository. Add `{ github: ['list_issues'] }` to the authorized Agent's Profile. The Agent sends the repository and limit through Bridge.

```sh
printf '%s' '{"repository":"OWNER/REPO","limit":5}' | swarm github list_issues --stdin --request-id read-issues
```

The application invokes `gh issue list` with fixed arguments and an explicit ten-second child timeout. Only the issue numbers and titles are returned. The GitHub credential belongs to the application. A Harness that installs `gh` inside a sandbox supplies that Agent's network access and separate credential directly.

## Run the TypeScript handoff

The handoff starts two Agents in separate OpenSandbox sandboxes on one Linux host. The writer publishes a value from its seeded file through the Messages Service. The reader retrieves it and writes `received.txt`. The host verifies the exported bytes against the value it seeded.

Prepare local Docker, the OpenSandbox Lifecycle API, a compatible murm Worker image with `jq`, and an OpenAI Responses-compatible model endpoint. Use Node.js 22.19 or newer. Set these values for your environment before running either recipe.

```sh
export MURM_SDK_IMAGE='worker-image'
export MURM_SDK_MODEL_URL='full-responses-endpoint'
export MURM_SDK_MODEL_TOKEN='token-if-required'
```

The same-host defaults are `http://127.0.0.1:8080/v1` for the Lifecycle API and `172.17.0.1` as the Worker-visible host. Override them with `MURM_SDK_LIFECYCLE_URL` and `MURM_SDK_ADVERTISE_HOST`. Set `MURM_SDK_ENDPOINT_HOST` if the Worker endpoint uses a different host from `127.0.0.1` and `MURM_SDK_LIFECYCLE_TOKEN` if the API requires a key. Pi defaults to `kimi_proxy/k3`. For Codex, set `MURM_SDK_EXECUTOR=codex` and provide `MURM_SDK_MODEL_ID`; the provider defaults to `openai`. You can set `MURM_SDK_MODEL_PROVIDER` and `MURM_SDK_MODEL_ID` for either executor.

From a checkout:

```sh
npm ci
npm run build
node dist/examples/bridge-services/handoff.js
```

The package is currently marked `private: true`; create its tarball with `npm pack` in the prepared checkout. In a fresh directory, install that archive and copy the three TypeScript source files and compiler configuration below. This consumer program does not require a generated project:

```sh
npm init -y
npm pkg set type=module
npm install --save-exact /absolute/path/to/murm-core-0.2.0.tgz
npm install -D typescript @types/node
cp node_modules/@murm/core/examples/bridge-services/{handoff.ts,handoff-config.ts,messages.ts,tsconfig.handoff.json} .
npx tsc --project tsconfig.handoff.json
node build/handoff.js
```

The default Service is in-process. Set `MURM_SDK_MESSAGE_URL` and `MURM_SDK_MESSAGE_TOKEN` for an already-running HTTP JSON v2 Messages Service. The host owns its bearer token, and the Service stays running after the Harness exits.

## Observe completion and inspect the result

The host subscribes through `runtime.onEvent` before submitting work. The Messages adapter records successful calls separately from Agent execution. After `runtime.close`, the example compares the exported reader file byte for byte and records each outcome in `handoff-report.json`.

The CLI emits cursor and event kind on stderr and the final JSON record on stdout. Find the saved report under `./handoff-runs/<runtime-id>/handoff-report.json` or override the root with `MURM_SDK_OUTPUT`. The artifact verification field records whether the host verified the exported file. A failed or cancelled handoff, unverified artifact, pending Core close, or report save failure yields a nonzero exit. The report contains the original cleanup receipt when available. Keep the attempted send request ID if you investigate an uncertain submission.
