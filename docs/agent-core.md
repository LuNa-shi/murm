# Agent Core and Services SDK

The Runtime starts every real Agent Core through the local NuRouter entry point. `AgentCoreAdapter` builds the stable launch shape

```text
nurouter pi --provider <provider> --model <model> --account <account> --group <group> -- --mode rpc --session-dir <dir> --session-id <execution_id>
```

Provider routing and credentials are Runtime-local configuration. They are never put into Task, Material, CheckResult, or public checkpoint data. The adapter returns a session bound to the Execution ID, collects process output, sends newline-delimited RPC messages, and maps startup, process, and RPC failures to stable error codes.

`createVersionManifest` resolves the stable npm version of `@earendil-works/pi-coding-agent` to an exact version and records it together with the NuRouter version, Node version, and actual launch arguments. A Runtime should create the manifest before starting an Execution and persist it as local runtime metadata; an active Execution must keep using that manifest.

`ServicesSDK` is the Agent-facing boundary. Every modifying method creates an operation envelope containing `operation_id`, `actor_ref`, Task/Execution IDs, spec/state versions, and the execution fencing version. The local service double implements the same envelope, replay, stale-version, fencing, and immutable Material rules while Task Service and Context Service are being added. It intentionally has no Workspace Manager methods. Workspace creation, save, restore, and fencing remain Runtime-internal operations.
