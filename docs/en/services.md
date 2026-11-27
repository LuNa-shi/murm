---
title: Services & Permissions
description: Why murm uses host Services instead of local tools for coordination, how to wrap your own classes or external HTTP backends, and how static and dynamic permissions work.
section: CORE BUILDING BLOCKS
order: 7
---

In `murm`, **Services** are how isolated Sandboxes share state and coordinate. Whether you want a shared findings board, a task pool, a Git collaboration server, or an external verifier, you expose it as a Service and let authorized Agents call it through the `swarm` CLI.

## 1. Why use Services instead of local Agent tools?

An Agent's built-in local tools (`read`, `write`, `edit`, `bash`) are ideal for working inside its own sandbox, but they break down for multi-agent coordination:

- **Sandboxes cannot share state safely**: each container has an isolated filesystem, and injecting shared DB credentials into containers would break isolation.
- **Preventing identity spoofing**: if an Agent passes its own name in tool arguments, a confused or injected model can impersonate a teammate.
- **Built-in audit trail**: every Service call flows through [Host Gateway](gateway.md), which checks identity, permissions, and schemas while logging every call to `service-calls.jsonl` for [Trace Viewer](trace-viewer.md).

In short: **local tools are for solo sandbox work; host Services are for team coordination.**

## 2. In-process Services (write your own class, then register a thin adapter)

Avoid stuffing application logic directly inside giant inline adapter blocks. Write a normal TypeScript class for your domain state first, then connect it to `murm` with a thin registration wrapper.

### Step 1: Write your domain class normally

```ts
// board.ts — plain TypeScript business logic with zero framework coupling
export interface Finding {
  id: number;
  authorId: string;
  topic: string;
  summary: string;
}

export class FindingsBoard {
  private entries: Finding[] = [];

  publish(authorId: string, topic: string, summary: string): Finding {
    const entry = { id: this.entries.length + 1, authorId, topic, summary };
    this.entries.push(entry);
    return entry;
  }

  search(query: string): Finding[] {
    const q = query.trim().toLowerCase();
    return q
      ? this.entries.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q))
      : [...this.entries];
  }

  // Optional: exported automatically on runtime.close()
  exportState() {
    return { total: this.entries.length, entries: this.entries };
  }
}
```

### Step 2: Register a thin Manifest + Adapter wrapper

```ts
import { ServiceRegistry, createInProcessAdapter, type JsonValue } from '@luna-shi/murm';
import { FindingsBoard } from './board.js';

const board = new FindingsBoard();
const services = new ServiceRegistry();

services.registerService({
  manifest: {
    contract_version: '2', // Required protocol constant
    id: 'board', // Unique Service ID ('agent' is reserved)
    title: 'Shared Findings Board',
    purpose: 'Publish and search verified research findings across the team.',
    provider_version: '1.0.0',
    endpoint: { transport: 'in-process' },
    capabilities: [
      {
        name: 'publish',
        operation: 'publish',
        description: 'Publish a verified finding.',
        side_effect: 'write',
        idempotent: false,
        help: { when: 'Sharing a verified discovery with teammates' },
        errors: [],
        input_schema: { /* topic & summary schema — see API Reference or Swarm tutorial */ },
        output_schema: { /* finding object schema */ },
      },
      {
        name: 'search',
        operation: 'search',
        description: 'Search findings published by the team.',
        side_effect: 'read',
        idempotent: true,
        help: { when: 'Checking what peers already discovered' },
        errors: [],
        input_schema: { /* optional query schema */ },
        output_schema: { /* entries array schema */ },
      },
    ],
  },
  adapter: createInProcessAdapter({
    invoke({ capability, input, caller, assertAuthorized }): JsonValue {
      if (capability.operation === 'publish') {
        // Re-check caller authorization right before mutating shared state
        assertAuthorized();
        const { topic, summary } = input as { topic: string; summary: string };
        return board.publish(caller.agentId, topic, summary);
      }
      const { query = '' } = input as { query?: string };
      return { entries: board.search(query) };
    },
    exportState: () => board.exportState(),
  }),
});
```

> Always identify the caller via host-injected `caller.agentId` (or `caller.binding`), never via a name supplied inside `input`. For full manifest fields, see [SDK & API Reference](reference/api.md) or the complete [Swarm tutorial](build-your-harness.md).

## 3. Connecting external HTTP Services (Python, Go, existing backends)

Already have business logic in Python, Go, or a standalone service? You don't need to rewrite it in TypeScript:

1. **Expose simple HTTP `POST` routes on your backend**:
   - One route per operation (defaults to `/v2/<operation>`, or set a custom `path` on each capability).
   - Host Gateway posts `{ "input": {...}, "envelope": {...}, "caller": { "agentId": "...", "profile": "...", "binding": ... } }` with `Authorization: Bearer <token>` and `Idempotency-Key`.
   - Verify the bearer token, run your own logic using the trusted `caller`, and respond with `{ "ok": true, "result": <json> }`.
2. **Mount it on the host in a few lines**:

```ts
import { createHttpJsonAdapter } from '@luna-shi/murm';

services.registerService({
  manifest: {
    contract_version: '2',
    id: 'math-judge',
    title: 'Lean Verifier',
    purpose: 'Verify candidate proofs and update formal status.',
    provider_version: '1.0.0',
    endpoint: { transport: 'http-json', url: 'http://127.0.0.1:9000' },
    capabilities: [/* declared operations and schemas */],
  },
  adapter: createHttpJsonAdapter({ token: process.env.JUDGE_SERVICE_TOKEN }),
});
```

> Your application continues to own starting and stopping external HTTP services; `murm` only forwards authenticated calls and records audit logs.

## 4. Static vs. dynamic Services and permissions

`murm` supports two complementary ways to manage Services and Agent access:

### Pre-registered Services + role allowlists (most common)

- Register Services into `ServiceRegistry` before calling `createRuntime()`.
- Declare least-privilege operations per role in `Profile.services`:
  - `researcher`: `services: { board: ['publish', 'search'] }`
  - `synthesizer`: `services: { board: ['search'] }` (read-only)

### Dynamic Services and live permission updates

When your system needs to add tools or change permissions mid-run:

- **From your Harness host code**:
  - `runtime.services.register(...)` / `retire(...)` — attach a new Service or drain and retire an existing one.
  - `runtime.access.get(agentId)` — inspect what operations a live Agent can call.
  - `runtime.access.grant(...)` / `revoke(...)` — grant (optionally with a new `binding`) or revoke operations on a live Agent without restarting its container.
- **Delegated to a trusted Agent (built-in `agent` Service)**:
  - Every Runtime automatically includes a reserved `agent` Service with child lifecycle operations (`spawn`, `get`, `send`, `stop`) and permission operations (`access_get`, `grant`, `revoke`).
  - All seven operations start denied by default. To let a lead Agent grant or revoke peer permissions, allow the operations in `Profile.services.agent` and supply a synchronous `agentAccessPolicy` guard in `createRuntime()`.

## 5. Calling Services from inside a Sandbox

Regardless of whether a Service runs in-process or over HTTP, Agents use the same `swarm` CLI:

```bash
# Lists only the Services and operations this Agent is authorized to call
swarm service list
swarm service view board --json

# Invoke an authorized operation
swarm board publish --topic cache --summary 'Race condition under concurrent LRU eviction' --request-id note-1
swarm board search --query 'cache' --request-id search-1
```

Because `swarm service list` shows only permitted operations, Agents never waste tokens guessing forbidden tools.

---

**Next:** explore the live zoomable swimlane right in the docs in **[Trace Viewer](trace-viewer.md)**.
