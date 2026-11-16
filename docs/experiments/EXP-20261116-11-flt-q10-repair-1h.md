# EXP-20261116-11: FLT10 Q10 after preparation repair, four Core, one-hour maximum

Status: PASS — original Q10 Mission accepted within the one-hour maximum; cleanup verified
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
| Runtime | `7f1f0891f606527c68d3cb1bbda34661fb4b7252`; clean registration-only launch commit `cec5890` (runtime unchanged). |
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

The original Q10 Mission was accepted. Launcher interval:
**2026-11-16 12:24:09.183–12:34:01.895 UTC** (9m52.712s including deployment).
Project interval: **12:26:42.230–12:34:01.148 UTC** (7m18.918s).
Acceptance occurred at **12:33:27.413 UTC**, 6m45.183s after project start and
9m18.230s after launcher start. Successful acceptance ended the run before the
one-hour ceiling; this is not a full hour of sustained load.

| Observable | Result |
|---|---|
| Mission | `solved=true`, `protocol_valid=true`, `made_progress=true`; audit `invalid=false`. |
| Final submission | `submit-q10-complete`, state `accepted`; fixed main `0.13`, commit `4de59b06549e6a2023f492b63e767c117adb8cf7`, tree `97f564a4255908599072b9928bd6796c26d2f39a`. |
| Independent final check | PASS, `treecheck:3effbb07-8aed-4e2b-8359-6cddfdb42b28`; unchanged original imports/statement, fixed FLT source restrictions, original-theorem/type/axiom/kernel verification. |
| Tasks / Executions | 4 Tasks and 4 Bots/Executions. Core 1 finished the main construction Task; three other Tasks remained unfinished when acceptance ended research. |
| Ordinary Judge | 18 admissions/results: 4 PASS, 13 source FAIL, 1 request failure (`forbidden_placeholder`). No cumulative request cap; zero active/queued requests at close. Ordinary PASS remains mathematically unassessed. |
| Coordination | 2 Materials; 0 recorded Material consumptions. The accepted submission selected the main Task's own Material. |
| Model usage | 116 requests, 114 with recorded usage, 2 unknown and 0 pending. Known totals: 4,975,006 input / 19,705 output tokens. Monetary cost unknown; input totals are not unique uncached tokens. |
| Cleanup | 4/4 sandboxes provider-404; peer PIDs absent; 36 checker units settled/inactive with empty cgroups; no executing peer process-group members or pending lifecycle/Judge/final gates. No cleanup errors or unhandled rejections. |

The natural run's claim-to-start times were **3.773, 8.573, 14.350 and
13.036 seconds** for Cores 1–4, respectively, compared with approximately
301 seconds each in the blocked baseline. Separately, a controlled actual HTTP
transfer of the same complete Q10 input took 1.30s (84 files / 11,602,885 bytes,
including the fixed target). These measure different intervals.

## Analysis

**Functional recovery.** All four Cores reached work-phase model calls and
source-level Judge feedback. There was no recurrence of the preparation-driven
watchdog failure. Core 1 completed the proof by reducing to a primitive integer
triple and normalizing parity/sign, retaining the original target statement.
The accepted tree is tied to the final submission above, not inferred from a
passing tool call. The other three Executions have the existing cleanup reason
`benchmark_deadline_cleanup`; here that code followed Mission acceptance, not
the one-hour deadline or a mathematical rejection.

**Parallel work did not establish parallel advantage.** The Agents independently
chose main construction (`c50cd321-a6ed-4dad-81c6-fb257ca64d54`), parity/sign
normalization (`05a3a2da-3504-4148-8dd4-7fa9e0b3132a`), gcd-interface audit
(`19c335d6-d78d-4e03-bca2-82a52b38b7db`) and a well-founded fallback
(`07f60c75-bd59-4ae4-8e4a-bab6a834fa39`). These overlap conceptually: the main
Task reconstructed the normalization and gcd steps while other Cores explored
them separately.

The accepted Material `d4a4d32a-18a6-4c21-8da5-3a597e29a606` was produced by
the main Execution `f5f4b5aa-fc1c-4391-b298-ca3ce39f3792` at 12:32:36.473 and
read by that same Task before submission. The parity Task's Material
`dd699d19-c0ee-4c05-8ef5-b67e3c77d652` was published at 12:33:54.553, after
acceptance. Available Material-read records and Workspace application traces do
not establish another Task's contribution to the accepted proof. Thus this run
shows redundant parallel exploration and a late-sharing risk, not demonstrated
speedup. The measured mean active-Core count of 3.058 / maximum four and 76.45%
Agent-turn occupancy are activity metrics, not productive proof utilization.

**Duration and comparison limits.** Q10 finished too quickly to exercise an
hour of turnover or compaction. Three-minute initial staggering is substantial
relative to the roughly seven-minute project run. There is no matched single
Agent FLT run, so speedup, slowdown and cost efficiency remain unmeasured. The
repair comparison demonstrates removal of a concrete implementation bottleneck;
it does not compare research algorithms.

## Next steps

Q10 has passed the owner-directed Q10-first gate. The separately registered
Q20 observation remains held until the owner’s additional actual-Q20 reference
answer and Agent visibility checks pass. Its planned resources remain the same
repaired runtime, four Cores and 1h maximum. Keep the complete benchmark and existing organization algorithm.
Longer runs, a single-Agent comparison, or a different coordination design are
separate decisions; no such result or approval is implied by this observation.

## Evidence and limitations

The full analyzer completed with exit 0 and wrote local
`experiments/EXP-20261116-11/analysis/experiment-analysis.md`: **full local
evidence**, no inventory parse/integrity warnings. Authoritative evidence is
in `state/projects/flt10_q10_of_counterexample/{project,context,judge,model-budget}.sqlite`,
the fixed Workspace Git commit, Agent/Bridge/Runtime/Service logs and
`analysis/service-cleanup-verification.json`. The `mission_submissions` document
and final admission record identify the exact accepted tree; the report JSON is
a supporting projection. Metadata records clean launch head `cec5890` and the
same runtime/image/checker pins listed above.

Preflight at runtime `7f1f089` passed 649 tests with 16 environment-gated skips;
exact-image tests passed 3/3. A separate zero-model-call real sandbox/CLI/Judge
probe produced source FAIL at revision 0.2 and repaired PASS at 0.3, replayed
both receipt IDs, and verified cleanup. Those diagnostic helper proofs are not
included in the formal run or counted as Q10 research progress. Raw transcripts,
proof source, credentials, private databases and personal paths remain local.
