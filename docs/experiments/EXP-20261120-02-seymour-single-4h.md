# EXP-20261120-02 · SeymourSecondNeighborhood, one project and four Cores

## Setup

The owner requested a four-hour, single-project run after correcting the turn lifecycle defect observed in the first pair. Only the first configured entry is in scope. [Issue #153](https://github.com/LuNa-shi/SwarmEnv/issues/153) · [Interrupted pair](EXP-20261120-01-openai-math-first-pair.md)

| Input | Value |
|---|---|
| Host runtime | `4c2f19312ea4f3680ee0b1d5c9bec6a026aa8246` |
| Fixture and target | `oai_seymour_second_neighborhood`, `OAI.SeymourSecondNeighborhood.exists_goodVertex`, source `fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98` |
| Lean and Mathlib | 4.34.1, `d13f23b723b8a846827a245b89c10fc7d3f11612` |
| Checker | `openai-math-v1`, lock `f0a85f1886c8fc546dfb925a9133908e1e69ff96c8bd4ddd80d303c4adadf891`, 600 s per ordinary or final check, 8 GiB, 200% CPU, one Lake job. Full private target control passed in 55.580 s. |
| Model and image | `gpt_proxy/gpt-6.2-sol`, `swarmenv-agent:openai-math-wait-b56d030`, image ID `d09c08f6859cb5ee0d75ae2c370fed47eefab4a9ece217e9ffb446ee00e0d7cf` |
| Initial state | Fresh public Workspace with the pinned challenge, no previous project state or reference proof. Each Core receives the ordinary SwarmEnv discovery prompt. The project report records actual prompt and service schema hashes. |
| Launch | `scripts/run-openai-math-round.mjs`, this problem alone, project parallelism 1, four Cores, project and Bot limits 14,400,000 ms. No other model experiment runs concurrently. |
| Stop conditions | Trusted Mission acceptance, the four-hour deadline, operator request or a reproducible engineering failure that compromises the four-Core observation. Preserve partial evidence if stopped. |
| Evidence | Private `experiments/EXP-20261120-02/` holds launch metadata, project report, raw events, SQLite stores and immutable Workspace revisions. A read-only observer records project state on a minute cadence. |

Observe per-Core discovery dispatch and Task takes, how replacements recover from expiry or handoff, and the chain from checked lemmas to incorporation into the main proof. Classify source failures, infrastructure errors, interrupted model receipts and final Mission submissions separately.

## Results

The single project reached its pre-registered deadline on 2026-11-20 UTC. The protocol was valid and the general theorem was unsolved. The runner recorded no early exit, no operator signal, no invalid reasons, no Mission submission and no acceptance. No second project ran. The tested checkout was `ca8577734b89660cdfd1a4ec090159e05789c0d3`, recorded in both the launch inputs and the round summary. The nested project report's optional repository commit field was null.

The supervisor's service clock measured 4 h 17.458 s from launch to exit. The project report measured 03:19:32.888–07:17:41.028 UTC, or 3 h 58 min 8.140 s after setup, including 6.806 s of cleanup. Setup used part of the four-hour budget. All 97 Bots closed, the runner exited successfully, and the read-only observers exited. No run worker container, active checker unit or unsettled Judge admission remained. The report recorded zero cleanup, heartbeat and watchdog errors.

| Core | Bots | Executions created | Started | Succeeded | Handed off | Failed | Judge checks | Workspace writes | Model attempts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 26 | 22 | 19 | 17 | 1 | 4 | 84 | 102 | 717 |
| 2 | 23 | 20 | 19 | 15 | 2 | 3 | 74 | 89 | 719 |
| 3 | 35 | 32 | 28 | 25 | 2 | 5 | 81 | 105 | 781 |
| 4 | 13 | 12 | 12 | 7 | 4 | 1 | 134 | 136 | 704 |
| Total | 97 | 86 | 78 | 64 | 9 | 13 | 373 | 432 | 2,921 |

The report measured mean active Core count 3.79 and peak 4. The project had 71 Tasks, 70 Materials and 120 recorded Material consumptions. Of 2,921 model attempts, 2,871 had trusted terminal usage. The remaining 50 consisted of 43 interrupted streams, six missing terminal usage receipts and one HTTP 503. Observed usage was 169,200,328 input tokens and 1,279,215 output tokens across attempts with receipts. No monetary cost was recorded. The per-Bot file includes all 97 lifetimes, prompt dispatch counts, attempts, Execution outcomes and attributed Judge checks. A dash denotes an absent field, including an unset Bot exit reason. Free-text Execution reasons are summarized as `handoff` or `other` to keep candidate and conversation details private. [Per-Bot outcomes](EXP-20261120-02-bot-outcomes.tsv)

### Mathematical results

The goal asks for a vertex in every nonempty finite oriented graph with at least as many strict second neighbors as first neighbors. Final main was revision `0.418`, Git `f1a950342bf3cebd2b80bb34554c7bc4c89e9e56`. The goal file had its original SHA-256 from Setup and retained its one proof hole. The following milestones use immutable Lean checks and main-file evidence.

| Scope | Evidence and extent |
|---|---|
| Low minimum outdegree | The initial degree-at-most-two result was consumed at 03:26:04 UTC by the degree-three Execution. The workers subsequently closed degrees four and five. For degree five the ambient proof consumed finite-counting Material `40b84f33-3846-4e86-baea-d1770150a899` at 04:12:12 UTC. Execution `2ac77ef5-424e-4af2-a034-0854d611bc49` passed check `8a966d7b-1af7-401e-9ede-792172517d83` at 04:13:06 on revision `0.137`. Its file matches final main byte for byte. |
| Additional graph classes | Main incorporates tournaments, tournaments with a missing matching and special cases using weighted substitution. The missing-matching module passed on `0.217` (check `59194841`). The balanced regular dense-order result reached order `2d+11` (`0.414`, check `b06709a5`). |
| Degree six | Workers checked structural reductions, counting bounds, pruning and soundness of a finite search. The search still required a complete Lean-checked certificate excluding the residual configurations. No unconditional degree-six result was established. |
| Degree seven | The restricted case with exactly five strict second neighbors was checked at 06:25:12 UTC (`0.372`, check `f86d9e14`, Material `232bbe81`). Other degree-seven cases remained open. |
| Another residual | For out-regular order `2d+3`, the case with at most four universal vertices passed (`0.408`, check `a2d4b96a`). The residual with five universal vertices remained open. |

### Runtime and checker observations

The previous two-project attempt stranded replacement Bots after their predecessor's session ended during Task preparation. The owner-token repair was independently reviewed before this singleton launch. The pre-launch full suite had 711 passes, 38 skips and zero failures. The natural traces below cross-check the deterministic regression. A selection window was 120 s.

| UTC | Core | Old Execution prefix | Outcome after selection expiry during preparation |
|---|---:|---|---|
| 05:18:10 | 3 | `7c2e15a4` | First replacement began a new Execution |
| 05:18:25 | 2 | `6b5a9771` | First replacement began a new Execution |
| 05:33:16 | 1 | `58cd55fb` | First replacement began a new Execution |
| 06:29:27 | 3 | `9bc08f3c` | First replacement failed at startup, second began a new Execution |
| 06:35:37 | 1 | `6ac435a2` | First replacement began a new Execution |
| 07:01:26 | 3 | `bd4c5dce` | First replacement failed at startup, second began a new Execution |
| 07:06:57 | 1 | `a07d9a67` | First replacement began a new Execution |

All seven old Executions closed without a start timestamp. Session close and take failure are adjacent in the event stream (e.g. sequences 1016130–1016131 on Core 3 and 1020871–1020872 on Core 2). None of these seven left its Core stranded. The two immediate startup failures closed 4–5 ms after registration, before sandbox dispatch or readiness. The exact startup exception was not persisted. Three of 97 Bots closed without receiving a prompt, including those two immediate failures and one at the overall deadline. A separate Core 3 preparation at the project deadline also rolled back. Final Execution failures comprised seven selection expiries, five provider failures and one lifetime expiry. The 97 Bot rows had 73 unset exit reasons, 14 selection-budget, five provider-failure, three lifetime-budget and two startup-failed.

Of 373 Judge checks, 148 passed at their checked scope, 211 had Lean source failures, nine were labeled `checker_crashed` and five were labeled `lean_resource_limit`. Inspection of the nine labeled crashes found four confirmed cgroup OOM kills at 8 GiB, three unexpected build exits with their underlying compiler cause unknown, one successful build with oversized diagnostics and one frontend error without a recognized diagnostic. The five separate Lean resource failures include recursion depth or heartbeat limits. The Mission received zero final submissions.

Merge verification had a separate failure. There were 74 Bridge merge calls spanning 67 logical request IDs. Responses comprised 59 successes, 13 stale-main conflicts and two timeouts. Both timeout responses belonged to `d6-9425-merge-426`; the second replayed its saved result. The effective deadline was limited by the remaining Execution handoff window. The checker unit ran for about 140 s, peaked around 789 MiB and was stopped at that deadline. Revision `0.426` remained available as a candidate. The final main pointer remained `0.418`. The 600 s checker ceiling was configured correctly, but a late merge can have much less usable time.

| Judge check prefix | Revision | Independent evidence for the recorded crash label |
|---|---|---|
| `405569a0` | 0.70 | Unexpected build exit, underlying Lean exit cause unavailable |
| `76c1e8cd` | 0.80 | Kernel cgroup OOM kill at 8 GiB |
| `f040ac01` | 0.88 | Build exited successfully, diagnostic output exceeded retention bound |
| `0d2b9871` | 0.95 | Frontend returned an error without a recognized diagnostic |
| `88d6aeb0`, `c8cba41d` | 0.161, 0.163 | Two unexpected build exits, underlying causes unavailable |
| `a632591c` | 0.343 | Cgroup OOM at 8 GiB after about 135 s |
| `7f82cd44`, `af922c4f` | 0.406, 0.419 | Same count-probe file content in different trees. Both were killed at 8 GiB. |

None of these nine inputs subsequently passed an independent check with the identical full tree, path, mode and environment.

## Analysis

The singleton produced both checked mathematics and a natural test of the lifecycle repair. Five immediate replacements and two second replacements recovered from the same preparation-window failure that stranded a Core in the interrupted run. Two startup failures remain incompletely diagnosed. A single repaired run across these seven occurrences cannot estimate a general recovery rate.

The strongest observed chain from shared work through Lean verification into final main is the degree-five result. The degree-six route had a concrete gap between a sound search procedure and a complete kernel-checked certificate. A later merge lost time to its handoff deadline. Neither an unfinished merge nor a larger ordinary-check budget explains the unchanged general target on its own. The fixed reference's 55.580 s PASS demonstrates feasibility with a supplied proof. It measures verification time, while these workers had to discover and assemble a proof from the public challenge.

## Next steps

The owner's current plan stops after this one project. The most directly testable engineering follow-ups are to retain the original pre-sandbox launch exception, distinguish OOM and diagnostic overflow in Judge receipts, and expose the remaining handoff-limited time before a worker requests a merge. These observations alone give no comparison between one and two concurrent projects.

Private evidence in the ignored run directory includes the round summary, full project report, four SQLite stores, immutable Workspace revisions and per-Core event logs. The independent reviews are under `analysis/` in `independent-final.json`, `independent-bots.md`, `independent-math.md`, `independent-checker-final.json` and `independent-checker-journal.ndjson`. Minute-level Bot samples, ten-minute mathematical snapshots and the external resource observer retain the sequence of events. The committed per-Bot table contains only operational metadata.
