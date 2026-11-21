# EXP-20261121-02 · Seymour paper with the native-style initial assignment

## Setup

The owner directed a fresh rerun after inspecting paper visibility in [EXP-20261121-01](EXP-20261121-01-seymour-lean-parity.md) and asked to align the initial assignment with native Agensh. The experimental change is `OPENAI_MATH_SEYMOUR_MATCHED_BRIEF=1` in implementation `365d3d9ec1f52fe7759d3752be61c266e6f826b6`. Each Bot receives the same original-proof and manuscript-formalization assignment, adapted to the SwarmEnv shared Workspace. The initial Task list is empty. Bots select and divide responsibilities through their native coordination flows. Compare with [Agensh EXP-20261120-09](EXP-20261120-09-agensh-seymour-paper.md).

The first round was stopped before this repeat. Fresh project data and sessions receive the same pinned Seymour target and manuscript 173 PDF/text, without previous artifacts. Four reusable Cores, Pi 1.3.0, gpt_proxy/gpt-6.2-sol medium, four-hour research and Bot windows, and the pinned 600-second independent checker stay as registered for EXP-20261121-01. The image, public Lean and Mathlib resources, 4 CPU/8 GiB worker limits, disk limits, provider and acceptance inputs are reused. Stop on trusted acceptance, the four-hour cutoff, protocol/input-integrity failure or owner request. No automatic restart after this attempt.

The prompt source manifest SHA-256 is `668a26ae0dba0aabc4a10e4a77f8c304039e348d2018ccb3501a28d818b1a681`. The Service API reference SHA-256 is `a97723caa2d59b2b6f9cbf1afe8e7ce5adec7821ebb112115db7a9e164ac6e86`. Observe the actual initial prompts, first paper reads, early task choices, manuscript integration, first trusted root PASS and clean settlement. The interrupted prior attempt and historical native run are case comparisons.

## Results

**PASS, score 1.00 by whole-target acceptance.** The independent Judge accepted submission `final-seymour-main-064` at 12:37:33.758 UTC. The accepted tree `0bef53d1fc319919f5cae07fe369b2752a9c09b8` matches settled main `590a4bd7be43df031ada437db9c7f0d985eeac1e` (Workspace revision `0.64`). The final receipt is `treecheck:f4c5190a-8363-4ab6-8a65-eea568b75f40` under the registered checker lock `c27ee1a3`. The round was protocol-valid.

The run used checkout `028f9d2827c23bd00d216f14ec43771d10a1e026`, which adds the registration to the implementation above. Setup took 1 min 57.225 s. Research started at 12:12:31.832 UTC and reached acceptance in **25 min 1.926 s**. The report ended 10.200 s after acceptance, including 1.182 s of cleanup. The runner and observer exited successfully, all 16 Bot sessions across the four reusable Cores were closed, and no run worker containers remained.

All four first discovery requests carried the same manuscript brief and an empty Task page. All four first Bots received paper text in tool results. Two initial proposals covered Section 4. One Bot canceled its duplicate and took Section 3 after seeing the other proposal in use. By the 1m26s audit all four first responsibilities were running.

| Core | First running responsibility |
|---|---|
| 1 | Lemma 2.2, arc-deletion subset deficit (`1d70217b`) |
| 2 | Lemma 2.3, transitive-tournament blowup (`4acc538c`) |
| 3 | Section 3, support rank and kernel bound for pruning (`cca39c90`) |
| 4 | Section 4, extremal contradiction conditional on pruning (`af2a1760`) |

| Time since research start | Main | Verified observation |
|---|---|---|
| 10m12s | `1972ec21` | The two Section 2 results and the conditional Section 4 argument were integrated. The locked target still had its original proof hole. |
| 20m20s | `b2f2e1ea` | Main had a checked reduction from pruning to the locked target. Work on the four-coordinate matching bound and matching-to-pruning reduction was underway. The locked target still had its original proof hole. |
| 23m46.459s | `590a4bd7` | A Bot submitted the complete integrated proof for final verification. |
| 25m1.926s | `590a4bd7` | The locked Judge accepted the original theorem. |

The ordinary Judge table recorded 23 passes and 29 source failures, with zero checker infrastructure failures. No optional worker `lean-check --swarmenv-workspace` invocation was observed. Timed model records show 430 completed HTTP 200 attempts and two HTTP 200 attempts with unknown settlement. Recorded usage on the completed attempts was 19,867,775 input and 143,717 output tokens. Provider cost was unavailable.

## Analysis

The integrated proof uses the four-coordinate bound and support-rank work through `matching_bound_of_outer`, then uses `pruning_of_matching_bound` to obtain the Section 3 conclusion. The original target calls that pruning proof through `locked_of_pruning`, whose reduction uses the blowup and extremal contradiction. The accepted tree therefore connects the paper-based tasks to the original theorem. The final verification took 75.467 s from submission to the trusted receipt.

In the interrupted [generic-brief run](EXP-20261121-01-seymour-lean-parity.md), the same manuscript was available but the first messages did not ask the Bots to formalize it. At the 43m08s audit there was no explicit Section 3 pruning or Section 4 contradiction task, and the root remained incomplete. In this repeat, explicit paper responsibilities and the response to duplicate work are visible at startup. The [historical native Agensh run](EXP-20261120-09-agensh-seymour-paper.md) took 34m42.332s from first wake and 35m35.326s from launch. It had an in-window local library permission repair. These single-run timings and the observed task choices do not establish a repeatable speed advantage or isolate an orchestration effect.

## Next steps

The authorized repeat has settled. [Issue #159](https://github.com/LuNa-shi/SwarmEnv/issues/159#issuecomment-7062373729) records the frozen comparison. Detailed trajectory and checker evidence remain private.
