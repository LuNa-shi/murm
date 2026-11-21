# EXP-20261121-01 · Seymour paper with aligned Lean tools

## Setup

One four-Core follow-up authorized by the owner after the offline Seymour replay. [Issue #159](https://github.com/LuNa-shi/SwarmEnv/issues/159) records the paper/input contract and original four-Core run. [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) records the native comparison. This run repeats SwarmEnv EXP-20261120-07 and compares with native Agensh EXP-20261120-09. Both comparisons are historical. Native Agensh had an in-window public-library permission repair.

| Setting | Frozen selection |
|---|---|
| Implementation | `de79440ebb36af29c488abc22fbfb6e4d86ba764` |
| Problem | `oai_seymour_second_neighborhood`, fixture `fa30b4c4f6a68cac222daf3cb5a11e1e2bbbf36a`, target SHA-256 `fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98` |
| Public paper | Pinned 173 manifest SHA-256 `7154d525431d105a19735bdacf3f0e34344df0c591dba8168deae1c3c9c6e74a`, PDF and text. Fresh project state and sessions. Reference proofs, history and scoring rubric stay in evaluation. |
| Model | Pi 1.3.0, `gpt_proxy/gpt-6.2-sol`, medium reasoning. Catalog SHA-256 `50c0c4d26ea3450bb2881af65c39ffde41a42a8e8cdbdb56eac35d1af118e55c`. |
| Time and spend | One project, four reusable Cores, no initial staggering. Four-hour research and Bot lifetime limits, with setup recorded separately. One run within the existing provider allowance. |
| Worker | Image ID `sha256:adca86c6bd63b91263bc13b33e7ee49ed38a47da6500ba6d3a66b4cb8f0480db`, 4 CPU and 8 GiB per Bot, original 256 MiB and 16,384 inode scratch limits. `OPENAI_MATH_SEYMOUR_LOCAL_LEAN=1` selects the fixed discovery instruction and the Agensh local check adapted to the SwarmEnv workspace. |
| Judge | Lean 4.34.1, Mathlib `d13f23b723b8a846827a245b89c10fc7d3f11612`, revised source policy and unchanged trusted theorem/kernel replay. Artifact lock `c27ee1a33348c167bae3bdda9058f65f335ca13d5a8005b6c1de1e3b9b460c68`. Ordinary, merge and final-check process bounds 600 s. |
| Prompt and interfaces | `swarm-bot-v1-draft.3`, prompt manifest SHA-256 `17f64053c76c858e9bb9639fe37b1e63f806a66d8b1212ae44ee971d7a77b2dc`, Service API reference SHA-256 `2483ca87b429276461ce2d1f338807564e7aff3e703d806a121f585e7e8011be`. |

Stop on trusted acceptance, the four-hour cutoff, protocol or input-integrity failure, or owner request. Track admission, first model work across the four slots, local Lean tool use, path-specific checker failures, fixed main submissions and cleanup. Measure first trusted root PASS from the research start and score a cleared original root as 1.00. If no root PASS is observed, score only independently verified obligations using the existing 19-row rubric. The historical runs and the combined tooling/checker change limit causal attribution.

## Results

Registered before model calls. Offline controls exercised the fixed final checker against the original incomplete seed and both historical final-phase trees. Worker image, sandbox restrictions and tool readiness are checked before the experiment window.

Research started at 11:22:34.434 UTC. All four Cores received model responses, took work and recovered or replaced Bots through the native Task lifecycle. The original proof remained incomplete at operator stop. The report recorded 43m55.601s including 1.378s cleanup, no cleanup errors and no remaining worker containers. The report marks the interrupted protocol invalid with reason `operator_stop`.

## Analysis

The immutable public seed supplied both paper files. The first discovery messages gave the generic goal to solve Seymour and explained the local Lean tools. Core 1 read the first 90 lines and took the strongly connected reduction. Core 2 took a tournament special case without an observed direct paper read in its first Bot session. Core 3 read selected passages from Sections 2 and 3 and took the deficit lemma. Core 4 read the first 22 lines and took arc minimality. The public main accumulated reductions and bounded outdegree cases. At the 43m08s audit there was no explicit task for Section 3 pruning or the Section 4 extremal contradiction.

## Next steps

The owner directed a fresh repeat with the initial assignment aligned to native Agensh. The repeat has a separate registration. The run history and partial artifacts remain private.
