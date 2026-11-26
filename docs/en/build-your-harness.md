---
title: Build Your Own Harness
description: Design coordination Services, role permissions, scheduling, and verification on top of the public murm SDK.
section: BUILD ON MURM
order: 6
---

A Harness is an application built with the SDK. It decides who works, how Agents share information, and what proves that the Run succeeded. Start from the [SDK guide](sdk.md) and the runnable [Messages handoff](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services); this page explains how to change the collaboration mechanism.

Role prompts, Service contracts, and host scheduling can be changed in application code. If the task also needs a new executable, language runtime, or system library inside the Sandbox, provide it in a compatible Worker image.

## 1. Decide what coordinates the work

Choose the shared state and the transitions you intend to enforce before writing prompts:

| Design question | Examples |
| --- | --- |
| Where does shared state live? | Host memory, SQLite, a separate HTTP service, Git, or a chat system |
| How does work acquire an owner? | Parent delegation, an exclusive leased Task, a soft Board claim, or independent exploration |
| What starts the next turn? | A host instruction, a delivered message, a newly available Task, or a periodic reconciliation loop |
| What makes a result usable? | A schema-valid publication, verified revision, passed checker, or exported file check |
| Who decides to stop? | The Harness's completion rule, deadline, cancellation, or exhausted work |

These are substantive mechanism choices. For example, moving from [TaskPool](harnesses/taskpool.md) to [Substrate](harnesses/substrate.md) changes work selection and result discovery, even if both use the same `spawn`, `send`, and cleanup interfaces.

## 2. Implement a Service contract

A Service registration pairs a **v2 manifest** with an adapter. The manifest describes operations, schemas, and side effects. The adapter implements the operations or connects them to an existing endpoint.

