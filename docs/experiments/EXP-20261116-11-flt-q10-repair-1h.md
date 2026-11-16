# EXP-20261116-11: FLT10 Q10 after preparation repair, four Core, one-hour maximum

Status: REGISTERED — pending repaired Q10 preflight; no model run started
Approved GitHub Issue: [#133](https://github.com/LuNa-shi/SwarmEnv/issues/133), including the owner-approved full benchmark migration and first-two-checkpoint 1h observations.
Implementation baseline: PR #132 at `c72430d`; benchmark implementation `7f1f0891f606527c68d3cb1bbda34661fb4b7252`. No PR is merged by this work.

## Setup

Repeat [EXP-20261116-09](EXP-20261116-09-flt-q10-1h.md) after repairing
complete-input transfer, preparation lease renewal and settlement ordering.
The owner directed Q10-first validation and authorized fixes within the current
framework, recorded in [Issue #133](https://github.com/LuNa-shi/SwarmEnv/issues/133#issuecomment-6915835709).
Use four Cores on Q10 only; Q20 remains deferred until Q10 works. The complete ten-checkpoint
benchmark is available, but other checkpoints and longer runs are not in this
initial paid allocation. There is no matched single-Agent FLT run in this study;
prior Putnam timings cannot establish FLT speedup.

| Item | Fixed value |
|---|---|
| Runtime | `7f1f0891f606527c68d3cb1bbda34661fb4b7252`; registration-only launch commit will be recorded in metadata. |
| Fixture | ContextSwarm `3e529ef2cd337a1b829fe280c7360cb3dd95b35c`, `flt10bench-proof-dag-cut-v1`; `flt10_q10_of_counterexample`; source SHA256 `70b457388c35e492ae048993586fcafdae2f0cdaf28b02ca24810d68909f88c4`. |
| Theorem | `FLT10Bench.q10_of_counterexample`; unchanged statement/import prefix, isolated target proof-cone cut. |
| Dependencies | FLT `aa2d8b34692b16c70f699536de0d8e75b9a3e9ef`, Mathlib `db584cd6d46c92f209a44c0f1c829460d327499d`, Lean 4.33.1; Comparator and exporter unchanged from the existing trusted checker. |
| Checker | Artifact lock `386b8f938100b2405ed52c23d8671530932bb91b1a120730d68f96729ce1db80`; source diagnostics plus independent original-theorem/type/axiom/kernel final verification and FLT final-source restrictions. |
| Public context | Manifest SHA256 `4c6507c86ad9799583d61ecb02ed4fd2924619abb2003a9c1b5562fd5299a154`; complete graph with 60,474 modules, compressed queryable shards; only safe definitions enter Lean. |
| Provider/model | `gpt_proxy/gpt-6.1-sol`, unchanged host gateway and revocable Bot credentials. |
| Resources | 4 Cores, project parallelism 1, 3,600,000 ms maximum including project setup; 60,000 ms initial staggering; Bot/Execution 1,800,000 ms; selection 360,000 ms. |
| Judge | No cumulative ordinary request limit; 4 running / 8 waiting / 120,000 ms queue wait; source/merge 180,000 ms; final 300,000 ms, unchanged final admission budget. |
| Isolation | Lightweight OpenSandbox Bot, no local Lean; 96 MiB / 8,192-inode writable quota; existing network limits. Checker 4 GiB / 64 tasks / 2 CPU equivalents. |
| Image | `swarmenv/agent:flt-7f1f089`, `sha256:e39ad9cf89fd22c4a4f7dcccb7287b5a93b3fc45b86269bf9f0d3e7ce6b04d66`, built from committed allowlist. |
| Prompt/schema identity | Generated prompt manifest SHA256 `da1858e46bddec00e3421036e41799713fd9507c00c0a4ae9b6359aa0669cda9`; service catalog SHA256 `951de6a9e5ef0bdfee80f36263b508783256c55f5834b28ed1485e3385983e7b`. Per-Bot actual resource receipts remain in raw evidence. |
| Stop rules | Trusted Mission acceptance plus normal closeout, 1h deadline, startup integrity failure or operator stop. No automatic paid retry or longer allocation. |
| Raw evidence | Ignored `experiments/EXP-20261116-11/`, `reports/EXP-20261116-11/`, and private launch/preflight staging. |

Command uses the existing SwarmEnv CLI and trusted local deployment:

```sh
MATHLIB_SEARCH_SOURCE_ROOT="$FLT_MATHLIB_SOURCE" \
SWARMENV_SANDBOX_ENABLED=true SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:flt-7f1f089 \
node scripts/run-putnambench-benchmark.mjs \
  --problems "$DEPLOYMENT_CONFIG" --benchmark-root "$CONTEXTSWARM_FIXTURE_ROOT" \
  --problem flt10_q10_of_counterexample --cores 4 --project-parallelism 1 \
  --timebox-ms 3600000 --initial-bot-stagger-ms 60000 \
  --bot-max-ms 1800000 --selection-timeout-ms 360000 \
  --execution-timeout-ms 1800000 --checker-timeout-ms 180000 \
  --provider gpt_proxy --model gpt-6.1-sol --observability-port 0 \
  --experiment-dir experiments/EXP-20261116-11 --report-dir reports/EXP-20261116-11
```

The approved local OpenSandbox lifecycle/bridge environment must also be set.
Preflight requires exact-image probes, fixed fixture and lock verification,
independent Workspace-to-Judge repair/replay/cleanup, full tests and review.

## Results

Pending execution. Before launch, verify the exact repaired image, complete Q10
input transfer, source-error/repair feedback through real Workspace/Judge paths,
full tests and independent review. Diagnostic helpers do not solve Q10.

## Analysis

First establish that autonomous Agents reach actual editing, saved revisions,
Judge feedback and continued work. Then observe task decomposition, useful work
overlap, Material reuse and integration cost without treating activity alone as
proof progress. Compare preparation and lifecycle behavior to the blocked
baseline, but do not infer mathematical speedup from that repair comparison.

## Next steps

Complete this bounded Q10 observation before resuming Q20. Diagnose in-framework
implementation failures autonomously, and discuss changes beyond the accepted
framework/design with the owner. A longer duration and a matched single-Agent
study require a separate allocation; neither is part of this run.

## Evidence and limitations

Record the clean launch commit, actual duration, usage and independent cleanup.
Keep natural Agent results separate from zero-model-call controlled probes.
Missing evidence and monetary cost remain unknown. Public reporting excludes
raw conversations, proof/candidate source, credentials and personal paths.
