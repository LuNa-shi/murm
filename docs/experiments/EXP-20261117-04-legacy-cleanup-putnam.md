# EXP-20261117-04: Putnam acceptance after legacy execution cleanup

Status: REGISTERED — launch requires final full-suite and independent readiness gates.
Approved GitHub Issue: [#138](https://github.com/LuNa-shi/SwarmEnv/issues/138), [owner-authorized repeated one-hour runs](https://github.com/LuNa-shi/SwarmEnv/issues/138#issuecomment-6944184596).
Comparison to: [EXP-20261116-08](EXP-20261116-08-judge-queue-1h.md). This is engineering acceptance of the current registered lifecycle, not a causal performance comparison.

## Setup

Acceptance requires a fresh natural-Agent run with `protocol_valid=true`, trusted original theorem/type/axiom/kernel Mission acceptance, real Workspace/Judge lifecycle evidence and verified physical cleanup. Intermediate checker PASS, timeout or an unverified report alone is insufficient. Each authorized repeat receives a new ID and preserves prior results.

| Item | Fixed value |
|---|---|
| Implementation | `1eb4333a7e01e624c9599449b2960a97937105fd`, based on reviewed #134 integration `6136f079c1b1d04fb7cdabf02e57b79207d1e3b0`. Launch uses the clean preregistration descendant; exact revision is recorded by the CLI. |
| Treatment | Remove obsolete Scheduler, local AgentCoreAdapter, unregistered execution startup and same-Execution Session replacement. Registered Bot/Workspace/Judge lifecycle remains. Observer server now defaults off; project-local evidence remains enabled. |
| Problem | `putnam_2025_b1`, PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Fresh input; no prior proof hints or operator-authored research Tasks. |
| Toolchain | Lean 4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Whole-project checks and independent final verification. Lock `25322ea2e70db3befa35d96fa1310e1e5b28b5ca7ae4414d43b5930f3487a6e6`. Configuration and source/dependency pins match EXP08. Verifier/resource-launcher bytes include the inherited opt-in FLT/resource support from #134; this Putnam configuration does not enable those options. Therefore the checker artifact bundle is not byte-identical to EXP08. |
| Limits | 4 Cores / 1 project / maximum 3,600,000 ms including setup; Bot and Execution 1,800,000 ms; selection 360,000 ms; initial stagger 60,000 ms; early stop on trusted acceptance. |
| Checks/resources | Ordinary requests: no cumulative limit, 4 concurrent, 8 queued, 120,000 ms queue wait; source/merge timeout 180,000 ms. Final admissions 4 / concurrency 1 / 300,000 ms. Checker 4 GiB, no swap, 64 tasks, two CPU equivalents; Bot writable quota 96 MiB / 8,192 inodes; cleanup grace 30,000 ms. |
| Provider/model | `gpt_proxy/gpt-6.1-sol`, time-bounded gateway, 180,000 ms request cap. Actual currency cost remains unknown without trusted rates. |
| Image | `swarmenv/agent:legacy-30c42b6`, immutable ID `sha256:e95a1f0ec5778a3e88de675a5a3fdf6ebdbc59424c487f2f687520c1dcdb0efb`. Docker COPY inputs match the implementation commit; Pi 1.3.0, general tools present, no local Lean/Lake/elan. |
| Launch identity | Deployment configuration SHA256 `9bf4ad74d65892a98b8a011a2d8c84e97169fc1a8d839f653e7f5b9c52b2bedc`; private launch script SHA256 `740bca8c2f1c0107a1c1e18baaee013e249daf99e2006af629395b031b6d70ba`. |
| Prompt/tool identity | System resource `7bfee0de07d5cb5e7261d76a59324acb4d19fb249b4277f7cebe3174a8531988`; Workspace skill `5e088f921ee9c5ca86bcd2a2b1543b03999821430d5530b9c257078f2ac4b061`; finish skill `cc3748aa4502013072a030fa84fe13f8cfaa82d6e1ea642661a5b6eeaeeb32a4`; CLI `24e754960f63535169c59752d193fbabba734cd2cc04a3eef64e86172a800bc6`. Full contract/resource identities are retained in launch manifest and runtime metadata. |
| Evidence | Ignored `experiments/EXP-20261117-04/` and `reports/EXP-20261117-04/`; launch/preflight inputs are outside the fresh experiment directory. No observer server is started. Raw conversations, candidate/proof source, credentials and private paths remain local. |

Portable command, with the pinned image and local OpenSandbox/Bridge endpoint environment configured by the private launch script:

```sh
node scripts/run-putnambench-benchmark.mjs \
  --problems experiments/.launch/EXP-20261117-04/deployment-config.json \
  --putnambench-root "$PUTNAMBENCH_ROOT" --problem putnam_2025_b1 \
  --cores 4 --project-parallelism 1 --timebox-ms 3600000 \
  --initial-bot-stagger-ms 60000 --bot-max-ms 1800000 \
  --selection-timeout-ms 360000 --execution-timeout-ms 1800000 \
  --checker-timeout-ms 180000 --provider gpt_proxy --model gpt-6.1-sol \
  --experiment-dir experiments/EXP-20261117-04 \
  --report-dir reports/EXP-20261117-04
```

## Results

Not launched at registration. Before launch, require full tests, independent Spec/Standards readiness and a clean tree. The committed worker passed startup/large-input tests and disk/inode confinement; a zero-model production registered Bot/Bridge/Workspace/independent Judge probe observed source FAIL, repaired PASS, exact request replay and confirmed peer/Sandbox cleanup. These controlled checks do not establish mathematical acceptance.

## Analysis

Pending actual execution. Runtime, launcher and inherited #134 changes make this a versioned acceptance run; elapsed time alone cannot attribute performance to legacy removal. The existing FLT experiment is separate and its result is not this run's acceptance evidence.

## Next steps

Complete the final gates, launch within the authorized allowance, analyze authoritative evidence and verify physical cleanup. Diagnose and repair in-scope failures before a separately registered repeat if needed. No PR merge is authorized.

## Evidence and limitations

The full natural-Agent result, actual usage, Mission acceptance, protocol validity and cleanup remain unknown until completion. Environment-gated checks are reported separately from executed tests. Offline analysis must use the project-local observation store and authority logs because the persistent observer is disabled.
