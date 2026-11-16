# EXP-20261116-03: Whole-Workspace Lean collaboration, one-hour maximum

Status: BLOCKED — operator stopped to diagnose repeated checker infrastructure classification
Approved Issue: [#127 follow-up implementation, experiment and merge decision](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716), retaining [#122 behavioral acceptance](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896946332).
Implementation PR: [#128](https://github.com/LuNa-shi/SwarmEnv/pull/128).
Repeat of [EXP-20261116-02](EXP-20261116-02-workspace-project-1h.md), which stopped before model work because the image failed the immutable-resource ownership contract. This repeat includes the [approved startup workflow fixes](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6907134029).
Comparison: [EXP-20261115-08](EXP-20261115-08-single-problem-1h.md); a versioned acceptance follow-up, not a controlled causal comparison.

## Setup

Observe real Bot-driven Task proposal/take/finish, differentiated work, reuse of public results and progress toward the same B1 Mission. The change enables fixed whole-Workspace Lake builds and inter-file imports, with independent final theorem/proof verification retained. Check actual project coverage and whether Bots use separate modules; merely exposing an API is not evidence of natural reuse. No operator-authored research Tasks or scripted model answers.

| Item | Fixed value |
|---|---|
| Runtime | `df9240cf5045141b3d6f6656a88596b7c308f32a`; independent Spec and Standards reviews PASS. Registration/test-only commits may follow; exact clean launch recorded in private metadata. |
| Problem | Only `putnam_2025_b1`; PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`; input SHA256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. |
| Toolchain | Lean 4.33.1 `819816b2e0a3bf405af45ae5c7af2491d8f5bee6`; Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`; Comparator `3927ad383f208ae977c340a91c48ac9b497d2097`; exporter `15f6055e299ad5b89345e533cc2192f4cc00f659`. |
| Checker | Locked `projectChecks=true`; Lake builds all accepted research Lean modules from the fixed tree; final checker separately compares the original theorem, allowed axioms and kernel replay. Artifact lock `2af8d10a031e2611988ec2a447d9a66a73edbcd3519f88394665361baae307ea`. |
| Limits | Four Cores, one project, 3,600,000 ms run maximum; 1,800,000 ms Bot/Execution maxima; 360,000 ms selection; first starts staggered 60,000 ms; replacement Bots do not repeat the stagger. |
| Checker time | Ordinary diagnostic process/merge maximum 180,000 ms; final acceptance maximum 300,000 ms. CLI turn settling uses its default 540,000 ms, independent of model requests and lifecycle timers. |
| Checker resources | Per-process-group 4 GiB memory, no swap, 64 tasks, two CPU equivalents; no network, readonly pinned toolchain/dependencies. Ordinary admissions 20 / concurrent 2; final admissions 4 / concurrent 1. Merge has one retained slot per Core Runtime. |
| Provider/model | Real `gpt_proxy/gpt-6.1-sol`; time-bounded gateway, 180,000 ms request cap, revocable Bot credentials. Unknown currency cost remains unknown. |
| Agent image | `swarmenv/agent:issue127-final-df9240c`, digest `sha256:0c87c5658adaf13d7a9a9f292014be197bed8344c051cda51470b23f8c0db68e`; Pi 1.3.0. |
| Prompt identity | System body `aadad188ace990f5f12d136d25b0129ba0a45b2902589ab338c1da95844e1ab6`; Workspace skill `f99d28205bb396f550ec0edc9ba21552eb27b135dbcb24ac4e7b9dedaa4038ac`; finish skill `cc3748aa4502013072a030fa84fe13f8cfaa82d6e1ea642661a5b6eeaeeb32a4`; CLI `7d3b81c3f8ff43604c6c025868ecd6d373d5eb0a8a79d78e1327b5841ab0e124`. |
| Isolation/cleanup | Same OpenSandbox deployment and Bot writable quota as EXP-08; global cleanup grace 30,000 ms. Confirm scoped provider resources absent after closeout. |
| Raw evidence | Ignored `experiments/EXP-20261116-03/` and `reports/EXP-20261116-03/`; no raw proofs, conversations, credentials or private deployment paths in committed reporting. |

The following invocation uses verified private deployment/catalog and observability references. Both independent reviews passed the fixed runtime commit. The final image was built from the committed allowlist with `git archive`, then both offline worker probe branches (valid pinned resources and invalid hash rejection) and the disk quota probe passed against its immutable image ID. Startup requires the full test suite, exact-image worker contract probe and disk quota probe to pass; real isolated Lake/Mathlib and production artifact-lock checks have passed. Exact validation results are recorded before launch. Launch inputs and runner logs stay outside the formal evidence directory; the CLI creates that directory exclusively. Deterministic typed worker contract failures stop the project and clean resources; unrelated HTTP errors retain bounded recovery.

```sh
SWARMENV_SANDBOX_ENABLED=true \
SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:issue127-final-df9240c \
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
  --experiment-dir experiments/EXP-20261116-03 --report-dir reports/EXP-20261116-03
```

Stop normally at trusted Mission acceptance or the one-hour deadline and perform bounded cleanup. Stop and diagnose systemic authorization, provider, checker or lifecycle failures. Ordinary source errors, useful negative research outcomes and transient capacity rejection are analyzed separately. Do not alter a running experiment's budgets, proof standard or Tasks to obtain acceptance. A successful early stop is not one-hour endurance evidence.

## Results

Clean launch `5aef6e7`; project 04:32:06.082–04:38:01.785 UTC, 355,703 ms. All four initial Bots reached READY, each examined public work and proposed/took its own Task. Four Executions overlapped; two Tasks completed and two reopened on operator stop. Two replacements reached READY without taking a Task before interruption. Six Bots closed; independent provider queries returned HTTP 404 for all six exact sandbox IDs. `solved=false`, `made_progress=true`, `protocol_valid=false`, with `operator_stop` the only invalid reason.

| Core / Bot prefix | Responsibility and observed result |
|---|---|
| 1 / `750517d1` | Proposed `04fe748e` for the overall geometry contradiction. Read Core 2 Material `6fc232d4`, applied main 0.10, recorded its use, and saved 0.14 with actual import and lemma use from the separate circle module. Lake resolved the module and reported remaining proof errors. Task reopened at stop. |
| 2 / `3fd7cb2c` | Proposed `7820358b`, proved the circle exception bound, passed named-file whole-project check `3d019ae1`, merged main 0.10, published/linked Material `6fc232d4`, and finished. Successor `2cb514b1` read both delivered helpers but had no Execution at stop. |
| 3 / `c9b5fefe` | Proposed `ec7df245` for a Euclidean distance-grid helper, passed `f4f5893c`, merged main 0.13, published/linked `2c6d803c`, and finished. It also linked that result to Core 1's Task; Core 1 had not consumed it. Successor `8bb2db76` reached discovery only. |
| 4 / `11287ed3` | Proposed `5ae88c92` for finite counting. Saved 0.15; `676bc101` settled PASS during shutdown after the Bridge had fenced its response. The saved result was not merged or delivered; Task reopened. |

The two merge receipts checked the actual combined tree, including earlier unchanged helper files. Main 0.13's Git tree equals its passing check tree and contains two independent helpers plus the unchanged seed theorem. Core 1's saved 0.14 imported and used Core 2's helper without inlining it, but that draft still had proof errors. No Mission submission occurred.

Ordinary checks: 14 total, five PASS, six source failures, one selected seed-placeholder rejection, and two `checker_crashed` infrastructure classifications. The final report's cheating flag arrays are empty; the seed rejection did not invalidate this run. Completed model requests recorded 2,270,606 input and 20,300 output tokens across 101 requests; three other settlements have unknown usage. Currency cost is unknown.

## Analysis

The startup fixes worked in the real OpenSandbox deployment. Initial Core registration respected one-minute staggering, all four performed autonomous discovery and execution, and finished Bots were replaced immediately. Checks compiled multiple files, combined-tree merges retained earlier work, and the integrator actually imported a predecessor's separate module. This supports meaningful division and reuse, while interruption leaves Mission completion and successor Execution unverified.

A bounded no-model replay of exact revision 0.8 reproduced both infrastructure classifications. Lake exited with normal source-failure status and verbose source errors; stderr exceeded the retained 8,192-character limit. The project checker treated truncated diagnostics as a crash even though the retained errors and exit evidence showed normal source rejection. The two error receipts therefore overstated infrastructure failure and caused unnecessary retries. Repair must classify the full stream with bounded metadata and continue distinguishing genuine resource exhaustion; simply ignoring truncation could hide a late resource failure.

Core 1 also had a recoverable provenance error: an `integration` Material-use record did not satisfy Workspace saving's explicit `workspace` use requirement. It corrected the use and saved with a fresh request ID. These two records describe one downstream use, not two independent handoffs. Selecting the original seed theorem for a delivery check correctly rejected its placeholder; an earlier live interpretation that this had created a cheating flag was disproved by the authoritative report.

## Next steps

Fix the reproduced whole-project diagnostic classification, review ordinary and final build paths, replay the original tree and long-output resource cases, then run a fresh preregistered repeat within the same approved inputs and limits. PR #128 remains unmerged until acceptance succeeds.

## Evidence and limitations

Repository analyzer exited 0 and generated the private `analysis/experiment-analysis.md`; independent Bot/system observations and scoped provider cleanup checks are retained beside it. Authoritative records are the per-project Task, Context, Judge and model-budget databases plus immutable Workspace trees and Bridge/Runtime events. No raw conversations, proof source, private paths or credentials are committed.

No Bot or selection time limit expired. No final submission ran. The main merged helpers did not import one another; the imported draft failed on ordinary target proof errors. Natural import resolution, deterministic import/final-replay probes, and final Mission acceptance are distinct evidence classes. This short interrupted run is not one-hour endurance evidence.
