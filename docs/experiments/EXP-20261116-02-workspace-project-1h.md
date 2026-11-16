# EXP-20261116-02: Whole-Workspace Lean collaboration, one-hour maximum

Status: BLOCKED — Agent image contract ownership rejected before model work
Approved Issue: [#127 follow-up implementation, experiment and merge decision](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716), retaining [#122 behavioral acceptance](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896946332).
Implementation PR: [#128](https://github.com/LuNa-shi/SwarmEnv/pull/128).
Repeat after EXP-20261116-01 was rejected before Bot/model startup because the operator pre-created its private evidence directory.
Comparison: [EXP-20261115-08](EXP-20261115-08-single-problem-1h.md); a versioned acceptance follow-up, not a controlled causal comparison.

## Setup

Observe real Bot-driven Task proposal/take/finish, differentiated work, reuse of public results and progress toward the same B1 Mission. The change enables fixed whole-Workspace Lake builds and inter-file imports, with independent final theorem/proof verification retained. Check actual project coverage and whether Bots use separate modules; merely exposing an API is not evidence of natural reuse. No operator-authored research Tasks or scripted model answers.

| Item | Fixed value |
|---|---|
| Runtime | `dfc0c875d19bea816419cb321f61eb71ca2355ee`; independent Spec and Standards reviews PASS. Registration/test-only commits may follow; exact clean launch recorded in private metadata. |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. |
| Toolchain | Lean 4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Locked `projectChecks=true`; Lake builds all accepted research Lean modules from the fixed tree; final checker separately compares the original theorem, allowed axioms and kernel replay. Artifact lock `2af8d10a031e2611988ec2a447d9a66a73edbcd3519f88394665361baae307ea`. |
| Limits | Four Cores, one project, 3,600,000 ms run maximum; 1,800,000 ms Bot/Execution maxima; 360,000 ms selection; first starts staggered 60,000 ms; replacement Bots do not repeat the stagger. |
| Checker time | Ordinary diagnostic process/merge maximum 180,000 ms; final acceptance maximum 300,000 ms. CLI turn settling uses its default 540,000 ms, independent of model requests and lifecycle timers. |
| Checker resources | Per-process-group 4 GiB memory, no swap, 64 tasks, two CPU equivalents; no network, readonly pinned toolchain/dependencies. Ordinary admissions 20 / concurrent 2; final admissions 4 / concurrent 1. Merge has one retained slot per Core Runtime. |
| Provider/model | Real `gpt_proxy/gpt-6.1-sol`; time-bounded gateway, 180,000 ms request cap, revocable Bot credentials. Unknown currency cost remains unknown. |
| Agent image | `swarmenv/agent:issue127-project-dfc0c87`, digest `sha256:962ca1b453ca9dffdf259562f0af6b78f2c9bed119e8b7206aef690f103c7c21`; Pi 1.3.0. |
| Prompt identity | System body `aadad188ace990f5f12d136d25b0129ba0a45b2902589ab338c1da95844e1ab6`; Workspace skill `f99d28205bb396f550ec0edc9ba21552eb27b135dbcb24ac4e7b9dedaa4038ac`; finish skill `cc3748aa4502013072a030fa84fe13f8cfaa82d6e1ea642661a5b6eeaeeb32a4`; CLI `7d3b81c3f8ff43604c6c025868ecd6d373d5eb0a8a79d78e1327b5841ab0e124`. |
| Isolation/cleanup | Same OpenSandbox deployment and Bot writable quota as EXP-08; global cleanup grace 30,000 ms. Confirm scoped provider resources absent after closeout. |
| Raw evidence | Ignored `experiments/EXP-20261116-02/` and `reports/EXP-20261116-02/`; no raw proofs, conversations, credentials or private deployment paths in committed reporting. |

The following invocation uses verified private deployment/catalog and observability references. Startup requires the final full test suite and both independent reviews to pass; real isolated Lake/Mathlib and production artifact-lock checks have passed. Exact validation results are recorded before launch.

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue127-project-dfc0c87 \
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
  --provider gpt_proxy --model gpt-6.1-sol \
  --observability-metadata "$OBSERVABILITY_METADATA" \
  --experiment-dir experiments/EXP-20261116-02 --report-dir reports/EXP-20261116-02
```

Stop normally at trusted Mission acceptance or the one-hour deadline and perform bounded cleanup. Stop and diagnose systemic authorization, provider, checker or lifecycle failures. Ordinary source errors, useful negative research outcomes and transient capacity rejection are analyzed separately. Do not alter a running experiment's budgets, proof standard or Tasks to obtain acceptance. A successful early stop is not one-hour endurance evidence.

## Results

Runtime `dfc0c87`, clean launch `4221231`. Initialization began at 04:05:56.488 UTC; the project ran from 04:07:11.037 to 04:08:13.905 UTC, 62,868 ms, before operator stop after independent observers detected repeated startup rejection. Core 1 created six Bots that failed before readiness; a seventh Bot on Core 2 closed during operator stop. All seven are CLOSED. There were zero Tasks, Executions, Materials, ordinary/final checks and model requests. `protocol_valid=false`, `solved=false`; no research progress is claimed. Cleanup took 368 ms with no errors, and independent provider GET checks confirmed all seven scoped sandbox IDs returned HTTP 404.

## Analysis

The image build used a tar context that preserved UID 1000 ownership on trusted Bot contract files and ancestors. Their hashes and readability matched, but the worker correctly requires UID 0 and immutable/traversable ancestors. The actual worker `/start` call reproduced HTTP 400 before starting the model process. A root-run content-hash probe and a guest CLI help probe did not test this ownership gate. The generic report class `lean_checker_error` accompanied `INVALID_CONTRACT`; no Lean checker actually ran. Repeated replacement attempted the same deterministic startup error, so startup policy also needs an early fatal contract-error boundary.

## Next steps

Apply the [owner-requested startup workflow hardening](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6907134029): explicit root-owned image COPY, actual worker and quota probes without model calls, early output-directory diagnosis and fatal startup contract-error handling. Preserve this attempt, review the changes, then register a fresh one-hour maximum repeat before merge.

## Evidence and limitations

Real isolated tests demonstrated import order, unreferenced-file errors, missing/cyclic imports, full-Mathlib multi-file compilation, and final rejection of imported `sorry`. These are deterministic probes, not natural-model evidence. Earlier EXP-08 remains bound to its original single-file checker and shorter limits.

The repository analyzer exited successfully with zero Executions and incomplete local execution evidence, as expected for a pre-model failure. Independent Bot and system observations plus exact provider cleanup confirmations remain under the ignored run analysis directory. No natural multi-file cooperation was exercised.
