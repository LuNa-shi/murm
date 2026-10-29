# Issue #87 real-Agent evidence

This record contains only sanitized lifecycle, protocol, and service metadata.
It does not contain Agent transcripts, proof contents, credentials, or raw
stdout/stderr.

## Implementation and fixture

- Implementation commit executed: `80a1dbe3abc1d9274cc4fd6ae198066561f1c3cd`
- Worktree state at launch: clean (`repository_worktree_dirty=false`)
- Benchmark project: `putnam_2025_b1`
- PutnamBench commit: `a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Locked B1 fixture source hash: `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`
- Lean project root: `/home/ubuntu/PutnamBench/lean4`
- Lean toolchain: `leanprover/lean4:v4.33.1`
- Mathlib revision: `0df444a360eaa60ab8c11dca51a86af692955474`
- Provider/model: `openai-codex` / `gpt-6.1-sol`
- Cores: `4`; project parallelism: `1`; parallel mode: `semantic`

The real-Agent configuration probe returned `READY_TO_LAUNCH` before the run.
Route variables were loaded from the ignored worktree `.env`; no secret value
was recorded in the report.

## Run command

The following is the exact rerun shape. It relies on the local ignored `.env`
for the provider route and keeps output in the ignored experiment directory.

```sh
set -a; source .env; set +a
export SWARMENV_MATHLIB_SEARCH_URL=http://127.0.0.1:8890 \
  SWARMENV_IMPLEMENTATION_COMMIT=80a1dbe3abc1d9274cc4fd6ae198066561f1c3cd \
  SWARMENV_WORKTREE_DIRTY=false \
  SWARMENV_WORKTREE_STATUS=clean
timeout 3900s node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 3600000 --turn-timeout-ms 540000 \
  --parallel-mode semantic --normal-flow \
  --experiment-root experiments \
  --experiment-dir experiments/issue87-20261029-b1-1h-80a1dbe \
  --report-dir reports/issue87-20261029-b1-1h-80a1dbe \
  --observability-host 127.0.0.1 --observability-port 8894
```

## Sanitized result

The run started at `2026-10-29T16:42:57.989Z` and ended at
`2026-10-29T17:43:01.601Z`. The report records `elapsed_ms=3602785` for a
`deadline_ms=3600000` timebox, `deadline_reached=true`, and
`ended_early=false`. It therefore ran for at least one hour.

The result was valid for analysis and showed real Agent progress:

- `protocol_valid=true`, `made_progress=true`, `invalid=false`
- `claim_count=4` (`child_claim_count=2`, `root_claim_count=2`)
- `material_count=7`, `material_consumption_count=3`
- Progress evidence: `child_task_count=2`, `workspace_write_count=2`,
  `meaningful_material_count=5`
- `accept_count=2`, `rework_count=0`
- `tool_error_count=12`; sanitized error classes were `INVALID_CONTRACT`,
  `CONFLICT`, and `NOT_ALLOWED`, with `tool_protocol_error_count=0`
- `heartbeat_error_count=0`, `watchdog_recovery_count=0`,
  `execution_timeout_error_count=0`
- `raw_transcript_exported=false`, `proof_contents_exported=false`

The mathematical task was not solved (`solved=false`), so this run is evidence
for service registration, role-scoped Agent operation, HTTP integration, and
orchestration progress. It is not a claim of successful Lean proof discovery.

## Service and Agent-surface evidence

The report registered five services: `catalog`, `context`, `judge`,
`mathlib-search`, and `task`. The Mathlib service was independently hosted at
`http://127.0.0.1:8890` during the run; its manifest hash was
`9e3514e8b98dd9c92a1c70083e12e4b19fbf5b2417d2801bdc04937149d7769d`.

The report contains 20 named tool events. `swarmenv_mathlib_search` was called
once through the registered HTTP-backed service. The live profile contained no
`swarmenv_call` event and no wait/wake/parent-review tool event. The allowed
tool directory included the role-scoped names `swarmenv_task_claim`,
`swarmenv_task_complete`, `swarmenv_task_block`,
`swarmenv_judge_submit_candidate`, and `swarmenv_mathlib_search`.

The Selection prompt instructs the selector to use the bounded task shortlist,
claim exactly one selected task through `swarmenv_task_claim`, and never run
bound-task work. A Bound/Recovery prompt receives the task and workspace
contract, uses the named services, and finishes through typed task actions.
The Mathlib capability is included in that directory with its HTTP service
metadata, so a normal bound Agent can discover and call it without a generic
service-call escape hatch.

## Scope and remaining boundary

The standalone service host, manifest/registry, HTTP JSON adapter, role-scoped
profiles, and Mathlib service are implemented and exercised. Built-in service
hosts can be run independently and expose health, readiness, manifest, and
named capability endpoints.

The benchmark run itself still constructs its Task, Context, Judge, and Runtime
control plane locally. The current `scripts/service-host.mjs` demonstrates
independent HTTP providers, but a separate Task/Context/Judge database is not
yet an end-to-end replacement for the benchmark's local controller: remote
Task claim, Runtime binding, shared Context material, and Judge execution need
a shared control-plane adapter and durable identity handoff. This is a P1
follow-up if Issue #87's acceptance means that every built-in control-plane
service must be independently deployed with separate persistence while the
same benchmark controller remains fully remote. The evidence above should be
read as passing the Agent-facing service integration and Mathlib acceptance,
not as evidence that this remaining remote control-plane path is complete.

The repository still contains internal lifecycle compatibility code and
historical `request_wait`/`WAITING` records used by existing Runtime and
analysis paths. Those names are absent from the live Agent tool profile; a
repository-wide removal is a separate migration and is not claimed here.
