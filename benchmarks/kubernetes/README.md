# Kubernetes capacity workload

This is the same executable for 2, 8, 32, 128 and 1,024 actual Sandbox Workers running Pi 1.3.0, through the public SDK, on at least two independently identified worker VMs. All tiers are **not-run** until explicitly approved and executed. The controlled Responses service supplies fixed tool instructions; this measures the stated workload and infrastructure, rather than model quality. No paid model endpoint is used.

Build normally, copy `manifest.example.json` to a private location, and replace every placeholder. Run from the pinned checkout, inside the Runtime's private network and writable persistent directory. The runner itself occupies the stable Runtime Service listener; stop any other application using that port through the approved ownership procedure. The callback Service must keep its ClusterIP, resolve consistently from the Controller, and route to this process. The SDK resolves the trusted callback to one non-loopback IPv4 for exact-port policy; guests keep the original URL. Apply the [deployment profile](../../deploy/opensandbox-kubernetes/README.md) and record its inventory first.

```sh
npm run build
node dist/benchmarks/kubernetes/capacity.js /secure/capacity-manifest.json
node benchmarks/kubernetes/offline-check.mjs
```

The first command invocation only validates parameters, calculates the minimum request/compute budgets and emits `status: not-run` plus `manifestSha256`. It performs no cluster queries or changes. The offline check verifies all five plans and rejects unapproved execution with the command search path disabled.

Request explicit owner approval for that exact manifest hash, tier, cluster, time window and budget. The `authorization` object is excluded from the hash so approval can be attached without changing the reviewed workload. Record the approval reference, expiry, and hash. The owner must approve before an operator supplies the private API key and matching hash, then explicitly invokes `--execute`:

```sh
# Set OPEN_SANDBOX_API_KEY and MURM_CLUSTER_EXECUTION_APPROVAL through the private environment.
node dist/benchmarks/kubernetes/capacity.js /secure/capacity-manifest.json --execute
```

The gate requires `authorization.approved: true`, an approval reference, an expiry covering the entire maximum duration, matching manifest/environment hashes, a clean pinned implementation commit, a digest-pinned Worker, and declared resource and cost ceilings. This is an operator-enforced approval record; the runner cannot authenticate the human author of a JSON file. Never change the manifest or raise ceilings under an earlier approval. Set `budget.hourlyCostUsd` to the entire cluster allocation's hourly cost; a zero requires an explicit existing-resource justification. Infrastructure and private output remain operator responsibilities after the run.

`workerVmEvidencePath` points to a private JSON record with `source`, `verifiedByOwner: true`, and `instances` entries `{nodeName, instanceId, hostType: "vm"}`. Every selected Ready node requires evidence, and at least two distinct instance IDs must exist. The cluster inventory must be less than 24 hours old. Live preflight subtracts existing Pod requests from allocatable CPU and memory and refuses insufficient capacity. Physical placement and billing evidence require independent operator verification.

Each Agent writes a seed-derived file through a real Pi bash tool, hashes the resulting bytes, publishes the digest through the authorized `capacity` Service, reads and checks a peer's preceding result, and produces independently checked proof. Two complete rounds precede measurement. The 8/32 tiers maintain active work for 15 minutes, 128 for 30 minutes, and 1,024 for at least 60 minutes. Each live Agent must finish work within each one-minute window. The 32 tier repeats creation, two work rounds, export and cleanup for three waves. The 2 tier still includes two rounds, Service handoff, file export and cleanup.

After warmup, there are at least 100 accepted samples for `send`, `steer`, `followUp` and `interrupt`, and 1,000 Worker event probes. Samples use Controller monotonic time; control samples include method queueing and authoritative Worker acknowledgement. Event probes use the ordinary Worker event channel and durable cursor; the measure is roundtrip latency, a conservative bound on event observation. Errors, unknown receipts and timeouts fail the run. The report records sample counts, failure rates, nearest-rank p50/p95/p99/max; control p95 must be below one second and event p95 below two seconds. Input completion errors also fail the workload without double-counting an already accepted control receipt.

Creation, input work and exports use bounded concurrency. Each Pod requires declared CPU/memory requests and finite limits for Worker and egress containers. Actual Pod UIDs, image IDs, restarts and node assignments are observed independently before and after steady work. Every Agent must stay on the same Pod, with no container restarts, across that interval. Controller RSS, heap, file descriptors, socket descriptors, CPU, event-loop lag, queue depth and active event reads are sampled once per second. Socket descriptors cover the Controller process, including the controlled model fixture. Per-Pod Worker resource peaks remain a capacity acceptance gap. Crossing the approved RSS ceiling aborts work. Model requests, work duration, retention and cleanup each have finite ceilings. Raw inventories, SQLite state and artifacts are written privately under the ignored `experiments/` output directory.

