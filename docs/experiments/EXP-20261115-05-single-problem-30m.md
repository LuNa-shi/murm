# EXP-20261115-05: Four-Core single-project 30-minute validation

Status: REGISTERED
Approved GitHub Issue: [#122 and owner decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563)
Implementation: `6a256d6d4ed53d7b8281de1fd2f05ff21c28a94b`; independent Spec/Standards review covered renewable model authority, late-heartbeat rejection and production checker memory enforcement before registration.
Repeat of: [EXP-20261115-04](EXP-20261115-04-single-problem-30m.md), which demonstrated four self-proposed/self-taken parallel Executions but was stopped on request-lease and source-checker defects. The new gateway observes timely lease renewal within the original request hard limit and cancels on loss of the same E/fence; Task Service rejects expired renewals. Lean compilation/replay relies on the unchanged physical cgroup memory cap rather than its conflicting internal threshold. Actual full-Mathlib source success/error, isolation, kernel/axiom rejection and B1 placeholder rejection were checked before this run.
Comparison: descriptive comparison with [formal24](issue122-formal24-gap-analysis.md); this is not a controlled causal comparison.

## Setup

This run observes the approved Phase 02 behavior with a real model after independent Spec and Standards review. The Mission begins with zero Tasks. Four independent Cores should discover public work, propose bounded responsibilities where needed, take before execution, and continue through publicly saved work and Materials. Existing actionable work has priority over unnecessary proposals. An individual Bot owns at most one Execution. A proposal is not required when appropriate existing work can be taken.

| Item | Fixed value |
|---|---|
| Source | Runtime `6a256d6`; launch commit is recorded in `metadata/experiment.json`. Registration and architecture-only commits do not change runtime code. Clean worktree required at launch. |
| Agent image | `swarmenv/agent:issue122-stable-6a256d6`; `sha256:c7ae7618ee99433bbac8f3f4e9abedd8b20aa7ddce9134cfbf6760f5fa12a5a7`; Pi 1.3.0 |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7` |
| Checker | Lean 4.33.1; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659` |
| Artifact lock | SHA256 `36bdf33550b5364e122b6e345d1c72b72f70e22ea702b834c7e940be744c621f`; existing trusted deployment, unchanged target |
| Provider/model | `gpt_proxy/gpt-6.1-sol`; actual host credentials, per-Bot local gateway tokens, no scripted model responses |
| Prompt/profile/schema | Prompt manifest SHA256 `884dfcc526431d8a5d75c0b921a056c83c1359c3f502c9215518f97bc92aa841`; system text `683af4e09fe2b53ee766fb62bbc04000ed2fb2afe89f9ec00e51e6b933c0c5c5`; Pi catalog `2f7af32c853568f358b7c7fabb66d6992df5fbc727eac777130e1650ed124070`; CLI `518de4acc10bf56a875e93bf08eab9fcadb797954042522da44639a0e560dbf4`. Actual sent messages remain private evidence. |
| Concurrency/time | 4 Cores, 1 project; Mission 1,800,000 ms including setup, Bot/Execution 600,000 ms, selection 180,000 ms, turn setting 180,000 ms; shared cleanup grace 30,000 ms |
| Model bounds | Time-bounded mode; request limit 180,000 ms intersected with lifecycle deadlines; requested output cap 32,768 tokens. No currency/rate contract; actual cost unknown. No local meter used as a substitute. |
| Isolation | OpenSandbox release-1.2.0, local Docker network allowlist, 100,663,296-byte/8,192-inode per-Bot writable filesystem; coordination grant only `mission_submit` |
| Judge bounds | Unchanged defaults: 20 source admissions / 2 simultaneous, 4 final admissions / 1 simultaneous; source FAIL is distinct from infrastructure failure |
| Deployment configuration | Private nonsecret overlay of locked 12-problem catalog, selected with `--problem`; SHA256 `68da299563d69e5a01c5ec3d09cf47259ab6e2981a8e3cb336d3c200336291d1`. Host-local paths are retained only in private provenance. |
| Evidence | Ignored `experiments/EXP-20261115-05/`; aggregate/project output under ignored `reports/EXP-20261115-05/`; semantic reconstruction under the experiment's `analysis/` |

Invocation, with `DEPLOYMENT_CONFIG` and `PUTNAMBENCH_ROOT` resolved to the verified private local deployment:

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue122-stable-6a256d6 \
SWARMENV_OPENSANDBOX_URL=http://127.0.0.1:8080 \
SWARMENV_OPENSANDBOX_ENDPOINT_HOST=127.0.0.1 \
SWARMENV_BRIDGE_HOST=172.17.0.1 \
SWARMENV_BRIDGE_PUBLIC_URL='http://172.17.0.1:{port}' \
node scripts/run-putnambench-benchmark.mjs \
  --problems "$DEPLOYMENT_CONFIG" --putnambench-root "$PUTNAMBENCH_ROOT" \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 1800000 --bot-max-ms 600000 --selection-timeout-ms 180000 \
  --execution-timeout-ms 600000 --turn-timeout-ms 180000 \
  --provider gpt_proxy --model gpt-6.1-sol \
  --observability-metadata experiments/.observability/time-bounded-server.json \
  --experiment-dir experiments/EXP-20261115-05 --report-dir reports/EXP-20261115-05
```

Stop at the Mission deadline or trusted Mission acceptance, followed by bounded cleanup; stop and diagnose a systemic authorization, provider, or protocol failure. The follow-on two-hour run is conditional on healthy real-model activity, genuine overlapping Executions rather than merely allocated Cores, meaningful proposal/take/work traces, no unresolved infrastructure failure, and confirmed cleanup. Independent subagents inspect actual content. Solving B1 is reported separately and is not the health gate. Capability paths not triggered are recorded as unobserved, not passed.

## Results

Pending final checks and execution. This registration is not a successful experiment result.

## Analysis

The preceding real run established the intended parallel Task creation and ownership pattern but its operational defects prevented a complete pilot. This repeat examines work, public deliveries and succession without those defects. Research outcomes remain separate from protocol validity and an isolated helper compiling is not a Mission proof.

## Next steps

After a complete healthy 30-minute run, obtain independent content/lifecycle observations and separately register the authorized two-hour experiment with a finite longer Bot lifetime. Report all incomplete responsibilities, source failures, expected budget rejections and unobserved paths honestly.

## Evidence and limitations

Raw transcripts, reasoning, proof files, logs, credentials, database files and private paths remain in ignored local evidence. Public reporting uses stable IDs, summarized actions and attributed results. Currency cost and upstream retry/billing outcomes remain unknown when not supplied by the provider. Lifecycle cancellation is not proof of upstream cancellation or zero cost. The run deadline includes setup; cleanup has its separate bounded grace.
