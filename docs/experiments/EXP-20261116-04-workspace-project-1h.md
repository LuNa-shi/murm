# EXP-20261116-04: Whole-Workspace Lean collaboration, one-hour maximum

Status: REGISTERED — implementation and independent reviews complete; final launch checks pending
Approved Issue: [#127 follow-up implementation, experiment and merge decision](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716), retaining [#122 behavioral acceptance](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896946332).
Implementation PR: [#128](https://github.com/LuNa-shi/SwarmEnv/pull/128).
Repeat of [EXP-20261116-03](EXP-20261116-03-workspace-project-1h.md), interrupted after verbose Lake source errors were misclassified as infrastructure failures. This repeat repairs bounded diagnostic classification and operator check coverage while retaining the approved startup workflow and scientific acceptance.
Comparison: [EXP-20261115-08](EXP-20261115-08-single-problem-1h.md); a versioned acceptance follow-up, not a controlled causal comparison.

## Setup

Observe real Bot-driven Task proposal/take/finish, differentiated work, reuse of public results and progress toward the same B1 Mission. The change enables fixed whole-Workspace Lake builds and inter-file imports, with independent final theorem/proof verification retained. Check actual project coverage and whether Bots use separate modules; merely exposing an API is not evidence of natural reuse. No operator-authored research Tasks or scripted model answers.

| Item | Fixed value |
|---|---|
| Runtime | `e00e2462143cf486f94c061edeebda5bf5862a0f`; independent Spec and Standards reviews PASS. Registration/test-only commits may follow; exact clean launch recorded in private metadata. |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. |
| Toolchain | Lean 4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Locked `projectChecks=true`; Lake builds all accepted research Lean modules from the fixed tree; final checker separately compares the original theorem, allowed axioms and kernel replay. Artifact lock `6407ca71a852f1cc71f9464c8cdf24f6b33b5d4ac6a30d241865c349d2caa4e0`. |
| Limits | Four Cores, one project, 3,600,000 ms run maximum; 1,800,000 ms Bot/Execution maxima; 360,000 ms selection; first starts staggered 60,000 ms; replacement Bots do not repeat the stagger. |
| Checker time | Ordinary diagnostic process/merge maximum 180,000 ms; final acceptance maximum 300,000 ms. CLI turn settling uses its default 540,000 ms, independent of model requests and lifecycle timers. |
| Checker resources | Per-process-group 4 GiB memory, no swap, 64 tasks, two CPU equivalents; no network, readonly pinned toolchain/dependencies. Ordinary admissions 20 / concurrent 2; final admissions 4 / concurrent 1. Merge has one retained slot per Core Runtime. |
| Provider/model | Real `gpt_proxy/gpt-6.1-sol`; time-bounded gateway, 180,000 ms request cap, revocable Bot credentials. Unknown currency cost remains unknown. |
| Agent image | `swarmenv/agent:issue127-final-e00e246`, digest `sha256:7cab6ee00422e3bdcf1ff9889fb47ebbc4c1875c5ab6a4bc623f044609ea3662`; Pi 1.3.0. |
| Prompt identity | System body `aadad188ace990f5f12d136d25b0129ba0a45b2902589ab338c1da95844e1ab6`; Workspace skill `f99d28205bb396f550ec0edc9ba21552eb27b135dbcb24ac4e7b9dedaa4038ac`; finish skill `cc3748aa4502013072a030fa84fe13f8cfaa82d6e1ea642661a5b6eeaeeb32a4`; CLI `7d3b81c3f8ff43604c6c025868ecd6d373d5eb0a8a79d78e1327b5841ab0e124`. |
| Isolation/cleanup | Same OpenSandbox deployment and Bot writable quota as EXP-08; global cleanup grace 30,000 ms. Confirm scoped provider resources absent after closeout. |
| Raw evidence | Ignored `experiments/EXP-20261116-04/` and `reports/EXP-20261116-04/`; no raw proofs, conversations, credentials or private deployment paths in committed reporting. |

The following invocation uses verified private deployment/catalog and observability references. Both independent reviews passed the fixed runtime commit. The final image was built from the committed allowlist with `git archive`, then both offline worker probe branches (valid pinned resources and invalid hash rejection) and the disk quota probe passed against its immutable image ID. Startup requires the full test suite, exact-image worker contract probe and disk quota probe to pass; real isolated Lake/Mathlib and production artifact-lock checks have passed. Exact validation results are recorded before launch. Launch inputs and runner logs stay outside the formal evidence directory; the CLI creates that directory exclusively. Deterministic typed worker contract failures stop the project and clean resources; unrelated HTTP errors retain bounded recovery.

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue127-final-e00e246 \
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
  --experiment-dir experiments/EXP-20261116-04 --report-dir reports/EXP-20261116-04
```

Stop normally at trusted Mission acceptance or the one-hour deadline and perform bounded cleanup. Stop and diagnose systemic authorization, provider, checker or lifecycle failures. Ordinary source errors, useful negative research outcomes and transient capacity rejection are analyzed separately. Do not alter a running experiment's budgets, proof standard or Tasks to obtain acceptance. A successful early stop is not one-hour endurance evidence.

## Results

Pending the registered run. Independent Spec and Standards reviews passed runtime `e00e246`. Before launch, exact-image worker startup probes, disk quota/Landlock, real pinned project/final verifier and artifact-lock/cgroup gates must pass. The one-hour maximum preserves normal early stopping on trusted Mission acceptance.

## Analysis

No new natural-Agent evidence yet. The exact EXP-03 revision replay now returns source FAIL with bounded diagnostics. Real pinned Lean checks distinguish ordinary errors in `Killed.lean` from actual heartbeat exhaustion; mocked pipe-boundary regressions cover late OOM and abnormal worker exits in both ordinary and final builds. These are implementation diagnostics, not research acceptance.

The report now records durable project CheckResult IDs and coverage even when a closed Bot cannot receive the late response. A refused selected-file placeholder does not itself invalidate the project; project diagnostics alone do not establish research progress. The inherited report metadata's generic `cheating_policy` text is broader than this project-mode behavior; authoritative rejection/result fields and the architecture explanation distinguish it.

## Next steps

Run the registered profile after all final checks pass, analyze every Bot's responsibility, contribution and successor use, and independently verify checker and cleanup outcomes. Retain the same provider/model, fixture and budgets. No acceptance conclusion is drawn from review or test success alone.

## Evidence and limitations

Detailed local analysis will be written to `experiments/EXP-20261116-04/analysis/experiment-analysis.md`. Raw conversations, proof source, state databases, stdout/stderr and private deployment paths remain ignored. Currency cost remains unknown unless recorded by the provider. Observability uses a healthy local service with a fresh dedicated store; its identity will be captured in run metadata.
