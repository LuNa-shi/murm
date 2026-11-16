# EXP-20261116-08: Judge queue with four concurrent checks, one-hour maximum

Status: REGISTERED — launch pending final review and preflight
Approved GitHub Issue: [#130](https://github.com/LuNa-shi/SwarmEnv/issues/130), owner decision removing ordinary cumulative quotas, adding queue/busy handling, concurrency four, and authorizing a further 1h-limited repeat.
Implementation PR: [#132](https://github.com/LuNa-shi/SwarmEnv/pull/132).
Repeat of: [EXP-20261116-07](EXP-20261116-07-centralized-judge-1h.md). Timing comparison: the approximately 13-minute single-Agent EXP-20261116-05 baseline from independent Issue #129, using aligned metadata-start→trusted-acceptance and first-Execution→acceptance intervals. This is a versioned engineering acceptance repeat, not a controlled causal estimate of queueing or collaboration benefits.

## Setup

Observe autonomous Task proposal/take/finish, development feedback through saved-revision Judge checks, public Workspace/Material reuse, and progress toward the same B1 Mission. Bots have general tools but no local Lean/Lake/Mathlib; Context/Judge run independently. Distinguish source errors, queue waiting, busy rejection, infrastructure failures and final acceptance. No operator-authored research Tasks, candidate solutions or scripted model answers.

| Item | Fixed value |
|---|---|
| Clean runtime | `1c2d5d5825d3511aa47d0964c11f44d107d28da5`; launch metadata will record the clean registration commit; independent review and preflight are required before launch. |
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

Pending execution. No observed success or resource cleanup is claimed by registration.

## Analysis

Evaluate actual ordinary check admissions, running/queue peaks, wait intervals, busy/timeouts, source errors, Execution lifecycle and material/source reuse. Distinguish ordinary diagnostics from final Mission acceptance. Record HTTP statuses/response-shape diagnostics if observed; the owner has deferred deeper provider investigation. Compare timing boundaries consistently against EXP-07 and the single-Agent baseline without treating overlapping work as additive wall time.

## Next steps

Complete launch gates, run once within the authorized one-hour maximum, inspect live operation and analyze terminal evidence using experiment-analysis. Stop normally at trusted acceptance or deadline; do not alter inputs, quota policies or resource limits mid-run.

## Evidence and limitations

Raw evidence will remain in ignored `experiments/EXP-20261116-08/`, launch/preflight logs and report projections. Detailed analysis goes to `analysis/experiment-analysis.md`; public reporting excludes conversations, proof source, credentials and private absolute paths. Untriggered queue saturation or failure paths are not natural-run validation of those paths. Actual time, tokens/cost uncertainty and cleanup will be reported after completion.
