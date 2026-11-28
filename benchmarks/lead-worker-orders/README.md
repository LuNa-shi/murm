# Lead–Worker verification and Orders workload

## Fixed-team verification fixture

`main.ts` and `config.ts` retain a deterministic two-stage text-report exercise
for verification. It is separate from the [project example](../../examples/lead-worker/README.md) and requires
`MURM_LEAD_WORKER_RUN`:

```sh
node dist/benchmarks/lead-worker-orders/main.js dist/benchmarks/lead-worker-orders/config.js
```

The remaining sections describe this explicit fixture and its benchmark variants.

## Direction, work and feedback

The default example has three Agents and six exclusive `followUp` inputs: lead initialization; both helper initial turns; one lead turn mediating public feedback plus the user supplement; then both original helper followup turns. The lead has Board announcement/assignment/planning operations. Helpers have read/create/claim/update-own/note/landed/complete operations. All roles may create a PR for their own branch. Profiles expose no built-in Agent operations. Commands use JSON request envelopes and stable request IDs, for example `swarm board claim --input claim.json --request-id helper1-claim`.

The host checks a public direction, both assignments and ready subtasks before any helper input. Each helper must deliver a different verifiable file and a feedback note. The lead must actually read those notes, publish a changed direction referencing both and the trusted user input ID, and create followup work. Both original helpers must read that direction and complete new work. Public Git verification checks the account's own branch head, actual commit/file bytes, length and SHA-256. A later text artifact must contain the exact changed direction; the host records its text hash. This checks concrete text adoption and provenance, not general semantic quality of arbitrary code or the accuracy of the reports.

SQLite `BEGIN IMMEDIATE` transactions serialize claims across connections. A task receives one permanent owner and monotonic revision. Every update supplies the expected revision. Owner fields cannot be submitted by JSON, and Profile checks precede trusted caller/runtime/binding checks. Operation IDs persist exact canonical request/response receipts; conflicting reuse is refused. No claim expires, is released on failure, or moves to a replacement helper. Board records remain readable after the connection closes.

## Runtime bounds and cleanup

The sample config uses one CPU, 1 GiB memory, 64 MiB project storage, 4,096 inodes and 2,048 output tokens per Agent. Set `helperCount` in the config to an integer from 2 to 7 to preconfigure more helpers, and adapt `goal` for that team. Each Agent keeps its own account, Profile and work directory. The workflow has two lead inputs and two inputs per helper, 120 seconds of work, a finite per-turn wait (default 30 seconds, maximum 300), 32 subtasks, 64 notes, 500 business history events (512 including failure evidence) and 512 Service receipts with sixteen MiB total stored responses. It verifies files up to 1 MiB and requires private Git collection up to 64 MiB per Agent. The default host close wait is 30 seconds (maximum 60). These limits describe this fixed example; it has no one-hour or larger-team endurance policy and no global request-count limit beyond configured per-request and work bounds.

Any failed, aborted, unknown or timed-out input fences new Board work and aborts subsequent controller inputs. The original request/input identities and owners remain in the public record. A stop-unknown or required-export-pending receipt keeps the Board and account dependencies alive for reconciliation; complete cleanup closes the SQLite connection and revokes owned Git credentials. Shared Board data, commits and PRs persist. `harness-report.json` separates business failure, cleanup pending and report-save failure, with delivered/uncompleted work and uncertain input records. Core close receipts separately identify execution unknown for each Agent. No automatic claim recovery, replacement or write resubmission occurs.

## Verification

Deterministic verification uses real Core, CLI subprocesses and Bridge authorization, temporary native Git commits/pushes, and a bounded local Git API fixture. The deterministic team-size cases use 3, 4 and 8 Agents. Only native Pi transport and private export are simulated. The opt-in `test/lead-worker-real.test.ts` is prepared for a clean installed package, three native Agents and a single local Gitea facility. Its fixed workload has six inputs, twelve expected Responses (hard all-arrival cap sixteen), a 120-second child limit and one 80-second cleanup budget. A separate exclusive-claim probe remains intentionally unfinished under the winning owner and is reported explicitly. No native acceptance run or upstream-scale/performance result is implied; this fixture requires two independent exact-pin approvals before launch.

