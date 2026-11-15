# EXP-20261115-03: Four-Core single-project 30-minute validation

Status: BLOCKED (real-model attempt interrupted before 30 minutes)
Approved GitHub Issue: [#122 and owner decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563)
Implementation: `e601e81a2bd17d17299e08d552ecccc93bf28a86`, with architecture clarification `c928e86`.
Repeat of: [EXP-20261115-02](EXP-20261115-02-single-problem-30m.md), stopped before model startup by an incorrectly encoded artifact-lock reference. The corrected configuration uses the existing lock file path and passed actual `createLockedFinalTreeVerifier` validation, including artifact hashes, tool versions and process isolation. The independently health-checked loopback observation service is retained; all research parameters are unchanged.
Comparison: descriptive comparison with [formal24](issue122-formal24-gap-analysis.md); this is not a controlled causal comparison.

## Setup

This run observes the approved Phase 02 behavior with a real model after independent Spec and Standards review. The Mission begins with zero Tasks. Four independent Cores should discover public work, propose bounded responsibilities where needed, take before execution, and continue through publicly saved work and Materials. Existing actionable work has priority over unnecessary proposals. An individual Bot owns at most one Execution. A proposal is not required when appropriate existing work can be taken.

| Item | Fixed value |
|---|---|
| Source | Runtime `e601e81`; launch commit is recorded in `metadata/experiment.json`. Registration and architecture-only commits do not change runtime code. Clean worktree required at launch. |
| Agent image | `swarmenv/agent:issue122-time-e601e81`; `sha256:8bfad88e5c37d02c363d5661e74e103b304ba9fc5677a10821d6a780b205912a`; Pi 1.3.0 |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7` |
| Checker | Lean 4.33.1; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659` |
| Artifact lock | SHA256 `36bdf33550b5364e122b6e345d1c72b72f70e22ea702b834c7e940be744c621f`; existing trusted deployment, unchanged target |
| Provider/model | `gpt_proxy/gpt-6.1-sol`; actual host credentials, per-Bot local gateway tokens, no scripted model responses |
| Prompt/profile/schema | Prompt manifest SHA256 `5f08e742315816a3e6c569fc102c7d5c21f2a1da1a8d0560b222414b98179223`; system text `683af4e09fe2b53ee766fb62bbc04000ed2fb2afe89f9ec00e51e6b933c0c5c5`; Pi catalog `2f7af32c853568f358b7c7fabb66d6992df5fbc727eac777130e1650ed124070`; CLI `8e0485de0eaeca3deb019850009c843c8dc4f0a3fea199e9d960e148b52a52b3`. Actual sent messages remain private evidence. |
| Concurrency/time | 4 Cores, 1 project; Mission 1,800,000 ms including setup, Bot/Execution 600,000 ms, selection 120,000 ms, turn setting 120,000 ms; shared cleanup grace 30,000 ms |
| Model bounds | Time-bounded mode; request limit 120,000 ms intersected with lifecycle deadlines; requested output cap 32,768 tokens. No currency/rate contract; actual cost unknown. No local meter used as a substitute. |
| Isolation | OpenSandbox release-1.2.0, local Docker network allowlist, 100,663,296-byte/8,192-inode per-Bot writable filesystem; coordination grant only `mission_submit` |
| Judge bounds | Unchanged defaults: 20 source admissions / 2 simultaneous, 4 final admissions / 1 simultaneous; source FAIL is distinct from infrastructure failure |
| Deployment configuration | Private nonsecret overlay of locked 12-problem catalog, selected with `--problem`; SHA256 `d168396c96108798a2765afb3167a5ae08868efeece82eb105772a352027836c`. Host-local paths are retained only in private provenance. |
| Evidence | Ignored `experiments/EXP-20261115-03/`; aggregate/project output under ignored `reports/EXP-20261115-03/`; semantic reconstruction under the experiment's `analysis/` |

Invocation, with `DEPLOYMENT_CONFIG` and `PUTNAMBENCH_ROOT` resolved to the verified private local deployment:

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue122-time-e601e81 \
SWARMENV_OPENSANDBOX_URL=http://127.0.0.1:8080 \
SWARMENV_OPENSANDBOX_ENDPOINT_HOST=127.0.0.1 \
SWARMENV_BRIDGE_HOST=172.17.0.1 \
SWARMENV_BRIDGE_PUBLIC_URL='http://172.17.0.1:{port}' \
node scripts/run-putnambench-benchmark.mjs \
  --problems "$DEPLOYMENT_CONFIG" --putnambench-root "$PUTNAMBENCH_ROOT" \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 1800000 --bot-max-ms 600000 --selection-timeout-ms 120000 \
  --execution-timeout-ms 600000 --turn-timeout-ms 120000 \
  --provider gpt_proxy --model gpt-6.1-sol \
  --observability-metadata experiments/.observability/time-bounded-server.json \
  --experiment-dir experiments/EXP-20261115-03 --report-dir reports/EXP-20261115-03
```

Stop at the Mission deadline or trusted Mission acceptance, followed by bounded cleanup; stop and diagnose a systemic authorization, provider, or protocol failure. The follow-on two-hour run is conditional on healthy real-model activity, genuine overlapping Executions rather than merely allocated Cores, meaningful proposal/take/work traces, no unresolved infrastructure failure, and confirmed cleanup. Independent subagents inspect actual content. Solving B1 is reported separately and is not the health gate. Capability paths not triggered are recorded as unobserved, not passed.

## Results

Actual launch was clean commit `8425c589f3f57ec6c51d44833bbc974006105bde`, with the registered `e601e81` runtime and image. CLI metadata starts at 2026-11-15 13:45:06.558 UTC. After trusted deployment verification, four distinct Cores entered UNBOUND discovery concurrently with zero Tasks. Real model/tool traffic occurred, but no proposal was accepted and no Execution was created.

| Core / Bot (unique prefix) | Observed action and result |
|---|---|
| Core 1 / `c2634de6` | Read planning, Workspace and Material guidance, Mission and public Workspace. Three productive model/tool turns were followed by nine local schema rejections. Closed on selection budget. |
| Core 2 / `fe6167b9` | Queried Mission, Workspace, Task and Material interfaces. Two productive tool turns; one upstream request became unknown when selection ended. Closed on selection budget. |
| Core 3 / `51e7c1e8` | Read planning/Workspace guidance, queried public files and Tasks. Three productive tool turns were followed by nine local schema rejections. Closed on selection budget. |
| Core 4 / `dedaaf09` | Five productive tool turns. A multi-state query had invalid encoding; a proposed counting/construction responsibility was rejected because it omitted required `summary`. Later requests received nine schema rejections. Closed on selection budget. |
| Core 1 / `c0719d9b`, Core 3 / `a311402a`, Core 4 / `d8ccf522` | Fresh successor Bots entered selection and each dispatched a request before operator interruption. Their persisted state remains UNBOUND because this runtime lacked graceful signal finalization; it was not rewritten to manufacture completion. |

The model ledger contains 17 admitted upstream attempts: 13 completed with terminal usage, 1 unknown after transport interruption, and 3 still persisted as pending. Observed usage totals 97,114 input and 1,721 output tokens from the 13 completed attempts. Local pre-dispatch 400 rejections are not admitted upstream attempts. Cost is unknown. No Task, Execution, Material publication, Workspace write or Judge check occurred.

The operator stopped the process once repeated schema errors were identified. There is no normal aggregate report, and this attempt did not satisfy the 30-minute protocol. All seven recorded provider resources were independently confirmed HTTP 404; explicit removal of the three still-live resources was recorded separately. Provider listing returned HTTP 200 with zero items. Database terminal state and external cleanup evidence are deliberately distinguished.

## Analysis

Two independent readers found the same concrete transport incompatibility. The real provider returned reasoning items with an empty `content` array. Pi 1.3.0 preserved that object in its signature and replayed it into the next request. The gateway's reasoning allowlist rejected the field. Its prior one-turn Pi test did not exercise provider output returning in the next input. A new two-turn installed-Pi/local-SSE regression reproduced the 400 without external model calls; allowing only absent or empty `content` made the regression pass while nonempty or unknown content remained rejected.

The CLI also exposed incomplete help: public file reads required an actual positional path and `--at`, Task state arrays required JSON, and proposal input required `summary`, `expected_output` and `acceptance_conditions`. Reading help did not give Bots enough syntax to avoid guessing. Exact executable examples were added and exercised through the real authenticated CLI/Bridge path. This repairs the interface contract; it does not instruct the model to manufacture any particular research Task.

The lack of an operator signal shutdown path prevented this failed attempt from producing honest normal finalization. A separate repair routes signals into bounded cleanup and explicit interruption reporting. Independent review examines early initialization and late reporting races before another run.

This attempt proves concurrent discovery and real model access, but supplies no evidence of parallel Task execution, useful Material transfer or mathematical progress. It is not a negative test of the intended collaboration model: the observed interface failures blocked the necessary actions first. The first two registrations also remain distinct startup failures.

## Next steps

Complete independent review of the transport, help and interruption fixes, rerun required checks, rebuild the image and register a new complete 30-minute attempt. Only a healthy completed pilot with independent content review may unlock the already-authorized two-hour run. Keep the same problem, model, fixture and final acceptance condition; finite selection/request limits may be adjusted and recorded before launch to avoid exhausting discovery on a single slow response.

## Evidence and limitations

Private evidence: `metadata/experiment.json`, `state/projects/putnam_2025_b1/{project,model-budget,judge}.sqlite`, per-Core `logs/`, `metadata/operator-stop-bots.json`, `metadata/operator-cleanup.json`, and `analysis/{experiment-analysis,system-observation}.md`. The bot prefixes above are unique within this run; full IDs and timestamps remain in these local stores. Reports do not reproduce conversations, reasoning summaries, proof source or credentials. Pending/unknown requests have unknown upstream completion and cost. HTTP 404 proves scoped resource absence at observation time, not a completed application-level Bot finalization.
