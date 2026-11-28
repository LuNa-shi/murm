# Read GitHub issues through a Service

This small adapter demonstrates how a Harness connects an existing host
application through the public murm Service API. It is not a collaboration
Harness or a service that every murm installation must deploy.

[`index.ts`](index.ts) exports `createGhIssuesService`. The adapter invokes
`gh issue list` on the host with a fixed repository, bounded result count and
ten-second timeout. It returns only issue numbers and titles.

## Register and grant the capability

Copy `index.ts` into your TypeScript application, install `@luna-shi/murm`, and
install `gh` on the application host. Supply a host token with read access to
the selected repository.

```ts
import { ServiceRegistry } from '@luna-shi/murm';
import { createGhIssuesService } from './index.js';

const services = new ServiceRegistry();
services.registerService(createGhIssuesService({
  repository: 'OWNER/REPO',
  token: process.env.GH_TOKEN!,
}));
```

Pass the registry to `createRuntime` and give an authorized Profile
`services: { github: ['list_issues'] }`. The Agent uses the ordinary CLI:

```sh
printf '%s' '{"repository":"OWNER/REPO","limit":5}' \
  | swarm github list_issues --stdin --request-id read-issues
```

Core checks the Profile's Service grant. The adapter separately checks the
repository and operation, then invokes an argument vector with a limited child
environment. The token remains on the host; the Agent receives only the declared
result. There is no service container to stop and no external facility is deleted
when the Runtime closes.

See the [Messages tutorial](../../messages/README.md) for a complete runnable
Harness that registers a custom Service, and [Services](../../../docs/en/services.md)
for the public authoring contract.
