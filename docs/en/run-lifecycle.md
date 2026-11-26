---
title: Anatomy of a Run
description: Follow the real Messages handoff through Runtime assembly, idle Agents, input admission, execution observation, verified artifacts and cleanup.
section: ARCHITECTURE
order: 4
---

A Run begins when your Harness creates a Runtime and ends when it has classified its result and accounted for its resources. The Runtime owns execution and cleanup; the Harness decides which work to submit and how to recognize success.

Follow the [Messages handoff](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts): a writer publishes a random value through a Service, and a reader saves that value to `received.txt`. The host compares the exported file with its original value. [Use the SDK](./sdk.md) provides the installation and run commands. The excerpts here explain the same program's lifecycle.

## 1. Assemble a Runtime

The host first chooses an OpenSandbox backend, registers Services and defines Profiles. The writer Profile permits `messages.put`; the reader permits `messages.get` and declares `received.txt` as a required collected artifact. `createRuntime` validates and snapshots that configuration, creates `outputDir/<runtime.id>/`, and opens the Model Gateway and Service Bridge.

No Agent sandbox exists at this point. The Runtime owns its listeners and records, including cleanup if initialization fails. A backend handle can be claimed by only one Runtime. The Harness can choose a startup Profile or register a new one before creating an Agent. It can also register or retire Services and update per-Agent grants through the [Runtime management API](reference/api.md#runtime-management).

## 2. Observe before dispatching work

The handoff opens `runtime.observe({ signal })` before spawning or sending. A fresh observation contains a current snapshot and an event stream starting immediately after that snapshot's cursor. This avoids a gap between reading the current state and subscribing to later changes.

```ts
const observation = runtime.observe({ signal });
const initialState = observation.snapshot;
```

The host consumes `observation.events` while work proceeds. It can observe new Agent registrations, readiness, input admission, native execution boundaries, Service attempts and cleanup. The stream carries compact status and identity information. Use `onEvent` when you need Agent output text; it exposes `output`, `settled`, `error` and `exit`.

Save the last cursor to resume within the same Runtime using `observe({ after: cursor })`. A resumed subscription returns `snapshot: null`. The Runtime retains 256 updates; if a consumer falls behind, it receives `gap` and the iterator ends. Reopen `observe()` and rebuild the view from a fresh snapshot. The cursor does not survive Runtime recreation. Cancel subscriptions explicitly when they are no longer needed, including after Core closes.

## 3. Create an idle Agent, then send its input

The writer receives a private seeded file containing the key and expected value:

```ts
const writer = await runtime.spawn({
  requestId: 'writer',
  profile: 'writer',
  files: {
    'handoff-input.json': {
      encoding: 'utf8',
      data: JSON.stringify({ key, text: expected }),
    },
  },
});
```

`spawn` registers the Agent ID and reserves a capacity Slot before creating its sandbox. It starts the selected Pi or Codex session, checks readiness and returns an idle Agent. No inference starts until the Harness sends an input. This gives the host time to connect Agent IDs to domain state or message routing.

```ts
const receipt = await runtime.send(
  writer.id,
  `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`,
  { requestId: `input-${key}-put`, mode: 'followUp' },
);
```

The three request identities have different owners:

| Identity | Purpose |
| --- | --- |
| Spawn `requestId` | Reconcile allocation of the same Agent |
| Send `requestId` and returned `inputId` | Reconcile admission of the same input |
| Service `operation_id` | Identify the business operation observed through Bridge |

Replaying an identical spawn or send returns or reconciles its original result. Reusing that request ID with changed arguments conflicts. A timeout does not make an uncertain request a new request.

## 4. Distinguish admission, execution and result

The handoff waits for the input admission and the relevant observations. It confirms the Messages operation using Agent ID, Service ID, operation and operation ID, then confirms that the Agent execution settled successfully. The reader goes through the same sequence before the file is verified at closeout.

| Observation | What it establishes |
| --- | --- |
| `accepted` with `started`, `queued` or `handled` | The executor admitted the input in that way |
| `not-accepted` with `idle` | A conditional input did not wake an idle Agent |
| `unknown` input receipt | Admission cannot yet be confirmed; retain the original call for reconciliation |
| `execution` / `settled` | The Agent's observed execution finished, failed or was aborted |
| Successful Service operation | That identified operation returned successfully through Bridge |
| Exported file matches the expected bytes | The handoff's application result passed its host check |

A settlement does not identify which of several inputs were consumed. Current execution updates use `association: 'unknown'`; input events retain their separate request IDs. The handoff can use settlement as one condition because it exclusively controls each Agent's inputs and checks the specific Service operation and final file. A Harness with multiple input sources must maintain its own task/result protocol.

An accepted or unknown input can keep Agent status at `running` while observed native execution remains `unknown`. A later settlement releases the execution's activity claims and usually returns the Agent to idle. It leaves the session, files and Slot available for further work.

## 5. Choose how to redirect or interrupt work

For a new task after the current execution, use `mode: 'followUp'`. For guidance during execution, use `mode: 'steer'`, which is the default. Pi consumes steering after a tool batch and before its next model request; Codex directs its active native turn. Pi supports explicit `all` and `one-at-a-time` steering modes; Codex supports explicit `all`.

`wakeIfIdle: false` requests delivery only to an active execution. The Worker can decline with `not-accepted` / `idle`, allowing your Harness to retain the notice in its own mailbox. An accepted queue entry crossing a settlement boundary may remain for a later explicit activation. Check the actual receipt rather than predicting admission from an earlier `get()` snapshot.

`interrupt(agentId, { requestId, timeoutMs })` fences the old execution generation, cancels the Agent's pending Bridge calls, asks the Worker to clear queued inputs and abort the active execution, and waits for confirmation. It preserves the container, session, workspace and Slot. Fresh input is rejected while interruption remains unconfirmed. Repeating the same interrupt request reconciles it.

A confirmed interrupt may include `discardedInputHashes`, the SHA-256 digests of discarded queued text. A Harness that stored its submitted payloads can use these to reconcile its own mailbox. They do not reconstruct text or establish per-task completion. The Harness decides whether a discarded item should be queued again under a new request identity. Original accepted receipts continue to describe their original admission.

## 6. Use the file boundary your collaboration requires

The handoff uses private workspaces and a Service for sharing. Other Harnesses can choose different file policies without changing the Runtime's ownership model:

| Pattern | Runtime API | Behavior |
| --- | --- | --- |
| Private directory | `spawn({ files })` | Seeds an isolated project directory; default without an explicit workspace selection |
| Shared live directory | `spawn({ workspace: { id, mode } })` | Attaches a Runtime-scoped project with `read-only` or `read-write` access |
| Frozen copy | `spawn({ workspace: { mode: 'frozen-copy', files } })` | Creates a private directory from a fixed `FileSeed` |
| Read-only discovery followed by task ownership | `files.prepare()` then `files.grant()` | Stages an empty read-only workspace, then grants write access with the exact prepared handle |
| Consistent capture | `files.snapshot()` | Pauses project writers for a bounded capture; shared mounts require all writers to be fenced |
| Guarded replacement | `files.install()` then `files.confirm()` | Replaces a writable private directory only when it still matches the expected snapshot, and keeps writers paused until confirmation |

The file APIs operate on trusted workspace access. They do not decide who owns a task or whether a result should be published; the Harness or Service commits that domain decision. See [API reference](./reference/api.md#controlled-file-primitives-runtimefiles) for limits and replay behavior.

## 7. Classify the result and finalize the Run

The handoff stops its observer, classifies `business` as completed, failed or cancelled, and calls `finalizeRun`. The finalizer calls `runtime.close` and receives the cleanup evidence used by the artifact verifier. The verifier locates the reader's exported directory through `receipt.agents` and compares `received.txt` with the original bytes.

Before starting closeout, stop Harness timers and external feeds that could dispatch new work. If Agents share a writable directory, establish a consistent export point by stopping the other writers and checking their `execution: 'stopped'` receipts before collecting from the remaining owner.

Core cleanup has these ordering guarantees:

1. `close` rejects fresh work and starts cleanup for every registered Agent, including startup still in flight. Endpoint shutdown proceeds concurrently with Agent cleanup.
2. Each Agent follows **confirm execution stopped → archive native session → export declared artifacts → delete sandbox**. Required archive or export failures prevent sandbox deletion.
3. Core closes the backend after all Agent cleanup is complete, flushes evidence and traces, and writes `runtime.json`. The receipt records anything still pending.
4. `finalizeRun` attempts application artifact verification when a Core receipt is available. It closes application-owned facilities only after Core cleanup is complete, then saves `run-finalization.json`.

A `StopReceipt` separates `execution: 'stopped' | 'unknown'` from `cleanup: 'complete' | 'pending'`. A `CloseReceipt` aggregates those per-Agent receipts under `agents`, and includes overall cleanup, pending resources and evidence progress. There is no top-level `execution` field on `CloseReceipt`.

A required export failure keeps the sandbox available for recovery. Repeating `stop` or `close` joins ongoing work or retries unfinished stages. A pending receipt can also refer to a listener, trace or report, so inspect `pending[].kind` and `action`. It does not always mean a sandbox still exists. `finalizeRun` itself is called once per Runtime object; use the original Runtime and facility handles to reconcile pending work.

## Agent lifecycle and capacity

| Status | Meaning for the Harness |
| --- | --- |
| `starting` | Agent identity and Slot are reserved; allocation/readiness is in progress |
| `idle` | Session is ready and can receive input; its Slot stays reserved |
| `running` | Native execution or unresolved input activity exists |
| `exited` | The executor exited unexpectedly; cleanup is still owned by Runtime |
| `closing` | Cleanup is underway or awaiting confirmation |
| `closed` | Sandbox deletion is confirmed and the Slot is released |

A fatal Agent error fences new authority before subscribers are notified. An unexpected exit revokes credentials, but it does not release capacity by itself. The host can still inspect the Agent with `get` or `list` and use `stop` or `close` to finish cleanup. Stopping a parent does not automatically stop its children; Runtime close covers every registered Agent.

The [SDK guide](./sdk.md) brings these steps together in the runnable example. [Build Your Own Harness](./build-your-harness.md) shows how to replace the handoff policy with your own coordination mechanism.
