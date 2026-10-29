# Issue #87 real-Agent evidence

This record contains only sanitized lifecycle, protocol, and Service metadata.
It does not contain Agent transcripts, proof or candidate contents,
credentials, or raw stdout/stderr.

## Fixed inputs

- Implementation commit executed: `1b1b488c90172b479a203a39293687ee3d020af5`
- Worktree state at launch: clean (`repository_worktree_dirty=false`)
- Experiment: `exp-20261029-issue87-b1-1h-1b1b488`
- Sanitized report: `experiments/exp-20261029-issue87-b1-1h-1b1b488/analysis/runner-report/aggregate-report.json`
- Semantic analysis: `experiments/exp-20261029-issue87-b1-1h-1b1b488/analysis/experiment-analysis.md`
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
was recorded.

## Exact rerun command

The command below reproduces the one-hour acceptance shape. It keeps raw state
under the checkout's ignored `experiments/` directory and writes the report in
the required `analysis/` directory.

```sh
set -a; source .env; set +a
export SWARMENV_MATHLIB_SEARCH_URL=http://127.0.0.1:8890 \
  SWARMENV_IMPLEMENTATION_COMMIT=1b1b488c90172b479a203a39293687ee3d020af5 \
  SWARMENV_WORKTREE_DIRTY=false \
  SWARMENV_WORKTREE_STATUS=clean
timeout 3900s node scripts/run-putnambench-benchmark.mjs \
  --problems config/putnambench-12.json \
  --putnambench-root /home/ubuntu/PutnamBench \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 3600000 --turn-timeout-ms 540000 \
  --parallel-mode semantic --normal-flow \
  --experiment-root experiments \
  --experiment-dir experiments/exp-20261029-issue87-b1-1h-1b1b488 \
  --report-dir experiments/exp-20261029-issue87-b1-1h-1b1b488/analysis/runner-report \
  --observability-host 127.0.0.1 --observability-port 8894
```

## Sanitized result

The run started at `2026-10-29T18:59:08.516Z` and ended at
`2026-10-29T19:59:12.686Z`. It recorded `elapsed_ms=3603051` for a
`timebox_ms=3600000` timebox, `deadline_reached=true`, and
`ended_early=false`. It therefore ran for at least one hour.

- `protocol_valid=true`, `made_progress=true`, `invalid=false`
- `solved=false` (the mathematical problem was not proved in this run)
- `claim_count=18` (`child_claim_count=2`, `root_claim_count=16`)
- `child_task_count=2`, `workspace_write_count=26`
- `material_count=52`, `material_consumption_count=40`
- `meaningful_material_count=27`, `candidate_check_count=0`
- `accept_count=2`, `rework_count=0`, `resume_count=0`
- `tool_error_count=218`; sanitized classes were `CONFLICT`,
  `SERVICE_NOT_FOUND`, `INVALID_CONTRACT`, and `WORKSPACE_INPUT_READ_ONLY`
- `tool_protocol_error_count=0`, `invalid_wait_attempt_count=0`,
  `wait_count=0`, `wake_count=0`
- `heartbeat_count=317`, `watchdog_recovery_count=0`, `watchdog_error_count=0`
- `agent_time_utilization_v0=0.217788`, `mean_active_core_count=0.871153`,
  `ready_work_ms=603277`, `ready_unassigned_ms=125959`
- `raw_transcript_exported=false`, `proof_contents_exported=false`

The run is valid for protocol and orchestration analysis. The semantic
analysis marks the Judge evidence class as empty and is therefore
diagnostic-only for conclusions that require a Judge/CheckResult; it does not
turn that missing class into a claim that no checking occurred.

## Service and Agent-surface evidence

The run registered five Services: `catalog`, `context`, `judge`,
`mathlib-search`, and `task`. The standalone Mathlib service ran over HTTP at
`http://127.0.0.1:8890`; its manifest hash was
`c958a1e3ea1792991b919a15e8e1638b85ac9825673b0ebbafae27818c0f52c9`.

The report's named tool directory included `swarmenv_mathlib_search` and the
role-scoped Task, Context, Workspace, Catalog, and Judge tools. The recorded
named tool set contained 20 names, including four Mathlib Search events. It
contained no `swarmenv_call` event and no wait/wake/parent-review tool event.
Selection used the bounded shortlist and exact-one claim boundary; Bound and
Recovery profiles had no claim capability. The prompt directory included the
Mathlib Search help text and instructed Bound/Recovery Agents to use it before
proof or API research.

The standalone Service Host, Manifest/Registry, HTTP JSON adapter, role-scoped
profiles, and Mathlib Service were exercised by deterministic tests and this
real run. The source-root deployment accepts the `Mathlib` module prefix,
rejects module/path scopes outside the configured project boundary, and
returns typed `INVALID_CONTRACT` errors for those requests.

## Scope and remaining boundary

The benchmark run still constructs its Task, Context, Judge, and Runtime
control plane locally. The current `scripts/service-host.mjs` and Docker
layouts demonstrate independently hosted HTTP Service providers, but the
benchmark has not yet replaced that local controller with a fully remote
Task/Context/Judge persistence and Runtime identity handoff. If Issue #87's
P1 wording is interpreted as requiring that end-to-end control-plane
replacement, that is a follow-up boundary rather than evidence claimed by
this run. The evidence above establishes the Agent-facing Service integration,
role split, user-defined Service registration path, and Mathlib acceptance.

Internal lifecycle compatibility and historical `request_wait`/`WAITING`
records remain available to Runtime and analysis code. They are absent from
the live Agent capability profiles, consistent with ADR 0016's rule that
historical lifecycle records may remain while the normal Agent surface exposes
typed task completion/blocking actions.
