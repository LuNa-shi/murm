# EXP-20261115-08: One-hour maximum continuous-Core behavioral acceptance

Status: REGISTERED
Approved GitHub Issue: [#122 latest acceptance decision](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896946332), [continuous Core loop and startup staggering](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896808817).
Implementation: `77f716c`; independent Spec and Standards reviews passed, including the startup-after-stop race and per-wait cancellation cleanup. Full final tests must pass before launch.
Preceding evidence: [EXP-06](EXP-20261115-06-single-problem-30m.md) accepted its Mission in 462,488 ms under the previous prompt/runtime; [EXP-07](EXP-20261115-07-single-problem-2h.md) was interrupted after a final-check timeout and no-work quiescence. Neither validates this revised continuous-Core implementation.

## Setup

This is a natural-model run on the same authorized single problem. Each Core owns a sequence of finite Bots. A replacement prefers suitable existing work; an unfinished Mission with no suitable Task requires useful gap discovery and proposal, followed by take and execution. An empty queue or all existing Tasks being done cannot permanently park the Core. Real selection/lifetime expiry allows cleanup and bounded rediscovery. The Runtime does not invent Tasks. The first Bot on each Core is staggered by one minute; replacements do not repeat that stagger. No server-side semantic deduplication was added.

| Item | Fixed value |
|---|---|
| Source | Runtime `77f716c`; exact clean launch commit recorded in private metadata. Registration-only changes do not alter runtime. |
| Agent image | `swarmenv/agent:issue122-continuous-77f716c`; `sha256:7279b7649251f820e95c0a9977fc6ff94bc454d1cf11f263298aaf98be266e71`; Pi 1.3.0 |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7` |
| Checker | Lean 4.33.1; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659` |
| Artifact lock | `4286e094c584f324873da37a04ab452946619489f2694f4c3fb15d9da79d7c0a`; checker implementation, fixture, dependencies and resource caps unchanged from EXP-06/07 |
| Provider/model | Real `gpt_proxy/gpt-6.1-sol`, host-held upstream credentials, revocable per-Bot gateway tokens; no scripted model replies |
| Prompt identity | Manifest `834274b44467635a6a9a770084e0822f369ccfa9586d5f642fa8e244e7a21a82`; system `304c03fb6c5e7e5e53980adf1b2977ae57f7d51215cf6412733f9b8d71ddff90`; plan-task `c369dce0c2f77d597d4f199c6b767c57ac4cea2b9b7bb5fdd069b7f8e77ef695`; CLI `419c6f9823975f16330aa1f82f2f0c5a2904bbe38aea3d94d2706ac1c878d7ba` |
| Concurrency/time | 4 independent Cores, 1 project; Mission maximum 3,600,000 ms including setup; first discovery offsets 0/60/120/180 seconds from orchestration start; Bot/Execution maximum 1,800,000 ms; selection/turn setting 180,000 ms; shared cleanup grace 30,000 ms |
| Model bounds | Time-bounded gateway, request hard limit 180,000 ms intersected with lifecycle limits; output request cap 32,768 tokens; currency cost unknown, no substituted local estimate |
| Isolation | OpenSandbox release-1.2.0, local Docker allowlist, per-Bot 100,663,296 bytes / 8,192 inodes writable; coordination permission only `mission_submit` |
| Judge bounds | 20 ordinary admissions / 2 simultaneous; 4 final admissions / 1 simultaneous; checker absolute 120,000 ms; zero retries of the same snapshot after final infrastructure failure. A timeout is not scientific FAIL. These limits are unchanged. |
| Checker process | systemd user cgroup: 4 GiB RAM, zero swap, max 64 tasks, 200% CPU, 1 s termination grace |
| Deployment config | Nonsecret private overlay SHA256 `eee79495a2e8e955ca79320421506011a66ce142efac3f90845075666cf36ee4`; unchanged locked 12-problem catalog selected with `--problem` |
| Evidence | Ignored `experiments/EXP-20261115-08/` and `reports/EXP-20261115-08/`; automated and independent content/lifecycle analysis under local `analysis/` |

Invocation uses verified private `DEPLOYMENT_CONFIG` and `PUTNAMBENCH_ROOT`:

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue122-continuous-77f716c \
SWARMENV_OPENSANDBOX_URL=http://127.0.0.1:8080 \
SWARMENV_OPENSANDBOX_ENDPOINT_HOST=127.0.0.1 \
SWARMENV_BRIDGE_HOST=172.17.0.1 \
SWARMENV_BRIDGE_PUBLIC_URL='http://172.17.0.1:{port}' \
node scripts/run-putnambench-benchmark.mjs \
  --problems "$DEPLOYMENT_CONFIG" --putnambench-root "$PUTNAMBENCH_ROOT" \
  --problem putnam_2025_b1 --cores 4 --project-parallelism 1 \
  --timebox-ms 3600000 --initial-bot-stagger-ms 60000 \
  --bot-max-ms 1800000 --selection-timeout-ms 180000 \
  --execution-timeout-ms 1800000 --turn-timeout-ms 180000 \
  --provider gpt_proxy --model gpt-6.1-sol \
  --observability-metadata experiments/.observability/time-bounded-server.json \
  --experiment-dir experiments/EXP-20261115-08 --report-dir reports/EXP-20261115-08
```

Stop at trusted Mission acceptance or the run deadline, then bounded cleanup. Stop and diagnose a systemic authorization, transport or lifecycle failure. Ordinary source rejection and a properly bounded final-check timeout are distinct from systemic failure; inspect subsequent autonomous work within the unchanged policy. Do not change a running experiment's limits or inject operator-authored Tasks to make it pass.

## Results

Pending final checks and execution. This registration is not evidence of success.

## Analysis

Evaluate the owner's four acceptance dimensions separately:

1. **Stable progress:** sustained useful work and correct lifecycle/resource cleanup; no indefinite quiescence caused solely by an empty Task queue while the Mission is open. Quiet waits, discovery, cleanup and productive Execution time remain separate.
2. **Division of work:** responsibility and actual deliveries differ in useful ways. Four allocated Cores, multiple Task IDs, or independent duplicate full solutions alone do not establish division of labor. Read-before-proposal and stagger timing are observable, not guaranteed semantic uniqueness.
3. **Continuation of results:** trace a public revision or Material from producer to reader, decision and concrete downstream action or deliverable. Reads, publications and consume counts alone are insufficient; distinguish informational reuse from actual source integration and final accepted-tree contribution.
4. **Mission outcome:** trusted acceptance or clearly evidenced substantial progress on fixed acceptance conditions. An ordinary source PASS is not final acceptance. Record remaining uncertainty and unresolved requirements.

All Bot lifecycles should be reconstructed with stable identifiers and Target / Action / Immediate result / Next effect. Describe differences from prior runs, but do not claim causal improvement from a single stochastic sample with both guidance and startup scheduling changed. If accepted early, report actual duration and do not label it a one-hour endurance test. If only engineering health passes, do not label the whole behavioral acceptance PASS.

## Next steps

Produce the repository experiment analysis and independent content/system observations; publish only sanitized evidence and update Issue #122 / PR #126 with the fixed tested revision and each criterion's result. Record gaps rather than interpreting busy activity as progress. New scientific direction or checker/resource-policy expansion needs its own owner decision.

## Evidence and limitations

Raw conversations, reasoning, proof source, credentials, stdout/stderr and private databases remain ignored local evidence. Summaries use stable IDs and version references. Actual currency cost and unobserved upstream retry/billing behavior remain unknown. Untriggered lifecycle/failure conditions are unobserved, not passed; deterministic regressions and natural-model evidence stay distinct.