Here is the complete [`messages.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/messages.ts) used by the handoff:

```ts
import { createHttpJsonAdapter, createInProcessAdapter, type ServiceRegistration } from '@murm/core';

const key = { type: 'string', minLength: 1, maxLength: 64 };
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const message = { type: 'object', properties: { key, text, author: { type: 'string' } },
  required: ['key', 'text', 'author'], additionalProperties: false };

export function createMessageService(remote?: { url: string; token: string }): ServiceRegistration {
  const manifest: ServiceRegistration['manifest'] = {
    id: 'messages', title: 'Messages', purpose: 'Pass a message to another Agent', provider_version: '1', contract_version: '2',
    endpoint: remote ? { transport: 'http-json', url: remote.url } : { transport: 'in-process' },
    capabilities: [{
      name: 'put', operation: 'put', description: 'Publish a message under a key', side_effect: 'write', idempotent: true,
      help: { when: 'Make a message available to a reader' }, errors: [{ code: 'CONFLICT', retryable: false }],
      input_schema: { type: 'object', properties: { key, text }, required: ['key', 'text'], additionalProperties: false }, output_schema: message,
    }, {
      name: 'get', operation: 'get', description: 'Read a message by key', side_effect: 'read', idempotent: true,
      help: { when: 'Read a message published by another Agent' }, errors: [],
      input_schema: { type: 'object', properties: { key }, required: ['key'], additionalProperties: false },
      output_schema: { anyOf: [message, { type: 'null' }] },
    }],
  };
  if (remote) return { manifest, adapter: createHttpJsonAdapter({ token: remote.token }) };
  const records = new Map<string, { key: string; text: string; author: string }>();
  const adapter = createInProcessAdapter({ invoke({ capability, input, caller, assertAuthorized }) {
    const { key, text } = input as { key: string; text: string };
    const previous = records.get(key);
    if (capability.operation === 'get') return previous ?? null;
    if (previous && (previous.author !== caller.agentId || previous.text !== text)) {
      throw Object.assign(new Error('A different message already uses this key'), { code: 'CONFLICT' });
    }
    assertAuthorized();
    const record = previous ?? { key, text, author: caller.agentId };
    if (!previous) records.set(key, record);
    return record;
  } });
  return { manifest, adapter };
}
```

The example defines a small but explicit coordination rule: the author can repeat the same publication under a key, while another author or different text conflicts. A real task pool would instead define claims, leases, and completion transitions; a research library would define publication and citation rules.

Several details matter when extending the implementation:

- Derive ownership from `caller.agentId`, supplied by the Bridge. Do not trust an Agent-provided author field.
- Implement the promised idempotency in the underlying state. Declaring `idempotent: true` does not add a transaction or retry mechanism.
- Call `assertAuthorized()` immediately before a protected in-process mutation. For asynchronous storage, preserve the authority check and transaction boundary across the write.
- Use strict input and output schemas so failures are visible at the Service boundary.
- Add `exportState()` to an in-process adapter when the Run should save its state at close. Persistence and recovery during the Run remain part of the Service's design.

Register the Service before `createRuntime()`, then grant its operation names in the relevant Profiles. The Runtime captures its Service registry at creation.

### Connect an existing Service

The same `createMessageService({ url, token })` function registers the HTTP variant. It sends `POST /v2/put` and `POST /v2/get` with `{ input, envelope, caller }`, and expects `{ ok: true, result }`. The host supplies authentication and the operation identity through `envelope.operation_id` and the `Idempotency-Key` header. The Agent uses the same CLI commands with either adapter. The adapter sends a bearer token when one is configured. The remote Service must authenticate this host connection before trusting the forwarded `caller`; JSON caller fields alone do not authenticate a request.

Registration does not start or own that remote server. It may live in a separate Docker container, a local process, or an independently operated service. For a different native protocol, implement `ServiceAdapter.invoke` around the existing client; the [GitHub adapter example](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/gh-issues.ts) uses host-side `gh` with a fixed command and timeout.

If a write's result is uncertain, inspect shared state using the original operation identity before submitting more work. Neither an HTTP timeout nor a lost response proves that a write did not occur.

## 3. Give each role only the operations it needs

The writer and reader share a Service but have different authority:

```ts
import type { Profile } from '@murm/core';

export function handoffProfiles(image: string): Record<string, Profile> {
  return {
    writer: {
      prompt: 'Publish the input file through the messages Service.',
      model: 'default', image, writable: true,
      services: { messages: ['put'] },
    },
    reader: {
      prompt: 'Read the messages Service and save the received text.',
      model: 'default', image, writable: true,
      services: { messages: ['get'] },
      collect: {
        paths: ['received.txt'], includeGit: false,
        maxBytes: 4096, required: true,
      },
    },
  };
}
```

The role prompt explains how to use the available operations. The Profile seeds the Agent’s permissions. The Bridge enforces the current grants, which the host can update through [Runtime management](reference/api.md#runtime-management).

For delegation, the built-in `agent` Service provides `spawn`, `get`, `send`, and `stop`; `spawnProfiles` restricts which child roles an Agent may create. Enable `allowContextFork` only when the selected backend supports it. A domain-specific delegation Service can add ownership and mailbox rules, as [Subagents](harnesses/subagents.md) does.

For file sharing, request a shared workspace explicitly through `spawn({ workspace: { id, mode } })`, or use guarded file snapshots and installs. The Harness still owns rules about who may publish or merge a revision. For direct access to an external facility, configure the permitted IPv4 origin and provide a distinct Agent credential through `secretEnv`.

## 4. Choose the control loop

### A serial handoff

Use this when a consumer needs a verified result from a producer. The [Messages implementation](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts) creates an observation before sending input, consumes it concurrently, checks the receipt, and requires both a matching Service operation and completed execution. It then runs the reader and verifies the final artifact during closeout.

This example has one exclusive host input source per Agent. A Harness with concurrent input sources needs its own business identities and reconciliation rules; an execution's `settled` event does not identify all inputs it processed.

### Delegation and mailboxes

Use this when Agents can send messages while recipients are busy or idle. `send({ mode: 'steer', wakeIfIdle: false })` offers a notice without starting a new idle turn. A `not-accepted` receipt with reason `idle` lets the Harness store it in a mailbox for later delivery. An `unknown` receipt requires reconciliation using the original request ID; treating it as a definite rejection can duplicate work.

[Subagents](harnesses/subagents.md) adds parent-child ownership and recursive delegation. [PeerMesh](harnesses/peermesh.md) routes chat and task updates among peers. Follow their complete implementations when adapting event-driven control, including cancellation, delivery errors, and closeout.

### A task pool or research loop

Use this when work allocation or accumulated artifacts drive progress. [TaskPool](harnesses/taskpool.md) reconciles authoritative Task state, leases, and Agent capacity; [Substrate](harnesses/substrate.md) lets peers search and build on publications. The host can use observation updates or a bounded periodic loop to decide when to continue, replace, or stop Agents.

An idle Agent still occupies a Slot. Finishing a Task, finishing an execution, and freeing capacity are separate transitions. Make each transition explicit in your Harness.

## 5. Verify the result and close the Run

Stop dispatching work and call `runtime.close({ timeoutMs })`. Evaluate business, exported artifacts and cleanup independently. Close application-owned facilities after Core cleanup, keeping dependencies available for any pending recovery.


Before broadening a new Harness, verify a small complete Run: expected Service transitions, correct role permissions, real artifact content, and no unaccounted pending resources. Then test the mechanism's defining behavior, such as exclusive claims, cross-Agent reuse, or parent ownership. The existing [Harness guides](harnesses/index.md) describe these distinct behaviors and their boundaries.
