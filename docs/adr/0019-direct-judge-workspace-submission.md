# ADR 0019: Direct Workspace Submission to Judge

## Status

Accepted for Issue #117; the direct Bridge → Registry → Judge ownership decision remains. Its original command names and live-file input contract below are historical. Issues [#122](https://github.com/LuNa-shi/SwarmEnv/issues/122) and [#127](https://github.com/LuNa-shi/SwarmEnv/issues/127) superseded them for registered Bots with `swarm judge check --revision R [--path P]`, immutable public Workspace input and optional whole-project compilation. See [current Services](../architecture/04-services.md#the-as-built-submission-route); standalone HTTP hosting still requires the lifecycle authority described there.

## Decision

`judge.submit_candidate` is an Agent-facing Judge Service capability. The Agent submits a relative path in the current Execution Workspace together with the Workspace revision and optional content hash. Services Bridge reads the file through the Runtime Workspace boundary and sends Judge an internal source descriptor and attestation; the Registry then routes the request directly to Judge in both in-process and hosted deployments.

Judge owns source validation, checker binding, preflight, checker execution, idempotency, CheckResult persistence, and bounded diagnostic projection. The source attestation binds task, execution, path, revision, and content hash to the authenticated envelope. The transport operation id is the default request key, so replaying it with changed source content returns a conflict.

Task Service and Benchmark Runner are not submission handlers. Task completion may explicitly consume a Judge CheckResult later; that projection is a separate operation and a Judge PASS does not automatically complete a Task or Mission. Candidate Material remains available for collaboration but is not required for a direct Workspace check.

## Consequences

- The Agent-facing check path is `Bridge → Registry → Judge → Workspace source → checker → CheckResult`.
- Hosted Judge providers receive the same trusted fixture configuration and source attestation contract as in-process providers.
- Benchmark reports observe direct Judge results; they do not depend on Runner callbacks or Task candidate relays.
- Workspace and checker binding failures remain distinct from mathematical source failures.
