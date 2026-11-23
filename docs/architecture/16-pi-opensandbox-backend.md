# Pi / OpenSandbox backend

The Phase 0005 backend is implemented in `src/core/pi-opensandbox-backend.js`. Its public factory creates an opaque, single-Runtime configuration handle. Claiming that handle freezes ownership. Configuration requires the local Docker isolation mode, explicit disk byte/inode limits, HTTP(S) lifecycle and Responses URLs, a Bridge URL containing `{port}`, and concrete non-loopback IPv4 gateway destinations. Creating a handle allocates no sandbox.

## Startup and ownership

The Runtime opens the backend with its own identity, Bridge and model access. The backend keeps one provider manager per Bot, allowing the selected Profile to supply its image. Spawn registers the manager before its first provider request. The provider metadata contains hashed Runtime, Bot and resource identities. The internal manager argument named `executionId` carries the Bot resource key on this path. It does not create a flat Execution.

Spawn creates the sandbox, verifies local Docker identity and installs network isolation, mounts the bounded workspace filesystem, and checks guest Pi version 1.3.0. Credentials come from the host Bridge and model-access objects. The upstream model credential remains behind the host gateway. Root Worker credentials remain outside the Pi environment.

The Worker receives the authenticated `swarmenv-core-v1` startup contract. This contract uses the Profile prompt staged under `/workspace/runtime/profile-prompt.txt` and the existing native `read`, `write`, `edit` and `bash` tools. Extensions, skills, prompt templates and context files are disabled. The empty workDir becomes Bot-owned only when the host requests writable startup. Read-only startup retains the root-owned protected directory. This startup path creates no domain binding or synthetic Task.

After starting Pi, spawn sends a bounded `get_state` request as the readiness check. It supplies no work prompt. It then starts authenticated Worker-history polling. The public Runtime can return an idle Bot and establish application routing before its first send.

## Input and events

Send translates the Runtime input identity into a Pi prompt RPC ID and forwards the explicit input mode as `streamingBehavior`. It performs one transport submission. Service timeout/unavailability returns unknown because Pi may already have received the command. Known Pi rejection throws an error. The Runtime owns input receipt identity and public event numbering.

Polling requests Worker records after the last consumed sequence, with a five-second RPC timeout and a 100 millisecond delay. Prompt response records and polling records share one sequence filter. Assistant message completion supplies output and error information. Worker `agent_settled` produces the execution outcome and current output snapshot. Worker exit records preserve whether stop had been requested. An observed sequence gap emits a fatal error. Transient polling failure emits a retryable error and polling continues while the Bot remains live.

The first implementation does not establish the full continuous-input/in-flight deduplication contract. That contract belongs to #168. Polling provides bounded transport recovery from the Worker's retained history, whose current limit is 2,048 records.

## Stop and destruction

The new backend exposes execution stop and sandbox destruction as distinct internal operations. Stop closes backend input for the Bot, asks the Worker to terminate the Bot process and descendants, and requires an explicit stopped confirmation. The host then stops its polling loop. Worker project closure protects the directory against further Bot writes while the Worker process remains available.

Only backend destruction calls provider resource deletion for this Core path. Provider endpoint/readiness preparation failures retain ownership for the Runtime's cleanup flow. An uncertain startup request retains the authenticated Worker endpoint so stop can still query and terminate possible execution. Deletion uses the existing manager's confirmation request and clears backend ownership after confirmation. Backend close reports a conflict if any Bot resources remain owned.

The manager records uncertain creates and can reconcile them using Runtime labels without a Mission. Foreign Runtime labels prevent resource deletion. A failed or unconfirmed deletion leaves the resource registered for retry. The Runtime owns the user-visible timeout, receipts, model-token revocation and saved Bot state.

File seeds and artifact collection remain rejected pending their lifecycle slices. Additional frozen Profile origins are installed before any model work. Controlled file preparation, grants and export-before-destruction require #170 and #171. Real backend validation and actual model invocation are recorded separately in #166.

## Transitional callers

The existing flat runner continues to use the old adapter and manager contracts during migration. Its Mission labels, versioned swarm/solver prompt resources and deletion callbacks remain executable. A newly created Core Bot uses the generic backend owner exclusively. Both paths reuse the provider manager, network/disk protection and Worker implementation. #183 removes superseded lifecycle entrances after callers have moved.


## Per-Bot resource and network configuration

A manager is constructed separately for each admitted Bot with the backend sandbox settings and that Bot's frozen Profile.image. Its create request sends the selected image and configured CPU/memory limits; a sibling manager cannot substitute its image. The backend generates a fresh Pi session ID and uses a session directory inside the Bot's sandbox. Each Bot has a separate workDir mount whose byte/inode limits are mounted and attested before the Worker launches Pi. Read-only startup leaves that directory protected even though Pi can use its private runtime/session locations.

Network isolation consumes the Bot's frozen origin list per spawn. It validates each destination, deduplicates IP/port pairs with the Bridge/model destinations, sorts them and includes the complete list in the firewall policy digest. The existing Docker label, process/cgroup, namespace and UID-map checks fence the privileged namespace operation; installation and exact firewall readback occur before the Bot can execute work. Rules allow those TCP destinations for the Bot UID and reject every other destination, including IPv6. Runtime-owned Bot labels remain distinct from the Mission labels used by executable legacy callers. The legacy constructor continues rejecting arbitrary global additionalEndpoints; only Core's per-Bot Profile list is supplied on the isolation call.
