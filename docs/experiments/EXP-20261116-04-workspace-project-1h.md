# EXP-20261116-04: Whole-Workspace Lean collaboration, one-hour maximum

Status: COMPLETE — four approved behavioral criteria PASS; trusted Mission accepted within the one-hour limit
Approved Issue: [#127 follow-up implementation, experiment and merge decision](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716), retaining [#122 behavioral acceptance](https://github.com/LuNa-shi/SwarmEnv/issues/122#issuecomment-6896946332).
Implementation PR: [#128](https://github.com/LuNa-shi/SwarmEnv/pull/128).
Repeat of [EXP-20261116-03](EXP-20261116-03-workspace-project-1h.md), interrupted after verbose Lake source errors were misclassified as infrastructure failures. This repeat repairs bounded diagnostic classification and operator check coverage while retaining the approved startup workflow and scientific acceptance.
Comparison: [EXP-20261115-08](EXP-20261115-08-single-problem-1h.md); a versioned acceptance follow-up, not a controlled causal comparison.

## Setup

Observe real Bot-driven Task proposal/take/finish, differentiated work, reuse of public results and progress toward the same B1 Mission. The change enables fixed whole-Workspace Lake builds and inter-file imports, with independent final theorem/proof verification retained. Check actual project coverage and whether Bots use separate modules; merely exposing an API is not evidence of natural reuse. No operator-authored research Tasks or scripted model answers.

| Item | Fixed value |
|---|---|
| Runtime | `e00e2462143cf486f94c061edeebda5bf5862a0f`; independent Spec and Standards reviews PASS. Clean launch `088541b7caa76503e09737bed686bcc17c08b3f1`; worktree clean. |
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

Runtime `e00e246` passed independent Spec and Standards review. The full suite passed 620 of 632 tests with 12 explicit environment-gated skips and zero failures. Separately enabled real pinned Lean/Mathlib project and final-verifier probes passed; the production artifact-lock/cgroup gate passed 3/3; exact-image worker probes passed 2/2; disk quota/Landlock and documentation/diff checks passed. The exact EXP-03 failed revision replay returned a bounded source FAIL, with actual resource failures kept distinct.

The CLI ran 05:52:23.453–06:03:03.088 UTC. The project ran 05:53:39.114–06:03:02.634 UTC: **563,520 ms (9m23.520s)**. Normal trusted acceptance ended the one-hour maximum early: `solved=true`, `protocol_valid=true`, `invalid=false`, no invalid reasons. This is not one-hour endurance evidence.

Submission `b1-final-main-017` fixed main `0.17`, commit `127abba55b28453450fd729454a1f05571ebc5c3`, tree `ec531519abe94b4a272266d36b9b88766c2590aa`, and explicit Material `83f15654`. Final receipt `treecheck:ef3020d1-d776-4584-a9a7-93d67efb98ae` passed the locked theorem/axiom/kernel verifier at 06:03:01.524 UTC. The submitting Bot had already finished; its closure did not cancel the admitted final check.

| Core / Bot prefix | Responsibility and outcome | Public continuation |
| --- | --- | --- |
| 1 / `ca00ebcf` | Circle-intersection Task `5b66fbef`, E `8f3e3ecf`: repaired a source error, passed `fb4c22c6` on revision `0.4`, merged `0.6`, published/linked `9537c111`, done. | Integrator applied its public revision and used the unchanged helper module. |
| 2 / `7c8268e9` | Circle-color Task `80161980`, E `a768e9ea`: checked and strengthened the helper through `0.8`, passed `8d11b363`, merged `0.10`, published/linked `e57d29f6`, done. | Integrator read the Material and applied the merged geometry results. |
| 3 / `574bba05` | Finite-incidence Task `db9687bc`, E `9adf7758`: passed `8201a87a` on `0.11`, merged `0.15`, published/linked `6fc26255`, done. | Integrator first applied still-unmerged `0.11`; its later Material read corroborates reuse but did not cause that first import. |
| 4 / `b2ba4464` | Integration Task `04cbc3ca`, E `6cb54927`: combined the three helpers on `0.14`, passed `2f3b3a22` over four modules, merged `0.17`, published/linked `83f15654`, submitted, done. | The fixed submitted tree was accepted by the independent final verifier. |
| 1 / `90f1c068` | Axiom/declaration audit Task `492991d7`, E `a31a82f0`: applied integrated `0.14`, saved separate audit module on `0.16`, passed `18dbf5a1` over five modules, delivered `3908b954`, done. | Further reuse of the integrated source; audit was corroboration and was not a substitute for final verification. |
| 2 / `acce8be6` | Cold-build Task `b195e0bc`, E `34f12e72`: managed checks passed main `0.10` and integrated `0.17`; intentional unmerged negative control `0.18` failed correctly. Delivered `017c319a`, finished incomplete. | No local Lean executable was available to establish the Task's requested standalone cache/exit evidence. Task reopened; no successor retook it before acceptance. Main remained `0.17`. |
| 3 / `1eb8db29` | Provenance audit Task `63cdc60a`, E `3260397a`: compared three producer revisions with integrated main and recorded Workspace uses, delivered `87cf0c7f`, done. | Verified byte-exact helper reuse and interface wiring; did not alter the already submitted proof. |
| 1 / `adc5ba9e` | Fresh Bot, discovery only after audit completion. | Public status/Task/file/Material reads; no Execution or delivery before closeout. |
| 4 / `f9eb67db` | Fresh Bot, discovery only after integration completion. | Pending-submission polls and public reads; no Execution or delivery. |
| 3 / `721a3cb2` | Fresh Bot, discovery only after provenance audit. | Mission/Task/Material reads; no Execution or delivery. |
| 2 / `0e3476c5` | Fresh Bot, discovery only after incomplete handoff. | Mission status query; no Execution or delivery. |

Seven Tasks and seven Executions were created autonomously: six finished done, one incomplete. There were seven Materials and nine explicit consumption records, which are not nine independent useful handoffs. Thirteen durable ordinary CheckResults exactly match the report's thirteen IDs and bindings: **8 PASS, 5 source FAIL, 0 infrastructure failures, 0 pending**. Four separate merge receipts checked combined trees at `0.6`, `0.10`, `0.15` and `0.17`; the final acceptance is a separate check. Ordinary checks used 13 of 20 admissions, zero infrastructure retries; final checking used 1 of 4 admissions. No selected-file placeholder rejection occurred in this run.

All eleven Bots are CLOSED. Independent scoped provider queries returned HTTP 404 for all eleven exact sandbox IDs. Cleanup took 1,057 ms, with no cleanup errors, unhandled rejections, heartbeat errors or watchdog errors. Initial READY events were one minute apart; replacement Bots did not repeat that stagger. The four `PROCESS_EXITED` discovery settlements occurred after accepted Mission stop, not during productive execution.

Raw RPC inspection found 22 Bash error completions: four source-check FAIL exits, sixteen unavailable-utility exits (six `jq`, six `python3`, three `python`, one `rg`), one denied scratch-file redirection and one listing of a nonexistent optional directory. Bots recovered with available Node/direct CLI operations or recorded the cold-audit limitation. These were shell-level failures, not Judge infrastructure or Bridge lifecycle failures. The analyzer surfaced eight of these events; zero report Core errors does not mean every shell command succeeded.

Recorded model usage: 181 requests, 179 with usage, **4,422,621 input tokens and 32,590 output tokens**; two settlements have unknown usage and none remain pending. Currency cost is unknown.

## Analysis

| Approved criterion | Assessment | Evidence and limits |
| --- | --- | --- |
| Stable useful work and lifecycle | PASS for observed interval | Distinct identities replaced completed Bots, later audits executed, and all resources closed. No permanent idle Core while useful work remained was observed. Budget expiry and one-hour endurance were not exercised. |
| Meaningful division | PASS | Three distinct geometry/counting responsibilities fed one integrator; follow-on audits and a positive/negative control had separate responsibilities. The cold-build responsibility was truthfully incomplete. |
| Public reuse and continuation | PASS | Independent Git comparison confirms the accepted target imports and references all three producer modules, byte-identical to `0.4`, `0.8`, `0.11`. It reused an unmerged revision. Later audit Bots used the integrated target. |
| Mission acceptance or substantial progress | PASS by trusted acceptance | Fixed main `0.17` passed the original theorem, allowed-axiom policy and kernel replay. Build success and Material counts are only supporting evidence. |

The interrupted EXP-03 and this repeat demonstrate different boundaries: EXP-03 established early collaboration but stopped on faulty error classification; EXP-04 completed without checker infrastructure failures and produced accepted cross-module integration. They are versioned acceptance observations, not a controlled causal or performance comparison. The parser regressions and exact old-tree replay establish the diagnosed repair separately.

The report's `checker_unassessed_count=13` counts the mathematical status of ordinary diagnostic checks, not pending or unclassified requests. Every ordinary receipt is terminal with its own source/build outcome; Mission mathematics is decided by the separate final verifier. The inherited generic `cheating_policy` metadata is broader than project-mode behavior: refused selected-file placeholders are request failures. This run exercised neither that refusal nor late check delivery after Bot fencing; deterministic regressions cover those paths.

## Next steps

The approved behavioral criteria passed. PR #128 can be closed out with this report, independent review and exact tested identities. Longer endurance, different problems or controlled comparisons would require their own approved run; this result does not establish them. Preserve the incomplete cold-build Task outcome as an evidence limit, not a failed Mission or completed audit.

## Evidence and limitations

The repository analyzer exited 0 and generated `analysis/experiment-analysis.md` with seven reconstructed Executions and no inventory warnings. Independent `analysis/bot-observation.md`, `analysis/system-observation.md` and `analysis/cleanup-verification.json` corroborate behavior and physical cleanup. Raw evidence is ignored under `experiments/EXP-20261116-04/`; the published document contains no raw conversations, proof source, stdout/stderr, credentials, private databases or private deployment paths.

Primary records are `state/projects/putnam_2025_b1/project.sqlite` (Task/Execution/Bot/submission), `context.sqlite`, `judge.sqlite`, `model-budget.sqlite`, immutable Workspace trees, Bridge/Runtime logs and metadata-declared `<external>/observability.sqlite`. Core 4 Bridge events at lines 67, 79, 100, 109, 121, 124, 130, 144, 155, 164, 178 and 183 connect read/apply/save/check/merge/use/submit/finish. Independent audits are linked by Core 1 lines 202–263, Core 2 lines 246–274 and Core 3 lines 153–185. Discovery-only actions use explicit Bot READY/CLOSED windows; no hidden reasoning or private Session inheritance is inferred.
