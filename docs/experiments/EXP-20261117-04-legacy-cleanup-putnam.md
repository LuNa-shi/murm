# EXP-20261117-04: Putnam acceptance after legacy execution cleanup

Status: COMPLETE — PASS; trusted Mission accepted, protocol valid, physical cleanup independently verified.
Implementation PR: [#139](https://github.com/LuNa-shi/SwarmEnv/pull/139). At experiment time this was stacked on [#134](https://github.com/LuNa-shi/SwarmEnv/pull/134); see the later integration note below.
Approved GitHub Issue: [#138](https://github.com/LuNa-shi/SwarmEnv/issues/138), [owner-authorized repeated one-hour runs](https://github.com/LuNa-shi/SwarmEnv/issues/138#issuecomment-6944184596).
Comparison to: [EXP-20261116-08](EXP-20261116-08-judge-queue-1h.md). This is engineering acceptance of the current registered lifecycle, not a causal performance comparison.

## Setup

Acceptance requires a fresh natural-Agent run with `protocol_valid=true`, trusted original theorem/type/axiom/kernel Mission acceptance, real Workspace/Judge lifecycle evidence and verified physical cleanup. Intermediate checker PASS, timeout or an unverified report alone is insufficient. Each authorized repeat receives a new ID and preserves prior results.

| Item | Fixed value |
|---|---|
| Implementation | `1eb4333a7e01e624c9599449b2960a97937105fd`, based on reviewed #134 integration `6136f079c1b1d04fb7cdabf02e57b79207d1e3b0`. Clean launch commit: `e8fd8427dbd8c98386677f39384b376427db014e` (documentation-only descendant). |
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

| Observation | Result |
|---|---|
| Time boundary | CLI metadata start **09:42:31.388 UTC**, November 17; trusted acceptance observed at **10:00:59.816**; CLI ended **10:01:27.466**. Startup to acceptance **18m28.428s**; total including cleanup **18m56.078s**, below the one-hour maximum. |
| Separate execution boundary | Parallel work began 09:44:54.383; work-start to acceptance **16m05.433s**. Project report elapsed **16m31.384s** excludes initial deployment; do not compare this with startup-inclusive durations. |
| Acceptance | Submission `submit-complete-grid-proof`, final CheckResult `treecheck:1802414a-3e7b-4975-9dd3-b0d8b5ffce4d`: **accepted / PASS** against the original theorem/type, axiom policy and kernel replay. Fixed main revision `0.39`, commit `3686ac7bceffb1720a2b7d4097da57efdfd387bb`, tree `9474b7f36271dd42826bbc25dd4a5919259a20a0`. |
| Protocol | `protocol_valid=true`, `invalid=false`, no invalid reasons; clean reviewed launch revision and pinned input hash match registration. |
| Lifecycle | 9 Tasks, 9 SUCCEEDED Executions, 12 CLOSED Bots across four Cores; all Executions have Session generation 1. All nine done Finish intents are closed. This includes observed Core reuse after confirmed Sandbox deletion. |
| Ordinary Judge | 32 admitted checks: **12 PASS / 19 source failures / 1 request rejection (`forbidden_placeholder`)**. Zero checker infrastructure failures. One separate final admission; no pending ordinary queue or final admission at shutdown. |
| Materials | 13 persisted Materials and 11 consumption records. These are activity counts, not proof of causal collaboration value. |
| Model usage | 268 requests, all with recorded terminal usage, none pending/unknown; **8,352,617 input / 50,020 output tokens**. Currency cost unknown. |
| Operational errors | Six recorded tool errors in `MAIN_MOVED`, `NOT_ALLOWED` and `MISSION_SUBMITTING` classes; zero tool-protocol errors, heartbeat errors, watchdog errors, execution-timeout errors or unhandled rejections. The run is not claimed to be error-free. |
| Observer default | `observability_enabled=false`, no observer metadata or newly launched observer server. Project-local storage retained **82,483 observation events**, alongside durable logs and authority stores. |
| Cleanup | Reported cleanup **1,631 ms**. Independent live checks confirmed **12 Sandbox GET 404**, Context/Judge processes and process groups absent, and **64 owned checker units inactive with no cgroups**. No pending gate, Finish, final admission, live Bot, release or stop obligation remains. |

Validation before launch: final full suite **681 total / 661 PASS / 20 environment-gated skips / 0 FAIL**; observer CLI subprocess checks **7 PASS**; committed image startup/large-input **3 PASS**, disk/inode confinement PASS, and real registered Bot/Bridge/Workspace/independent Judge FAIL→repair→PASS/replay/cleanup PASS with zero model calls. Independent Spec and Standards readiness passed, as did documentation generation/check and diff checks. The observer change does not alter any Docker COPY input from the tested image build.

Full offline experiment analysis completed with **zero inventory warnings**, reconstructing all nine Executions. An independent final Spec audit re-read authoritative records and repeated live provider/process/unit checks, confirming acceptance and cleanup.

## Analysis

The combined evidence meets the cleanup PR's engineering acceptance: the registered lifecycle handled autonomous task selection, four active Cores, immutable Workspace checking, completion, subsequent Bot startup, final trusted acceptance and physical teardown after alternate execution paths were removed. All recorded Session generations remain 1; no retired same-Execution replacement path was needed. Controlled fault/race tests provide the evidence for failures that this natural run did not trigger.

Disabling the observer server preserves offline evidence: the analyzer recovered the full execution inventory from local stores and logs without an observer metadata file. The CLI tests separately establish that default launch does not even probe configured observer metadata, and that explicit opt-in preserves the prior server path.

Ordinary source failures and the placeholder rejection occurred before final acceptance and are retained as observations. Their existence does not make the final theorem PASS a proxy result: the separate locked final verifier accepted the original target on immutable main `0.39`. Material and consumption counts alone do not establish useful reuse or a speedup. Runtime, launcher and inherited #134 changes make this a versioned engineering acceptance run; this single successful observation cannot attribute performance to legacy removal or establish one-hour endurance.

## Next steps

The requested first cleanup scope and final Putnam acceptance are complete; no additional model run is needed for the stated criteria. At experiment closeout both PRs remained unmerged. The owner subsequently authorized merging #139 independently while deferring #134. Broader redesign candidates remain outside this cleanup scope.

## Evidence and limitations

Authoritative evidence: `metadata/experiment.json`; Task/Bot/Execution/Mission and local observation rows in `state/projects/putnam_2025_b1/project.sqlite`; separate Context/Judge/model-budget databases; immutable public Workspace revisions; Agent/Bridge/runtime/service logs; `analysis/experiment-analysis.md`, `analysis/analysis-completion.json` and `analysis/service-cleanup-verification.json`. Reports are supporting projections, not substitutes for authority records. Raw conversations, proof/candidate source, credentials and private paths remain ignored and are not exported here.

The actual run binds the exact launch commit and image. Environment-gated unit checks remain explicitly skipped, while the listed production/image probes ran separately. Untriggered races, queue saturation and other fixtures are covered only by their stated controlled tests or remain unverified; this run does not cover every environment or claim a causal performance improvement.

## Later main integration

After this experiment, the owner authorized merging cleanup PR #139 while keeping FLT PR #134 unmerged. The cleanup was isolated onto main `0a1e6f794aee1c07eb5231075f0c59cf5467d3c1`; implementation `66aa686aaff66ee94d81d52c4b90054f4e3c9cbb` retains the generic preparation-lease renewal prerequisite and its two regression tests. The Runtime file is identical to the experiment-reviewed `f1049c3` file. FLT fixtures, profiles, checker/worker extensions and benchmark context additions are excluded.

EXP04 retains its original launch, image, checker and input identities above. It was not rerun on the isolated main integration tree; that integration has separate local verification recorded in PR #139. The historical result is not represented as a formal run of the new commit.
