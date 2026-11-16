# EXP-20261116-07: Independent services and centralized Lean checks, one-hour maximum

Status: COMPLETE — trusted Mission accepted; provider interruption recovered; ordinary check budget exhausted
Approved GitHub Issue: [#130](https://github.com/LuNa-shi/SwarmEnv/issues/130), latest owner decision approving lightweight Bots, Judge-only Lean checks, unchanged ordinary limits and one 1h-limited repeat.
Implementation PR: [#132](https://github.com/LuNa-shi/SwarmEnv/pull/132).
Repeat of / comparison to: [EXP-20261116-04](EXP-20261116-04-workspace-project-1h.md). This is a versioned engineering/behavioral acceptance repeat, not a controlled estimate of centralization's causal benefit.

## Setup

Observe autonomous Task proposal/take/finish, development feedback through saved-revision Judge checks, public Workspace/Material reuse, and progress toward the same B1 Mission. Bots have general tools but no local Lean/Lake/Mathlib; Context/Judge run independently. Distinguish source errors, capacity rejection, exhausted budget, infrastructure failures and final acceptance. No operator-authored research Tasks, candidate solutions or scripted model answers.

| Item | Fixed value |
|---|---|
| Clean runtime | `e18c7ae5bce48d73cf248c14080dcdf2327476fb`; independent incremental Spec/Standards PASS, following reviewed service implementation `daf0b0a`. Launch registration was documentation-only; metadata records clean launch `a8ca2309389e7578114dcfa12ff7b37172331d37`. |
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

The CLI ran **08:26:29.724–08:48:07.047 UTC** on clean launch commit `a8ca2309389e7578114dcfa12ff7b37172331d37` (runtime `e18c7ae`). The report's project interval was **08:28:55.939–08:48:05.702 UTC**, **1,149,763 ms (19m09.763s)**. Trusted acceptance triggered normal early closeout: **solved=true, protocol_valid=true, invalid=false**, no invalid reasons. This did not exercise a full hour of endurance.

Submission `submit-complete-main-9a69b929` fixed main `0.39`, commit `ccf1dced3c7a06c7043ca96d45a998522da10a4c`, tree `dda4a5716b434458aff1251ffebaffaf700d81b0`, and Material `de9b84c1-b0da-42f2-9803-989573f9675e`. The locked final theorem/axiom/kernel check `treecheck:61005b5f-1d5e-424f-95e1-49a382ac4793` returned PASS at **08:47:34.632 UTC**. This final receipt, rather than an ordinary project diagnostic, establishes Mission acceptance.

| Observation | Recorded result |
|---|---|
| Independent deployment | Context and Judge used separate PIDs/databases and authenticated HTTP; Task/Mission/Workspace remained the coordinator. |
| Research lifecycle | 9 Tasks, 13 Executions, 16 Bots; 6 Tasks DONE and 3 OPEN at close. Executions: 6 SUCCEEDED, 2 HANDED_OFF, 5 FAILED. |
| Ordinary Judge | 26 calls: 20 admitted/persisted checks (**8 PASS, 12 source FAIL, 0 infrastructure failures**), 5 budget rejections and 1 capacity-busy rejection. The persisted policy stayed 20 total / 2 concurrent, with 0 infrastructure retries. |
| Check processes and latency | 20 preflight and 20 source process starts; 0 active admissions at end. CheckResult created→updated duration: median **15,332.5 ms**, p95 **40,323 ms**, maximum **40,331 ms** (20 records). These are persisted request intervals, not pure compiler CPU time or a complete end-to-end queue metric. |
| Separate merge/final paths | 9 merge calls: 8 advanced main, 1 rejected. One final Mission admission, PASS. These are outside the ordinary 20-request counter and must be reported separately. |
| Public evidence | 14 Materials and 16 explicit consumption records. Counts alone do not establish useful reuse. |
| Model transport | 314 requests, 296 with recorded usage; 18 unknown-usage settlements and 0 pending. Unknown reasons: 17 upstream HTTP errors and 1 missing trusted terminal usage. Recorded usage: **8,977,746 input / 61,313 output tokens**. Currency cost is unknown. |
| Cleanup | Reported physical cleanup 1,067 ms, no cleanup errors, heartbeat errors, watchdog errors or unhandled rejections. Independent post-close audit: all 16 scoped provider resources GET 404; both peer PIDs and process groups absent; all 41 Judge-owned ledger units settled/inactive with no ControlGroup; pending lifecycle gates, Judge/final admissions and running CheckResults all zero. |

The general-tool/no-Lean image contract passed **2/2 actual-worker tests** and the real disk/inode/Landlock probe. Full regression passed **628/642**, with 14 environment-gated skips and no failures; separately enabled production probes cover the stated checker/image boundaries. Independent code Spec/Standards reviews passed. The completed full evidence analyzer exited 0 and wrote `analysis/experiment-analysis.md`, identifying 13 Executions and reporting no inventory warnings. These checks do not imply that every possible fault was exercised.

### Natural development and reuse

Core-2's Execution `f177a786` first received source FAIL in `c1e44d17-de51-46ca-bec0-cbfbc48e27e0`, modified its bridge module, saved again and obtained PASS in `9c27a98f-f055-4eb2-abe6-365685c31958`. It merged main `0.5`, published `2fb4a0d8-1ea8-4e6f-b9e5-3cb2053795e6`, and finished Task `e6445b0b` DONE. Core-4 then imported and used that interface in its own module, followed by PASS `805552db-3d79-4303-9626-33804df1762c`. This supplies an actual edit/save/check/repair loop and downstream source use, beyond a Material-read count.

| Task prefix | Responsibility | Terminal Task state / evidence boundary |
|---|---|---|
| `e6445b0b` | Circumcenter/color interface | DONE; source repair and interface reuse observed above. |
| `a37d5861` | Finite counting obstruction | DONE; delivered a reusable checked component. |
| `48fb1a28` | Circle-point affine independence | DONE; imported the earlier bridge interface. |
| `df66fce9` | Capacity interface and abstract assembly | DONE; incorporated public geometry/counting inputs. |
| `ba535331` | Scalar grid arithmetic | DONE; persisted reusable checked support. |
| `db13357a` | Main geometric proof | OPEN after provider failure; Task state is separate from the subsequently accepted public main. |
| `e80356a3` | Independent helper/axiom audit | OPEN after three Executions, including two truthful incomplete handoffs; ordinary budget exhaustion left additional audit work unverified. |
| `1dda7b52` | Source import-closure provenance | DONE after a provider-failed attempt and a successor. This static source task is not evidence of Bot-local compilation. |
| `4909dcb9` | Statement source-integrity preflight | OPEN; provider failure followed by an attempt stopped during accepted-Mission closeout. |

Review of all **216 recorded Bash tool-starts** found no execution of local Lean/Lake/elan or toolchain install/download commands. Exact image tests also establish their absence. This is evidence about the recorded paths and run, not an unrestricted security claim about arbitrary programs.

### Budget exhaustion and upstream interruption

Ordinary admissions reached 20 during the run. Later `CHECKER_BUDGET_EXHAUSTED` responses did not launch more ordinary checks. Audit work recorded the limitation and preserved unverified artifacts rather than inventing PASS. After ordinary exhaustion, three merge requests occurred: `merge-final-1` from `0.33` failed; `merge-assembly-1` from `0.34` passed and published main `0.36`; `merge-final-2` from changed revision `0.38` passed and published main `0.39`. Their inputs and outcomes changed; no intent is inferred. The current policy therefore bounds ordinary diagnostics, not total Lean compilation across all paths.

A burst of upstream HTTP errors interrupted four Executions (`bb43e484`, `c97489e8`, `927b9976`, `9601f8d9`) with `provider_failure`. Subsequent requests recovered and work continued with new Bot identities. The gateway retains a sanitized rejection and does not preserve enough upstream detail to establish the original provider status/cause. The fifth FAILED Execution, `b4f380ba`, has reason `benchmark_deadline_cleanup` **after trusted acceptance**; the report records `deadline_reached=false`. It must not be counted as a fifth provider failure or a one-hour timeout. The runtime's accepted-Mission closeout and final physical cleanup are separate intervals.

## Analysis

**The centralized-check development design worked in this run.** Bots naturally used saved revisions, received actionable source failures, repaired code, reused public components and reached trusted final acceptance without a local Lean runtime. The independent service boundary retained admission, replay and cleanup behavior on the observed path.

**The 20-request limit became a real constraint.** It was exhausted and blocked some additional audit checks. Final acceptance still succeeded through the unchanged separate merge/final policies. This supports keeping the current owner-selected limit provisionally, while making its scope explicit; it does not prove 20 checks will suffice for other problems or that all compiler work has a global limit of 20. No budget was increased during this run.

**Operation was not interruption-free.** Four Executions failed during the upstream rejection burst and successors resumed public work. There were no observed Judge infrastructure failures or leaked service resources. These facts separate provider availability from the source-check design; they do not establish the upstream root cause or universal recovery coverage.

EXP-04 accepted in 9m23.520s and this run's project interval was 19m09.763s, with more ordinary source failures and an upstream interruption. Model choices and Task decomposition varied, and tool guidance plus service deployment changed together. This single comparison cannot attribute timing, token usage or success to centralization alone. A natural early success is not an hour of endurance evidence.

## Next steps

- Keep Bot images lightweight and Lean checks on Judge; retain the current 20/2 ordinary policy as explicitly directed by the owner.
- Preserve the observed budget limitation and upstream interruption in Issue #130/PR #132. Changing quotas, adding a global check budget, or initiating another paid run requires a new owner decision.
- Finish release integration only against the verified runtime plus reviewed documentation/governance changes. The new worktree-location rule is a post-run development instruction, not a change to the tested runtime.

## Evidence and limitations

Authoritative evidence: `metadata/experiment.json`; `state/projects/putnam_2025_b1/{project,context,judge,model-budget}.sqlite`; fixed public Workspace Git revisions; actual Agent/Bridge/Runtime/Service records; metadata-declared `<external>/observability.sqlite`; and report files as checked projections. Final acceptance is the submission/check identity cited above.

Detailed local analysis: `analysis/experiment-analysis.md` (full analyzer, exit 0); independent provider audit `analysis/cleanup-verification.json`; independent service/process/unit audit `analysis/service-cleanup-verification.json`. Request-level latency was derived from Judge's persisted created/updated timestamps. The analyzer's generic shell-error and historical lifecycle labels are supplemented by direct operation, same-Task Execution and source-use review; zero inventory warnings do not replace that review.

Independent peers do not emit every in-process checker stage log. Phase receipts, CheckResults, budget tables and the unit ledger establish the stated peer outcomes; missing stage detail is not zero work. The audit of 41 ledger units covers Judge-owned units; merge/final work is additionally covered by its own settled admissions and accepted receipts, not silently included in that ledger count. Raw conversations, proofs, credentials, stdout/stderr and private paths remain in ignored storage.
