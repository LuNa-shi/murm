# EXP-20261115-01: Four-Core single-project 30-minute validation

Status: BLOCKED (startup only)
Approved GitHub Issue: [#122 and owner decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6895020563)
Implementation: `e601e81a2bd17d17299e08d552ecccc93bf28a86`, with architecture clarification `c928e86`.
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
| Deployment configuration | Private nonsecret overlay of locked 12-problem catalog, selected with `--problem`; SHA256 `0a52afcd81802e92e30e5007434754872af09805bfb5595fee5d3dfc96c18219`. Host-local paths are retained only in private provenance. |
| Evidence | Ignored `experiments/EXP-20261115-01/`; aggregate/project output under ignored `reports/EXP-20261115-01/`; semantic reconstruction under the experiment's `analysis/` |

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
  --experiment-dir experiments/EXP-20261115-01 --report-dir reports/EXP-20261115-01
```

Stop at the Mission deadline or trusted Mission acceptance, followed by bounded cleanup; stop and diagnose a systemic authorization, provider, or protocol failure. The follow-on two-hour run is conditional on healthy real-model activity, genuine overlapping Executions rather than merely allocated Cores, meaningful proposal/take/work traces, no unresolved infrastructure failure, and confirmed cleanup. Independent subagents inspect actual content. Solving B1 is reported separately and is not the health gate. Capability paths not triggered are recorded as unobserved, not passed.

## Results

The CLI exited before project setup because its default observation daemon could not become healthy. The experiment contains metadata and closed private-audit markers but no project state, Bot, Execution or model ledger. No model request was made by this run. There is no aggregate report and no 30-minute behavior evidence. The default port 8787 was occupied by an existing listener; old metadata did not match the current authentication contract. A separately started loopback service on an automatically allocated port passed the actual health check.

## Analysis

This single problem and single run can establish observed behavior and diagnose failures. It cannot establish general collaboration benefits. Fixed source checks, controlled integration evidence and real-model behavior remain separate.

## Next steps

Repeat under EXP-20261115-02 using the verified loopback observation service. Preserve this aborted registration and its metadata; do not reuse this ID or count its elapsed startup as the requested 30 minutes.

## Evidence and limitations

Keep raw conversations, proof/candidate source, stdout/stderr, credentials, private databases and private paths outside this report. Unknown provider-side billing and retries remain unknown; observed terminal token usage is not a verified invoice. Versioned prompt templates describe repository-controlled input, not hidden provider context.
