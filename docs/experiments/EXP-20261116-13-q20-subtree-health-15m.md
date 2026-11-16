# EXP-20261116-13: Q20 root-only Workspace, four Core, 15-minute health observation

Status: COMPLETED — protocol valid; Q20 unsolved; operational health PASS
Approved GitHub Issue: [#135](https://github.com/LuNa-shi/SwarmEnv/issues/135), with [latest autonomous execution policy](https://github.com/LuNa-shi/SwarmEnv/issues/135) recorded in its discussion; original migration [#133](https://github.com/LuNa-shi/SwarmEnv/issues/133).
Implementation PR: [#134](https://github.com/LuNa-shi/SwarmEnv/pull/134), stacked on #132; no merge.

This is the first formal **root-only** Q20 run. It is a new input/submission
variant, not a rerun of the held original proof-cut [EXP12](EXP-20261116-12-flt-q20-after-q10-1h.md).
Q10 acceptance was established under the original profile; it is not relabeled
as a result for the new variant. Q100 is deferred.

## Setup

Observe whether four independent Cores can use the minimal initial Workspace to
propose research Tasks, develop definitions/lemmas, save/check code and share
useful Material. Distinguish model reasoning, coordination/queue waits, project
compilation and final checking. This short run checks operational health before
a longer observation. Four Core slots are fixed; checker resources may be
adjusted under the owner's authorization. No matched single-Agent comparison
is run, so no measured Swarm speedup can be inferred from this observation alone.

| Item | Fixed value |
|---|---|
| Clean runtime | `d79ace7d514189c5d8b785cc2f03018f2217691c`; the registration-only launch commit is recorded in run metadata. |
| Input profile | `flt10-subtree-v1`, `flt10_q20_reducible_cofixed`; public fixture Git `ebfceac37e3151e25d794faef18e0ecc85c64629`. |
| Target | `q20/Target.lean`; source SHA256 `58322c61b46c9e6709480e6900d7f5e4fc10bd5e215be53c64f5a6877d2c61a2`; fixed declaration `FLT10Bench.q20_frey_reducible_hasCofixedLine`. |
| Public context | Eight files total: target, three reduced definition modules plus import frontier as readable references, neutral README and applicable license/notices. Context manifest SHA256 `81bc9119239e4a8e41c1373789b56b6470e80f13bd336bd33cd7521b32c9ec6c`; no original helper catalog/DAG/proof files. |
| Foundation | Manifest SHA256 `a1fe9830013bdc1c8de9905b78567012e245c31dd5076671b191e118c83b595a`; three foundation modules / 17 retained declarations. Initial compilation and original elaborated root-type identity PASS. |
| Sources | FLT `aa2d8b34692b16c70f699536de0d8e75b9a3e9ef`; Mathlib `db584cd6d46c92f209a44c0f1c829460d327499d`; Lean 4.33.1; existing pinned Comparator/exporter. |
| Checker | Artifact lock `cc74232b546921acaf2bfe03d2ae8a492cc64b633ac56cfdbc21cba7b1959139`; full project proof reconstruction, fixed target comparison, axiom check and kernel replay. |
| Correct-answer gate | Complete 179-file private witness PASS `treecheck:75314739-230b-40aa-b214-cd42a7240a9b`; receipt SHA256 `44d91bcf0c69a448f0f7be2682842c4916e95fef6e12a4fbd5c44ee9a86dc25c`. The witness required one upstream proof compatibility repair, without changing the target or public foundation. Source remains operator-private. |
| Provider/model | Existing `gpt_proxy/gpt-6.1-sol`, revocable per-Bot credentials. |
| Research resources | Exactly 4 Cores; project parallelism 1; maximum 900,000 ms including project initialization; 60,000 ms initial staggering; Bot/Execution maxima 1,800,000 ms, clipped to Mission time; selection 360,000 ms. |
| Judge resources | Ordinary source/project cap 180,000 ms; four running / eight queued / 120,000 ms queue wait. Final cap 3,600,000 ms, clipped to remaining Mission time. Default final admission count/concurrency unchanged. |
| Checker process resources | 64 GiB, no swap, 128 tasks, 800 percent CPU, four Lake build threads; individual Lean compilers remain `-j1`. Defaults for other deployments remain unchanged. |
| Bot isolation | OpenSandbox, no local Lean; 256 MiB / 16,384-inode project quota; production UID/Landlock/network policy. Only the Bridge/model gateway endpoints are reachable. Public Mathlib remains available through its internal service. |
| Worker image | `swarmenv/agent:flt-d79ace7`, `sha256:47a64f1bbb4ad39f2c1d57df6d65852b2037d83789f5546ec8c265ed67341d83`; built from committed allowlist. |
| Prompt/schema | Generated prompt manifest `627cfbb6e93acf667d129ff26ad1806c84dadbb33d9121577cc7ce468cfe4bfa`; service catalog source `951de6a9e5ef0bdfee80f36263b508783256c55f5834b28ed1485e3385983e7b`. Runtime service manifests and per-Bot resource receipts are retained in raw evidence. |
| Stop rules | Trusted Mission acceptance and cleanup, 15-minute deadline, startup/integrity failure, or operator stop. Do not launch the next formal run until all discovered implementation problems and review findings are resolved. |
| Evidence | Ignored `experiments/EXP-20261116-13/`, `reports/EXP-20261116-13/` and private launch/preflight staging. No proof source or raw conversations are committed. |

The configured public instruction permits new definitions, lemmas and modules;
it supplies no decomposition. Task/Material/Workspace/Core behavior is unchanged.
The exact public README is hashed in the context manifest and its template/send
conditions are documented in Architecture 08.

```sh
MATHLIB_SEARCH_SOURCE_ROOT="$FLT_MATHLIB_SOURCE" \
SWARMENV_SANDBOX_ENABLED=true SWARMENV_SANDBOX_PROVIDER=opensandbox \
SWARMENV_SANDBOX_IMAGE=swarmenv/agent:flt-d79ace7 \
node scripts/run-putnambench-benchmark.mjs \
  --problems "$DEPLOYMENT_CONFIG" --benchmark-root "$PUBLIC_FIXTURE_ROOT" \
  --problem flt10_q20_reducible_cofixed --cores 4 --project-parallelism 1 \
  --timebox-ms 900000 --initial-bot-stagger-ms 60000 \
  --bot-max-ms 1800000 --selection-timeout-ms 360000 \
  --execution-timeout-ms 1800000 --checker-timeout-ms 180000 \
  --provider gpt_proxy --model gpt-6.1-sol --observability-port 0 \
  --experiment-dir experiments/EXP-20261116-13 --report-dir reports/EXP-20261116-13
```

Site lifecycle/Bridge settings use the previously validated local deployment.
The private launcher checks the exact image and clean checkout. Timed startup
requires the pinned complete-witness receipt before Bot/model initialization.

Health before extension means successful Bot binding and a real
Workspace/Judge/feedback cycle, useful Task activity, enforced input/network
boundaries, and no unresolved repeated infrastructure failures or cleanup leaks.
Ordinary mathematical source FAIL is feedback, not by itself an infrastructure
failure. A longer run receives a new EXP ID and multiple independent code reviews
before launch. The owner permits repeated experiments and resource adjustments;
Core count remains four.

## Results

Launched from clean commit `ef2ccb56968eb5346ab6ed4ef15abc6312c5a6e9`,
runtime `d79ace7`, at 14:52:32 UTC. Initialization completed at 14:55:02;
research activity ended at 15:07:33 against the 15:07:32 Mission deadline.
The runner and full experiment analyzer both exited 0. Protocol valid, no
invalid reasons, Q20 **unsolved**, and no Mission submission. Initialization
consumed about 150 seconds of the 900-second allowance.

| Observation | Result |
|---|---|
| Tasks / Executions | 13 / 17; final Tasks: 10 DONE, 2 OPEN, 1 CANCELLED. |
| Independent Judge | 17 source/project checks: 9 PASS, 8 source FAIL; 0 infrastructure errors. These are not complete-root acceptance. |
| Context | 12 Materials; 8 recorded consumptions: 5 workspace, 2 route, 1 task. Counts alone do not establish reuse. |
| Workspace | 31 immutable revisions; main `0.27`, commit `7f342027ad6a337d47692f180e1cde20005093f7`. Seven helper modules on main; unchanged root still contains its initial `sorry`. |
| Runtime concurrency | Mean active Cores 3.338 over 751.472 seconds after initialization; all four active for 459.327 seconds. Where at least four eligible work items existed, mean active Cores 3.943. These are occupancy measures. |
| Unassigned work | Ready-work 179.436 seconds; ready-but-unassigned 167.015 seconds. These overlap other work and are not four-Core idle wall time. |
| Model usage | 270 requests; usage reported for 267: 7,049,143 input and 47,563 output tokens. Three requests have unknown usage; monetary cost unavailable. |
| Cleanup | All 20 Bots CLOSED and all 20 provider lookups 404; 35 checker units settled, none live; no pending Judge admissions or model requests; both service peer PIDs absent; reported cleanup errors empty. |

Concrete downstream use is present: Task
`25ddeafe-b76a-4fb5-919d-22b4d56ce772` produced the displacement interface;
Task `8c6c5f98-b17a-41e3-8c67-99ed58085e2d` recorded workspace consumption
and its checked successor module imports that interface. Judge PASS
`6090e18b-67db-46f9-b9b0-3110094bc18e` records that successor check.
This establishes reusable checked code across Tasks, without establishing a
complete proof or a numerical parallel speedup.

## Analysis

The minimal Workspace supports autonomous Task proposal, definitions/lemmas,
public Mathlib use, multi-file checking and cross-Task reuse. Concurrent work
produced generic representation lemmas, a checked obstruction to an overly
general implication, and reductions of the arithmetic assumptions. The unchanged
root and absence of a Mission submission show the important limitation:
checked local work has not yet closed the arithmetic gap required by Q20.
A longer observation tests whether this work can converge; it does not assume
that more helper files imply progress toward acceptance.

Automated analyzer findings require semantic qualification. Its 48.8-percent
Execution-duration proxy differs from the Runtime occupancy measure above;
neither measures mathematical productivity. Repeated `source_failure` labels
are too broad to establish repeated identical reasoning, and the affected
Tasks subsequently obtained PASS. Unconsumed Materials may reflect timing or
independent work; their count does not establish a coordination defect.
Independent health review found no blocking implementation defect. The report's
11 Bridge errors comprise six soft-closeout rejections, two main-revision
conflicts, two absent-revision reads and one Task quota conflict. Agent tool
errors have a different scope; the analyzer's count of 27 must not be read as
27 infrastructure failures. At 15:04:32, the existing three-minute closeout
window began; new Executions immediately inherited closeout and could save,
publish and finish but could not start Judge/apply/merge work. Repeated
handoff/retake during this tail consumed time without new checked work. This
is a documented lifecycle efficiency limitation, not evidence of a timer bug.
Changing that policy would alter the core lifecycle and is outside this run. The final FAILED Execution explicitly records
`benchmark_deadline_cleanup`; two OPEN Tasks are unfinished obligations.

## Next steps

Independent health review passed with no implementation blocker. Register a
fresh one-hour four-Core Q20 run
with new independent Spec and Standards launch reviews. Start again from the
same eight public files; do not inject EXP13 discoveries into the input. Keep
Q100 deferred and preserve the core Swarm algorithm. A matched single-Agent
comparison has not been authorized under the current exactly-four-Core policy,
so these results cannot establish measured speedup.

## Evidence and limitations

The complete-witness receipt binds the public target/context and checker lock.
The final worker image has a separate actual eight-file UID/Landlock/network
audit and cleanup evidence. The tested access boundaries do not establish absence
of pretraining contamination or every possible covert channel. Private reference
source, inert proof exports, logs and databases remain outside public Agent input.
