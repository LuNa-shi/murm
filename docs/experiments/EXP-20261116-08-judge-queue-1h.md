# EXP-20261116-08: Judge queue with four concurrent checks, one-hour maximum

Status: COMPLETE — trusted Mission accepted; protocol valid; ordinary checks exceeded the old cap; no natural queue saturation
Approved GitHub Issue: [#130](https://github.com/LuNa-shi/SwarmEnv/issues/130), owner decision removing ordinary cumulative quotas, adding queue/busy handling, concurrency four, and authorizing a further 1h-limited repeat.
Implementation PR: [#132](https://github.com/LuNa-shi/SwarmEnv/pull/132).
Repeat of: [EXP-20261116-07](EXP-20261116-07-centralized-judge-1h.md). Timing comparison: the approximately 13-minute single-Agent EXP-20261116-05 baseline from independent Issue #129, using aligned metadata-start→trusted-acceptance and first-Execution→acceptance intervals. This is a versioned engineering acceptance repeat, not a controlled causal estimate of queueing or collaboration benefits.

## Setup

Observe autonomous Task proposal/take/finish, development feedback through saved-revision Judge checks, public Workspace/Material reuse, and progress toward the same B1 Mission. Bots have general tools but no local Lean/Lake/Mathlib; Context/Judge run independently. Distinguish source errors, queue waiting, busy rejection, infrastructure failures and final acceptance. No operator-authored research Tasks, candidate solutions or scripted model answers.

| Item | Fixed value |
|---|---|
| Clean runtime | `1c2d5d5825d3511aa47d0964c11f44d107d28da5`; independent Standards/Spec PASS; clean launch commit `0cfca57a0a1c055112700b0c9d839012af466934`. |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. |
| Toolchain | Checker-side Lean 4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Locked whole-project checks and independent original-theorem/axiom/kernel final verification. Artifact-lock digest `776907355aeef05e17ae3ed7803d8246b26522225eb6478c72a5aa02b357da37`. |
| Limits | Four Cores, one project, 3,600,000 ms maximum including project setup; Bot/Execution maxima 1,800,000 ms; selection 360,000 ms; first Bot starts staggered 60,000 ms, replacement Bots do not repeat the stagger. |
| Checks | Ordinary Mission requests **no cumulative limit / 4 concurrent / 8 queued / 120,000 ms maximum queue wait**, process/merge maximum 180,000 ms. Final admissions 4 / concurrent 1, final-check maximum 300,000 ms. Existing separate merge slots and final acceptance policy unchanged. |
| Resource profile | Each checker unit: 4 GiB, no swap, 64 tasks, two CPU equivalents. Sandbox retains existing OpenSandbox limits and 96 MiB / 8,192-inode writable quota. Cleanup grace 30,000 ms. |
| Provider/model | `gpt_proxy/gpt-6.1-sol`; time-bounded gateway, 180,000 ms request cap, revocable Bot credentials. Currency cost remains unknown without trusted usage/rates. |
| Image | `swarmenv/agent:issue130-judge-queue`, immutable ID `sha256:514af3cd1d3891fb8971eb63f27398e8993ba4fd30e0398205847b2ae0d97678`; built from committed runtime allowlist, Pi 1.3.0. General tools present, Lean/Lake/elan absent. |
| Prompt identity | System `7bfee0de07d5cb5e7261d76a59324acb4d19fb249b4277f7cebe3174a8531988`; Workspace skill `5e088f921ee9c5ca86bcd2a2b1543b03999821430d5530b9c257078f2ac4b061`; finish skill `cc3748aa4502013072a030fa84fe13f8cfaa82d6e1ea642661a5b6eeaeeb32a4`; CLI `24e754960f63535169c59752d193fbabba734cd2cc04a3eef64e86172a800bc6`. The lock was regenerated for this worktree: only four repository artifact paths changed; all artifact bytes and source/dependency pins match EXP-07. Other exact profile/schema/resource identities are recorded by launch metadata. |
| Raw evidence | Ignored `experiments/EXP-20261116-08/`, `reports/EXP-20261116-08/` and private preflight/launch logs. Public reporting excludes raw conversations, proof source, credentials and personal paths. |

Before launch require the full test suite, independent Spec/Standards reviews, docs/diff checks, exact-image actual worker and disk-isolation probes, and healthy production independent Judge repair/replay/cleanup. Controlled queue tests cover overflow, timeout, FIFO, lifecycle cancellation and heartbeat renewal. These are engineering checks, separate from the natural Agent behavior to be observed.

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue130-judge-queue \
SWARMENV_OPENSANDBOX_URL=http://127.0.0.1:8080 \
SWARMENV_OPENSANDBOX_ENDPOINT_HOST=127.0.0.1 \
SWARMENV_BRIDGE_HOST=172.17.0.1 \
SWARMENV_BRIDGE_PUBLIC_URL='http://172.17.0.1:{port}' \
node scripts/run-putnambench-benchmark.mjs \
  --problems "$DEPLOYMENT_CONFIG" --putnambench-root "$PUTNAMBENCH_ROOT" \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 3600000 --initial-bot-stagger-ms 60000 \
  --bot-max-ms 1800000 --selection-timeout-ms 360000 \
  --execution-timeout-ms 1800000 --checker-timeout-ms 180000 \
  --provider gpt_proxy --model gpt-6.1-sol --observability-port 0 \
  --experiment-dir experiments/EXP-20261116-08 --report-dir reports/EXP-20261116-08
```

Stop normally at trusted Mission acceptance or the one-hour deadline, followed by bounded cleanup. Stop and diagnose systemic authorization, checker, provider or lifecycle faults; ordinary source errors and temporary capacity rejection remain observations. Do not change budgets, Tasks or proof standards during the run. Successful early acceptance is not a one-hour endurance result. One run does not establish performance across problems or seeds.

## Results

The CLI ran **09:30:59.606–09:52:00.626 UTC** on clean launch `0cfca57a0a1c055112700b0c9d839012af466934`, runtime `1c2d5d5825d3511aa47d0964c11f44d107d28da5`. Trusted acceptance occurred at **09:51:27.706 UTC**, **20m28.100s after metadata start**. The project interval was **09:33:29.786–09:51:59.092**, **18m29.306s**, and includes post-acceptance closeout. These intervals have different boundaries. The run ended normally before the one-hour maximum: **solved=true, protocol_valid=true, invalid=false**, no invalid reasons and no deadline exhaustion. This is not a full-hour endurance result.

Submission `submit-final-01` fixed main revision `0.43`, commit `bb4d4f41c546a8f78de5fac43f9e29ee4d5e9156`, tree `3edd725a8136093e5863c5d36ad2bf7f4e707a96`, and Material `3d4ff6e7-2f9a-4e2d-80f8-63c4f28f6bae`. Locked final theorem/axiom/kernel receipt `treecheck:04a28087-c945-49a4-aa8c-049d470ae61f` returned PASS. Independent audit matched the accepted commit/tree to actual public Workspace HEAD; neither release nor stop remained pending.

| Observation | Recorded result |
|---|---|
| Lifecycle | 11 Tasks: 9 DONE, 2 OPEN. 11 Executions: 9 SUCCEEDED, 2 FAILED during post-acceptance cleanup. All 13 Bots CLOSED. |
| Ordinary Judge policy | No cumulative cap; configured concurrency 4, queue capacity 8, maximum wait 120,000 ms, process timeout 180,000 ms. |
| Ordinary results | **33 admissions: 16 PASS, 15 source failures, 2 selected-file lexical rejections, 0 infrastructure failures**. No quota/busy rejection. 33 preflight starts, 31 source starts, 0 infrastructure retries or cached request aliases. |
| Natural concurrency/queue | Durable active interval peak **3**. Queued admissions **0**, queue peak/wait **0**. This run did not exercise four-running saturation, FIFO waiting or overflow. Those paths have separate controlled HTTP regression evidence. |
| Merge/final paths | 12 merge calls: 7 successful, 4 `MAIN_MOVED`, 1 rejected during submission freeze. One final admission, PASS; separate final policy remained 4 admissions / 1 concurrent. |
| Materials | 12 persisted Materials; two superseded by newer Materials, leaving 10 in the default active projection. 14 consumption records. Actual import/reuse evidence is described below; counts alone do not establish value. |
| Model transport and usage | 289 requests; all received HTTP 200. 288 with terminal usage, 1 unknown usage, 0 pending. **8,744,105 input / 59,020 output tokens** recorded. Currency cost unknown. No upstream HTTP rejection burst occurred. |
| Operational errors | Eight tool errors were handled as main movement, lifecycle/contract rejection or submission freeze; no tool-protocol errors. Zero heartbeat, watchdog, execution-timeout or cleanup errors; no unhandled rejection. |
| Cleanup | Reported physical cleanup **1,378 ms**; independent audit found all 13 scoped Sandboxes GET 404, both independent service processes/groups absent, **65 Judge-owned units** settled/inactive without cgroups, and no pending gates/admissions/checks. |

The last model request began after acceptance and its deadline matched the 30-second post-acceptance boundary. Its unknown terminal usage is consistent with cleanup cancellation; it is not an upstream HTTP error, and unknown tokens/cost are not reported as zero. The two FAILED Executions closed about 31 seconds after acceptance with cleanup reasons, not provider failure or expiry of the one-hour maximum.

Engineering validation on the final runtime: **654 tests / 640 PASS / 14 environment-gated skips / 0 failures**, independent Standards and Spec PASS, actual committed worker image **2/2**, disk/inode/Landlock probe PASS, and real independent Workspace FAIL→repair→PASS/replay/cleanup probe PASS. Full experiment-analysis exited 0, wrote `analysis/experiment-analysis.md`, reconstructed 11 Executions and reported zero inventory warnings.

## Analysis

### Development feedback and actual reuse

The unlimited ordinary policy was exercised beyond the old 20-request cap: requests 21–33 continued normally. CircleBridge Execution `2f56b173` iterated across eight failing saved versions before revision `0.19` / CheckResult `f36eea1b` passed. CircleIntersections `ed6293ed` progressed from `0.13` / `6e838db0` FAIL to `0.17` / `2d8a11e5` PASS. PlaneSimilarity `1392dfde` progressed from `0.14` / `0fab40e0` FAIL to `0.20` / `b986ef95` PASS. These are distinct immutable inputs under the same owning responsibility, not replays counted as new iterations.

Actual source reuse is visible: Execution `98b30fac` imported CircleBridge and GridCounting into AbstractGrid; final integrator `8df7d3e1` imported NormalizedGrid, PlaneSimilarity and the abstract construction into the accepted project. This is stronger than Material-read evidence. Integration also exposed repeated declarations: the integrator and import auditor both modified PlaneSimilarity around 09:46:31 and 09:47:22. The overlap and four main-movement rejections demonstrate coordination work, but do not quantify net wasted time. No repeated creation loop for the same responsibility was established.

The two lexical rejections (`914751f6`, `52b6fb81`) belong to TargetRegression Execution `1644edd2`, revisions `0.41` and `0.42`. The selected-file guard matched the word `axiom` in a block comment, **not an actual axiom declaration or unfinished proof**. Preflight completed but the source process did not start. This is a conservative raw-text guard limitation and an observed false rejection of audit comments; it is not a cheating finding. The unchanged final verification independently accepted the submitted theorem. Altering the trusted checker/guard contract is outside this queue repeat and remains a separate owner decision.

### Comparison with the 13-minute single-Agent baseline

The baseline is independent Issue #129's [EXP-20261116-05](https://github.com/LuNa-shi/SwarmEnv/blob/56ae6722d9a83826e17bb904bc2f7c258eeeca08/docs/experiments/EXP-20261116-05-pass-k-1-1h.md). It reached trusted acceptance despite its separate protocol-invalid closeout defect. Its extended owner-ended observation interval is excluded. All three columns below use metadata start, first Execution activation, the merge receipt for the ultimately accepted main, final submission creation, and durable trusted acceptance. The four intervals are consecutive and nonoverlapping.

| Interval | Single Agent EXP05 | Prior Swarm EXP07 | Queue Swarm EXP08 |
|---|---:|---:|---:|
| Metadata start → first Execution | 80.892 s | 177.004 s | 177.890 s |
| First Execution → accepted main's merge receipt | 621.825 s | 800.459 s | 881.419 s |
| Merge → final submission | 0.085 s | 129.974 s | 16.920 s |
| Submission → trusted acceptance | 102.807 s | 157.471 s | 151.871 s |
| **Startup → acceptance** | **13m25.609s** | **21m04.908s** | **20m28.100s** |
| **First Execution → acceptance** | **12m04.717s** | **18m07.904s** | **17m30.210s** |

EXP08 was **36.808 seconds faster than EXP07**, but **7m02.491s slower than the single Agent, about 52%**. Its proof construction and integration interval was actually 80.960 seconds longer than EXP07's; the shorter merge-to-submission interval accounts for much of the net improvement. EXP07's provider failures occurred in that latter interval, while EXP08 had no upstream rejection. These observations do not prove how much improvement came from avoiding those failures.

The ordinary queue was never used, so queue waiting cannot explain this run's delay. Startup, sequentially delivered helpers, integration/compatibility repairs and final verification occupy identifiable portions of the observed path. Removing the cap permits continued development but does not by itself produce a faster proof. Different versions, prompts, proof structures, scheduling and natural model choices prevent a causal estimate of concurrency or collaboration's benefit from this single pair. The evidence supports reliability of the observed development/acceptance path, not a speedup claim.

## Next steps

- Keep the reviewed unlimited ordinary policy with four running/eight waiting/default 120-second queue deadline; preserve the existing actual-launch authority and final-verification boundaries.
- Record the timing result and comment-triggered lexical false rejections on Issue #130. A change to checker/guard semantics or a new performance experiment requires a separate owner decision. The owner deferred further investigation of the prior provider burst.
- Complete release review against the fixed runtime, Architecture, test and experiment evidence. No PR merge or release tag has been performed by this run.

## Evidence and limitations

Authoritative sources: `metadata/experiment.json`; Task/Execution/Context/Judge/model-budget stores under `state/projects/putnam_2025_b1/`; fixed public Workspace revisions; Agent tool/Bridge/service/runtime records; report projections; and metadata-declared `<external>/observability.sqlite`. Raw conversations, proof source, credentials and private paths remain ignored and are not exported here.

Detailed local analysis: `analysis/experiment-analysis.md` with `analysis/analysis-completion.json`; independent `analysis/independent-behavior-audit.json`, `analysis/service-cleanup-verification.json` and `analysis/protocol-concurrency-verification.json`. The accepted commit/tree, admission interval sweep, scoped provider queries and actual unit/cgroup state support the respective claims. Source repair/reuse conclusions come from observable tool actions and immutable files, not inferred hidden model reasoning.

Startup validation recorded the exact image ID and the committed image passed actual-worker testing; deleted containers cannot be re-inspected after cleanup. Aggregate report Material counts use the active projection and differ from all persisted rows as explained above. Zero inventory warnings does not establish complete fault coverage. Unused queue saturation remains controlled-test evidence; a normal early success is not an hour-long endurance result.
