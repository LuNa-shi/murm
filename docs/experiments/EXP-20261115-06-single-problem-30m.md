# EXP-20261115-06: Four-Core single-project 30-minute validation

Status: PASS (Mission accepted before the 30-minute maximum)
Approved GitHub Issue: [#122 and owner decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563)
Implementation: `6a256d6d4ed53d7b8281de1fd2f05ff21c28a94b`; independent Spec/Standards review covered renewable model authority, late-heartbeat rejection and production checker memory enforcement before registration.
Repeat of: [EXP-20261115-05](EXP-20261115-05-single-problem-30m.md), rejected before Bot/model activity because its deployment lock still pinned the previous verifier implementation. The regenerated lock changes only the verifier artifact fingerprint. Full locked-verifier validation passed with the same fixture, toolchain and 4 GiB resource guard before this registration. Runtime code and Agent image are unchanged.
Comparison: descriptive comparison with [formal24](issue122-formal24-gap-analysis.md); this is not a controlled causal comparison.

## Setup

This run observes the approved Phase 02 behavior with a real model after independent Spec and Standards review. The Mission begins with zero Tasks. Four independent Cores should discover public work, propose bounded responsibilities where needed, take before execution, and continue through publicly saved work and Materials. Existing actionable work has priority over unnecessary proposals. An individual Bot owns at most one Execution. A proposal is not required when appropriate existing work can be taken.

| Item | Fixed value |
|---|---|
| Source | Runtime `6a256d6`; launch commit is recorded in `metadata/experiment.json`. Registration and architecture-only commits do not change runtime code. Clean worktree required at launch. |
| Agent image | `swarmenv/agent:issue122-stable-6a256d6`; `sha256:c7ae7618ee99433bbac8f3f4e9abedd8b20aa7ddce9134cfbf6760f5fa12a5a7`; Pi 1.3.0 |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7` |
| Checker | Lean 4.33.1; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659` |
| Artifact lock | SHA256 `4286e094c584f324873da37a04ab452946619489f2694f4c3fb15d9da79d7c0a`; regenerated verifier fingerprint; unchanged fixture, dependencies and resource configuration |
| Provider/model | `gpt_proxy/gpt-6.1-sol`; actual host credentials, per-Bot local gateway tokens, no scripted model responses |
| Prompt/profile/schema | Prompt manifest SHA256 `884dfcc526431d8a5d75c0b921a056c83c1359c3f502c9215518f97bc92aa841`; system text `683af4e09fe2b53ee766fb62bbc04000ed2fb2afe89f9ec00e51e6b933c0c5c5`; Pi catalog `2f7af32c853568f358b7c7fabb66d6992df5fbc727eac777130e1650ed124070`; CLI `518de4acc10bf56a875e93bf08eab9fcadb797954042522da44639a0e560dbf4`. Actual sent messages remain private evidence. |
| Concurrency/time | 4 Cores, 1 project; Mission 1,800,000 ms including setup, Bot/Execution 600,000 ms, selection 180,000 ms, turn setting 180,000 ms; shared cleanup grace 30,000 ms |
| Model bounds | Time-bounded mode; request limit 180,000 ms intersected with lifecycle deadlines; requested output cap 32,768 tokens. No currency/rate contract; actual cost unknown. No local meter used as a substitute. |
| Isolation | OpenSandbox release-1.2.0, local Docker network allowlist, 100,663,296-byte/8,192-inode per-Bot writable filesystem; coordination grant only `mission_submit` |
| Judge bounds | Unchanged defaults: 20 source admissions / 2 simultaneous, 4 final admissions / 1 simultaneous; source FAIL is distinct from infrastructure failure |
| Deployment configuration | Private nonsecret overlay of locked 12-problem catalog, selected with `--problem`; SHA256 `eee79495a2e8e955ca79320421506011a66ce142efac3f90845075666cf36ee4`. Host-local paths are retained only in private provenance. |
| Evidence | Ignored `experiments/EXP-20261115-06/`; aggregate/project output under ignored `reports/EXP-20261115-06/`; semantic reconstruction under the experiment's `analysis/` |

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
  --experiment-dir experiments/EXP-20261115-06 --report-dir reports/EXP-20261115-06
```

Stop at the Mission deadline or trusted Mission acceptance, followed by bounded cleanup; stop and diagnose a systemic authorization, provider, or protocol failure. The follow-on two-hour run is conditional on healthy real-model activity, genuine overlapping Executions rather than merely allocated Cores, meaningful proposal/take/work traces, no unresolved infrastructure failure, and confirmed cleanup. Independent subagents inspect actual content. Solving B1 is reported separately and is not the health gate. Capability paths not triggered are recorded as unobserved, not passed.

## Results

Launch commit `72b4487197e075bd66722241dc703d7549ee8ac7`, clean worktree; unchanged runtime `6a256d6`. Actual elapsed **462,488 ms** with cleanup **950 ms**, zero cleanup errors. `protocol_valid=true`, `invalid=false`, `solved=true`. Mission submission `submit-circle-grid` accepted main revision `0.14`, final check `treecheck:eb901a3f-002f-4e39-90db-8ccbcb146c94` at 2026-11-15T14:55:11.977Z.

Four initially empty Core lanes each proposed and took a Task, and all four Executions succeeded. All four Tasks ended DONE. All 12 Bots closed; the independent observer verified every sandbox returned HTTP 404. Ordinary Judge results: 5 PASS, 7 source FAIL and 1 request rejection, zero infrastructure failures, healthy checker. Gateway: 190 requests, all 190 with terminal observed usage, zero unknown or pending; 4,051,044 input and 34,447 output tokens observed, actual currency cost unknown.

This was a successful run within a 30-minute upper bound. It stopped early on Mission acceptance after 7 min 42 s and **does not demonstrate 30-minute endurance**. Detailed per-Bot observations are recorded in the local analysis artifacts and will be consolidated below.

## Analysis

The actual model completed the intended propose/take/execute flow on all four Cores. Source failures led to corrected revisions and fresh successful checks; long requests survived valid lease renewal. Final Mission acceptance, not the helper PASS count, establishes success on the fixed B1 target. Initial work was partly duplicated: two complete proof tracks and two adapter tracks. No durable helper Material consumption was observed, so concurrency and published Materials do not establish useful division of labor or reuse. Successor discovery included justified no-work decisions while complete proof owners were still active or the final check was pending.

## Next steps

After a complete healthy 30-minute run, obtain independent content/lifecycle observations and separately register the authorized two-hour experiment with a finite longer Bot lifetime. Report all incomplete responsibilities, source failures, expected budget rejections and unobserved paths honestly.

## Evidence and limitations

Raw transcripts, reasoning, proof files, logs, credentials, database files and private paths remain in ignored local evidence. Public reporting uses stable IDs, summarized actions and attributed results. Currency cost and upstream retry/billing outcomes remain unknown when not supplied by the provider. Lifecycle cancellation is not proof of upstream cancellation or zero cost. The run deadline includes setup; cleanup has its separate bounded grace.
