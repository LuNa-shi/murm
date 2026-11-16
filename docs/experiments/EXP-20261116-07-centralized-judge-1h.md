# EXP-20261116-07: Independent services and centralized Lean checks, one-hour maximum

Status: REGISTERED
Approved GitHub Issue: [#130](https://github.com/LuNa-shi/SwarmEnv/issues/130), latest owner decision approving lightweight Bots, Judge-only Lean checks, unchanged ordinary limits and one 1h-limited repeat.
Implementation PR: [#132](https://github.com/LuNa-shi/SwarmEnv/pull/132).
Repeat of / comparison to: [EXP-20261116-04](EXP-20261116-04-workspace-project-1h.md). This is a versioned engineering/behavioral acceptance repeat, not a controlled estimate of centralization's causal benefit.

## Setup

Observe autonomous Task proposal/take/finish, development feedback through saved-revision Judge checks, public Workspace/Material reuse, and progress toward the same B1 Mission. Bots have general tools but no local Lean/Lake/Mathlib; Context/Judge run independently. Distinguish source errors, capacity rejection, exhausted budget, infrastructure failures and final acceptance. No operator-authored research Tasks, candidate solutions or scripted model answers.

| Item | Fixed value |
|---|---|
| Clean runtime | `e18c7ae5bce48d73cf248c14080dcdf2327476fb`; independent incremental Spec/Standards PASS, following reviewed service implementation `daf0b0a`. Launch registration is documentation-only; exact launch SHA/clean state will be captured in runtime metadata. |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. |
| Toolchain | Checker-side Lean 4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Locked whole-project checks and independent original-theorem/axiom/kernel final verification. Artifact-lock digest `7de2ff5fe964b27f79cc164e9721c4c3e28504595f74e267c4d5273a51d8f89a`. |
| Limits | Four Cores, one project, 3,600,000 ms maximum including project setup; Bot/Execution maxima 1,800,000 ms; selection 360,000 ms; first Bot starts staggered 60,000 ms, replacement Bots do not repeat the stagger. |
| Checks | Ordinary Mission requests **20 total / 2 concurrent**, process/merge maximum 180,000 ms. Final admissions 4 / concurrent 1, final-check maximum 300,000 ms. Existing separate merge slots and final acceptance policy unchanged. |
| Resource profile | Each checker unit: 4 GiB, no swap, 64 tasks, two CPU equivalents. Sandbox retains existing OpenSandbox limits and 96 MiB / 8,192-inode writable quota. Cleanup grace 30,000 ms. |
| Provider/model | `gpt_proxy/gpt-6.1-sol`; time-bounded gateway, 180,000 ms request cap, revocable Bot credentials. Currency cost remains unknown without trusted usage/rates. |
| Image | `swarmenv/agent:issue130-judge-only`, immutable ID `sha256:700487de2555b5a19ab60518bcac2781a351da169a753b3199c3edf85350c0a1`; built from committed runtime allowlist, Pi 1.3.0. General tools present, Lean/Lake/elan absent. |
| Prompt identity | System `7bfee0de07d5cb5e7261d76a59324acb4d19fb249b4277f7cebe3174a8531988`; Workspace skill `eac1b56f88800434b153f61698fe40aabb9d8a653cd1d542422ff5f4b4fc6b42`; finish skill `cc3748aa4502013072a030fa84fe13f8cfaa82d6e1ea642661a5b6eeaeeb32a4`; CLI `24e754960f63535169c59752d193fbabba734cd2cc04a3eef64e86172a800bc6`. Other exact profile/schema/resource identities are recorded by launch metadata. |
| Raw evidence | Ignored `experiments/EXP-20261116-07/`, `reports/EXP-20261116-07/` and private preflight/launch logs. Public reporting excludes raw conversations, proof source, credentials and personal paths. |

Before launch require the full test suite, docs/diff checks, exact-image actual worker contract and disk-isolation probes, and healthy production checker deployment. The real independent Judge repair probe already saved an erroneous revision and obtained source FAIL, then saved a corrected revision and obtained PASS; exact replay preserved the 20/2 policy without extra admission, and cleanup was confirmed. This controlled probe is distinct from the natural Agent behavior to be observed.

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue130-judge-only \
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
  --experiment-dir experiments/EXP-20261116-07 --report-dir reports/EXP-20261116-07
```

Stop normally at trusted Mission acceptance or the one-hour deadline, followed by bounded cleanup. Stop and diagnose systemic authorization, checker, provider or lifecycle faults; ordinary source errors and temporary capacity rejection remain observations. Do not change budgets, Tasks or proof standards during the run. Successful early acceptance is not a one-hour endurance result. One run does not establish performance across problems or seeds.

## Results

Pending execution. Report actual duration, protocol/cleanup status, Task/Execution/Material/Workspace behavior, check budgets/latency/replay, model usage and trusted Mission outcome from authoritative evidence.

## Analysis

Pending evidence. The no-local-Lean instructions, general-tool additions and independent service deployment change together; comparison to EXP-04 cannot isolate their individual effects.

## Next steps

Execute the authorized bounded run after final preflight, monitor it, run experiment-analysis to completion, and publish a sanitized report. Any additional paid run or changed resource/research scope requires a new allowance.

## Evidence and limitations

Runtime and launch metadata establish version identity. Independent services have separate stores and coordinator-side request logs; peer-side phase detail must be reconstructed from durable receipts, results and resource ownership rather than assumed from missing in-process checker logs. Conditions not triggered are untested, not passed.
