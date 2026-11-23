# Service evidence and Environment reports

This chapter describes the Service observation hook and shared host report helper. Runtime record storage, input/event correlation and resource cleanup are described in [Core Runtime](15-core-runtime.md) and [Pi/OpenSandbox](16-pi-opensandbox-backend.md). Observation does not introduce Service retries, per-input completion guarantees, historical event replay or process recovery.

## Service call observation

`createCoreBridge` accepts the internal optional `recordService(record)` callback. Core supplies a synchronous, nonthrowing enqueue function; its record store owns asynchronous persistence and reports save failures separately. Service invocation does not wait on filesystem IO. Without this hook the existing Bridge request, authorization, invocation and response behavior is unchanged. A callback is trusted host instrumentation and must not throw or return unobserved asynchronous work.

Every row contains only `runtimeId`, `botId`, `profile`, `serviceId`, `operation`, `operationId`, `state`, `outcome` and, when relevant, an error code and retryable flag. Bridge obtains Runtime/Bot/Profile from the authenticated connection, not JSON caller fields. Service and operation come from the request and its registered permission check; operationId preserves the submitted top-level `operation_id`. The selected binding still reaches the adapter for authorization, but does not enter evidence rows. Input/output bodies, bearer credentials, arbitrary error messages and other Services' bindings are absent. Core's record store must also apply its known-secret redaction to IDs and diagnostic fields before publication.

The ordered states distinguish authorization/validation from a potentially executed write:

| State | Outcome | Meaning |
| --- | --- | --- |
| validation | pending | Registry begins validating the named operation |
| validation | passed | Actual JSON input validation passed |
| validation | not_executed | Unknown operation, invalid input, or an authenticated Profile/lifecycle denial prevented invocation |
| invocation | pending | The adapter invocation is being dispatched once |
| settled | succeeded | The adapter returned and the actual output schema passed |
| settled | invalid_output | A read returned invalid output |
| settled | unknown | Invocation failed/timed out, or a write returned invalid output and may already have changed business state |
| settled | not_executed | Caller closure prevented adapter dispatch |
| response | unknown | The authenticated client's HTTP response closed before it finished |

Adapter failures use known Registry error codes or a declared capability code; otherwise the evidence error code is `SERVICE_UNAVAILABLE`. Retryable follows the declared Service error contract when present. The operation's original envelope ID continues into in-process or HTTP adapter dispatch and error details. There is no automatic write retry. A write output violation cannot prove that the write rolled back. An HTTP timeout/response loss cannot prove that the Service did not execute. The `response/unknown` row can precede a later `settled/succeeded` row if the caller disconnects while the adapter finishes; those rows answer different questions and retain the same identity. Conversely, a successful adapter row does not prove the client consumed its receipt.

Discovery remains the existing authorized manifest path; it is not a business adapter invocation. Requests rejected before an authenticated caller and bounded operation identity exist do not invent a trusted Service caller for an evidence row. The hook records the invocations it can identify; it does not claim anonymous requests or token revocation can be mapped to an authenticated business operation.

`getAdapterMetadata(adapter)` is an internal configuration-evidence query. Built-in `createHttpJsonAdapter` records its actual `timeoutMs` (default 30,000; supported positive integer maximum 60,000) and `transport: http-json` in a WeakMap. The frozen descriptor survives Registry's callable snapshot and excludes the token, fetch implementation and endpoint headers. Custom adapters without a registered descriptor return undefined; the caller must not infer a default timeout for arbitrary code.

`core-service-evidence.test.js` observes genuine loopback Bridge traffic for trusted identity, validation denial, a write followed by invalid output, a timeout and a client disconnect followed by successful Service completion. It checks one invocation per explicit request and excludes fixed private body/binding markers from rows. Existing dispatch and HTTP tests continue to verify authorization and input/output contracts. These are deterministic Service/transport checks, not evidence of a native Bot experiment.

## Shared host report helper

Environment modules can import `runWithReport` from `src/environments/shared/run-report.js`. It accepts `createRuntime`, `run`, `outputDir`, optional `closeTimeoutMs` (default 60,000) and optional `redact` (identity by default). Factory/run/redact must be functions; the directory must be a nonempty string and the close wait a positive supported timer integer. The factory is called inside the business try block. `run(runtime)` executes only after a successful factory return. Environment still owns finite business waits, input ordering, cancellation/controllers, result acceptance and external Service cleanup; this helper supplies no scheduler or completion protocol.

The report contains `closeTimeoutMs`, `runtimeId`, `result`, `businessFailure`, `cleanup`, `cleanupFailure` and `reportSaveFailure`. The four failure/result channels remain independent:

1. A factory or business exception becomes businessFailure. Its message and explicit Core context (`code`, operation, Runtime/Bot/request/input IDs, cleanup, reportPath, details, event and receipt) are projected; unrelated object properties are omitted. Factory cleanup=pending produces a separate `FACTORY_CLEANUP_PENDING` cleanupFailure, preserving its Core report location, even though no Runtime object was returned.
2. If a Runtime exists, finally calls close exactly once with the configured timeout. The helper also bounds its own wait, because a host implementation may ignore that option. An unknown/still-pending receipt, including a Bot whose execution is not stopped, becomes `CLEANUP_PENDING`. A thrown close error is preserved separately. A host wait expiry becomes `CLOSE_WAIT_TIMEOUT`; it does not cancel the dispatched close or prove the resource is gone. The Runtime remains the object to inspect/reconcile explicitly. The original business result/error stays intact.
3. The helper chooses the returned Runtime ID, or the factory ResourceError's Runtime ID, for the report directory. Unsupported/path-escaping IDs get a fresh generated directory ID. Each normal Core Runtime has its own unique directory. It applies `redact` to the assembled report, creates the directory with mode 0700, writes a uniquely named temporary file with mode 0600 and exclusive creation, then renames it to `environment-report.json`.
4. Only a confirmed rename returns the host reportPath. A serialization/filesystem/save failure returns `REPORT_SAVE_FAILED` with the projected save error, removes its temporary file when possible, applies redaction again and returns the in-memory report without claiming that a report was saved. It preserves any earlier businessFailure, cleanup and cleanupFailure. Core report paths nested in earlier errors remain diagnostic references and are not confused with this host save result.

The returned reportPath is outside the saved report body; both refer to the same projected result/failure fields. The host must inspect all failure channels and pending receipts before deciding success. A completed model execution, accepted input or clean close alone is not business acceptance.

The caller must supply the run's known-secret redactor when its intentional result/error content can contain configured credentials. The default helper projects error fields and omits arbitrary private properties; it does not discover unknown secrets in model output, business results, Service state or Bot-authored artifact bytes. The `redact` callback is trusted synchronous host policy and must return JSON-compatible data without throwing. Its result is used for both saved and returned report content. Repository code adds no new model prompt through this helper.

`environment-run-report.test.js` verifies factory pending identity, original business plus close failure, a third independent save failure, a hung close's finite host wait, separate Runtime directories and redaction before save/return. The fixtures inject errors into a small host Runtime seam; they do not assert native resource deletion. Physical resource evidence remains the responsibility of the corresponding real backend acceptance and the recorded Core receipts.
