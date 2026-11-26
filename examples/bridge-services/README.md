# Connect existing Services through Bridge

Copy the example adapters into a TypeScript Harness that depends on `@murm/core`. Register them before calling `createRuntime` and grant each Profile only the operations it needs.

```ts
import { ServiceRegistry } from '@murm/core/services';
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