## Drive several stages from a host

For a host-managed four-group workload, `createLeadWorkerHarness({ helperCount: 3, ... })` also exposes `runStage`. Call it serially four times: the first input has `{ goal, paths }`, and the later inputs have `{ supplement, paths }`. `paths` maps `helper1`, `helper2` and `helper3` to three new distinct artifact paths for that group. Pass a host `signal` on every call to enforce the outer schedule. The controller retains the original team, requires actual preceding feedback adoption and verifies twelve fixed Git files by the final group. Its receipts preserve accepted Core inputs and settled event identities. The read-only `get(agentId)` supports host monitoring during waits. The caller owns its schedule, resource limits and final cleanup verification. The supplied CLI continues to run the original short two-group workflow.

A host may first call `prepareStages({ signal })` once to obtain four real Core input receipts and actor-specific public Board read/ready-note evidence. This is finite setup and excludes the short workflow; it leaves all four business groups available. All three helpers run concurrently after the lead direction is validated. Setup notes do not count among the twelve business deliverables.


## Dynamic orders mode

Set the optional property below in the configuration passed to the same example CLI. Select the image by its local Docker ID. Store the candidate bundle and Run output in private host evidence storage.

```js
config.dynamic = {
  variant: 'orders-a',
  serviceImage: process.env.MURM_LEAD_WORKER_SERVICE_IMAGE,
  candidatePath: './private-evidence/orders-candidate.json',
};
```

For a single shared 30-minute work deadline, set `workTimeoutMs: 1_800_000` and `turnTimeoutMs: null`. The Run starts its work clock after startup and gives all Agent inputs and final verification the time remaining on that clock. Cleanup has its own bound.

Dynamic mode uses one Lead, two original Workers and a runtime-created checker in the same Board and Git project. The Lead can deploy its own checking program, register the checker Profile, admit the member, and grant or revoke the checking operation on an existing Worker. Assigned Workers can read `spec.md` and `sample.jsonl` from the initial Git project. The final program is evaluated from the Lead's pinned Git commit in fresh containers. The compiled benchmark includes the dynamic entry point, task, starter and independent oracle.

After a successful Run, execute the offline verifier from that package using its saved report and candidate bundle.

```bash
node dist/benchmarks/lead-worker-orders/verify-orders.js <harness-report.json> <orders-candidate.json>
```

The command verifies the frozen candidate and saved cleanup receipts, then reruns the nine independent orders cases. It exits nonzero for a missing or mismatched artifact, incomplete saved cleanup, or a failed case. Full L4 collaboration replay remains a follow-up for [Issue #235](https://github.com/LuNa-shi/murm/issues/235). It must verify grant/revoke, original Worker Session continuity and checker feedback adoption from frozen Run evidence. The [acceptance design](../../docs/designs/dynamic-lead-worker.md) specifies these requirements.

The installed native scripted gate can be run with `MURM_LEAD_WORKER_DYNAMIC_NATIVE_TEST=1` and the immutable `MURM_CORE_TEST_IMAGE` and `MURM_LEAD_WORKER_SERVICE_IMAGE` IDs. Build the Checkout first, then run `node --test dist/test/lead-worker-dynamic-native.test.js`. The gate provisions a fresh private Gitea facility, runs the packaged example at an external installation, and reruns its oracle offline.

The real-model gate is `node --test dist/test/lead-worker-dynamic-model.test.js`. Enable it with `MURM_LEAD_WORKER_DYNAMIC_MODEL_TEST=1` once the provider and resource bounds are approved. Set the two immutable image IDs and `MURM_LEAD_WORKER_DYNAMIC_MODEL_CONFIG` to a host JSON file with `provider`, `model`, `url`, `maxOutputTokens`, `workMs`, `authorization` and `providerAllowance`. The latter two record the approved Run and applicable provider allowance. Use the scoped credential in `MURM_LEAD_WORKER_MODEL_TOKEN`. One invocation makes two independent attempts from the same installed package. The working deadline always applies. Set `requestsPerRun` to also enforce an aggregate request cap. Every admitted attempt counts toward a configured cap even when its provider outcome is unknown. The gate records model use in both modes.
