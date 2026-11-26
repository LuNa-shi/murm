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

## 2. Subscribe before dispatching work

Call `runtime.onEvent(listener)` before querying `runtime.state` and `list()`, creating Agents or sending input. Refresh `get/list` after `agentChanged` and read `runtime.state` after `runtimeChanged`. `output` and `settled` can arrive before the send receipt. Get business receipts from your application's Services.

```ts
const unsubscribe = runtime.onEvent(event => {
  if (event.type === 'output') process.stdout.write(event.text);
});
// After observation is finished:
unsubscribe();
```

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
| `settled` | The Agent's observed execution finished, failed or was aborted |
| Successful Service operation | That identified operation returned successfully through Bridge |
| Exported file matches the expected bytes | The handoff's application result passed its host check |

A settlement does not identify which of several inputs were consumed. The handoff can use settlement as one condition because it exclusively controls each Agent's inputs and checks the specific Service operation and final file. A Harness with multiple input sources must maintain its own task/result protocol.

An accepted or unknown input can keep Agent status at `running` while observed native execution remains `unknown`. A later settlement releases the execution's activity claims and usually returns the Agent to idle. It leaves the session, files and Slot available for further work.

## 5. Choose how to redirect or interrupt work

For a new task after the current execution, use `mode: 'followUp'`. For guidance during execution, use `mode: 'steer'`, which is the default. Pi consumes steering after a tool batch and before its next model request; Codex directs its active native turn. Pi supports explicit `all` and `one-at-a-time` steering modes; Codex supports explicit `all`.

`wakeIfIdle: false` requests delivery only to an active execution. The Worker can decline with `not-accepted` / `idle`, allowing your Harness to retain the notice in its own mailbox. An accepted queue entry crossing a settlement boundary may remain for a later explicit activation. Check the actual receipt rather than predicting admission from an earlier `get()` snapshot.

`interrupt(agentId, { requestId, timeoutMs })` fences the old execution generation, cancels the Agent's pending Bridge calls, asks the Worker to clear queued inputs and abort the active execution, and waits for confirmation. It preserves the container, session, workspace and Slot. Fresh input is rejected while interruption remains unconfirmed. Repeating the same interrupt request reconciles it.

A confirmed interrupt may include `discardedInputHashes`, the SHA-256 digests of discarded queued text. A Harness that stored its submitted payloads can use these to reconcile its own mailbox. They do not reconstruct text or establish per-task completion. The Harness decides whether a discarded item should be queued again under a new request identity. Original accepted receipts continue to describe their original admission.

## 6. Use the file boundary your collaboration requires

Seed a private directory with `spawn({ files })`. You can also create another private directory from a complete `files.snapshot` tree. Attach a shared directory with `spawn({ workspace: { id, mode } })`. Capturing a shared workspace requires quiescing the relevant writers.

For a handoff in the same Agent, the Harness establishes domain ownership, captures the complete directory digest and calls `files.replace` once. The same operation can enable writes after successful installation. Writers resume before completion is reported. Reconcile uncertain delivery under the original request identity. If a Workspace Service knows the files changed and its business commit fails, it completes the business commit without replacing the files again.

## 7. Check the result and close the Run

Stop dispatching work and call `runtime.close({ timeoutMs })`. For each Agent, Core confirms execution stop, archives the Session, collects declared files and deletes the sandbox. Failed required exports keep the sandbox and Slot. Retrying `stop` or `close` on the same Runtime can recover unfinished cleanup.

A `StopReceipt` separates `execution: 'stopped' | 'unknown'` from `cleanup: 'complete' | 'pending'`. A `CloseReceipt` aggregates Agent receipts and identifies unfinished Runtime endpoints and reports. The application uses the receipt to locate exported files, verifies the handoff bytes and closes any facilities it owns.

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