The runner stops Agents through the public SDK, requires verified files and session archives, closes the Runtime, and independently lists OpenSandbox resources, Pods and BatchSandboxes by ownership metadata. The runner also reads each closed Run ledger independently, requires durable stop and deletion evidence for every allocation, and checks every known Sandbox ID against the original Lifecycle endpoint. An empty metadata search cannot compensate for a missing ledger row or a still-present known Sandbox. Any leftover or unavailable reconciliation fails. After cancellation, cleanup has a separate deadline. A failure can leave retained resources and persistent state requiring the documented, ownership-checked maintenance procedure; inspect `result.json` and the private Runtime ledger.

A successful result is `passed-workload` with `capacityClaim: false`. Run the separate [fault verification](#fault-verification) on the same approved deployment. Those tests and their independent final reconciliation remain required for #273 acceptance and for a capacity statement. No tier's current result is implied by a generated plan, rendered manifest, or successful offline check. The result records cost upper bounds from declared rates; provider billing must be reconciled separately.

## Fault verification

For each authorized fault window, allocate a fresh durable Run on the pinned deployment. Record the original Run ID, Worker and Pod identities, input request IDs, event cursors, baseline allocation count, and the stop, lease, and deletion evidence. Pin the fault method, target, restoration action and maximum duration in the approval record. Use only resources listed in that record.

| Injection | Observe before restoring the target |
| --- | --- |
| Controller `SIGKILL` before dispatch and after dispatch with the create response withheld | A pre-dispatch intent has no resource. A possibly dispatched intent occupies capacity until the original Lifecycle lookup resolves. Compare create counts and list every matching page. |
| Close during create, then Controller `SIGKILL` after closing is recorded | A late result remains attached to the original intent. Recovery enters cleanup, preserves old receipts, and rejects new input and Service writes. |
| Lifecycle or gateway interruption | Record the time to resume the original Worker and reconcile the original Sandbox. Show the same Worker instance and input IDs before and after restoration. |
| Concurrent recovery and stale epoch | The original ledger grants one writer. Delayed requests from the old Controller cannot mutate the Worker or resume business writes. A different Controller node or boot is refused. |
| Loss of one worker VM's network with the control plane still reachable | Confirm work continues on the unaffected VM. After an administrative `404`, inspect the original intent and verify that unknown stop still occupies capacity. Restore the original node's network or obtain trusted termination evidence before measuring final cleanup. |
| Real Worker termination or Pod replacement | Compare Worker instance and Pod UID. A different instance cannot resume the old execution or cursor. |
| Lost renewal response and delayed delete | Compare observed Lifecycle expiry before and after the original expiry. A delete acknowledgement alone cannot release capacity. Use the original resource identity for the final query. |
| Required export destination fails, then the closing Controller exits | Check the retained allocation owner, reason and actual expiry. Recover before expiry, retry from the original Run directory, verify file digests, and confirm deletion. |
| Disk, Service, consumer or event backpressure | Record queue, memory and latency before, during and after the fault. Verify old event delivery is either replayed once by cursor or reported as a gap. Pending controls and resources remain visible through recovery. |

The [approved Issue matrix](https://github.com/LuNa-shi/murm/issues/273) specifies the full evidence set. Reuse the local [recovery probe](../../test/core-runtime-recovery-real.test.ts) for its process and receipt checks. The probe itself targets a local OpenSandbox provider. On Kubernetes, use [the recovery contract](../../docs/architecture/24-runtime-recovery.md) with the original callback endpoint, Node, boot and durable Run directory.

After each fault, restore the infrastructure and make a fresh ownership inventory before starting another test. Compare all Run intents and known Sandbox IDs with the original Lifecycle endpoint, Pod UIDs, BatchSandbox inventory and declared persistent resources. Read the ledger after the writer has stopped. A cleaned Run requires zero pending and zero unowned resources. If an export is intentionally retained mid-test, record its owner and actual expiry and complete export and cleanup before closing the test. Keep raw inventories private and include the longest recovery time, peak unresolved allocations and reconciliation result in the reviewed summary.
