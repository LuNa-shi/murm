# EXP-20261120-09 · Formalizing the supplied Seymour manuscript with native Agensh

## Setup

The owner authorized one fresh four-worker run. The input and scoring protocol follow main d19fe4e91501cbed28af6ea165b82a81fd425303. The code under test is eeb45c408c584be79325b85d6a7e4b4de6043567. [Approval on Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157#issuecomment-7036821501) · [Previous challenge-only native run](EXP-20261120-07-agensh-seymour.md) · [Paper-grounded scoring rules](https://github.com/LuNa-shi/SwarmEnv/blob/d19fe4e91501cbed28af6ea165b82a81fd425303/benchmarks/openai-math-12/paper-progress/README.md)

| Condition | Frozen value |
|---|---|
| Agent input | The original 913-byte Lean challenge for OAI.SeymourSecondNeighborhood.exists_goodVertex and manuscript 173 as benchmark/paper.pdf and benchmark/paper.txt. SHA-256 prefixes fa4a3783, 20be8597, eab9cae7. Manifest 7154d525. Fresh native Git repository, identities, board, messages and sessions. The reference Lean solution and evaluator rubric remain operator-only. |
| Worker environment | Four peer Pi 1.3.0 workers, gpt_proxy/gpt-6.2-sol medium, effective 500,000 context / 128,000 maximum output, 8 GiB / four CPUs per worker. Agensh 2dae4e14, image a93a70e09b30. Profile exp157sey09. Run input fingerprint d900bbb5c642ecd811e960291360d48c2afd6a281f4a4c63903888eab49dd522. |
| Cooperation | Native Mattermost messages, shared board, self-selected CLAIMs, Git branches, PRs, merges and staggered wake. The math pack names the paper and checks. The operator sends no task assignments or mathematical advice. |
| Checking | Offline repaired worker lean-check, pinned public Mathlib d13f23b7, Lean 4.34.1. Independent EXP-02 verifier ca857773 with exact lock f0a85f18. Each check has 600 seconds, 8 GiB, 200% CPU, one Lake job. Rerun the historical false-positive import as a negative and the corrected import as a positive before launch. Test both the original hole and an operator-only complete proof with both manuscript files present. |
| Time and stopping | One four-hour wall window including native setup, no aggregate token or monetary cap. The owner explicitly authorized overlap with EXP-20261120-08 before this team launched. Record the overlap as a timing/resource covariate. Stop early on acceptance of current main, an integrity failure or an owner request. Close new model requests at cutoff, report checker settlement separately. No automatic replacement run. |
| Sampling | Record launch, first wake and trusted acceptance separately. Every ten minutes record per-worker health, HTTP receipts, board and Git activity, module proofs, fixed-goal receipts and the current immutable main. Identify first observed paper reads in Pi tool returns. Recover branches and available public commits when evaluating work at each cut. |
| Mathematical measure | Use the 19 equal-weight items at rubric SHA-256 e42f4cfc567311b77b10feb6adc2c64cd6418f4bdfdd636e5c1d3d65f70a1f91. Record checked declarations, premises, ownership, actual downstream consumption and integration. Score 1 for trusted whole-target acceptance. Otherwise use passed items in the best compatible package divided by 19 only after all items have been adjudicated. Preserve unassessed and alternative routes separately. |

The four-Core SwarmEnv paper case reported trusted acceptance in 58 min 54.716 s from research start, after setup. Report native acceptance time from both launch and first wake. The historical baseline and the newer paper deployment differ in checker lock and orchestration. A single case does not isolate an architectural or paper effect. [Four-Core paper comparison](https://github.com/LuNa-shi/SwarmEnv/blob/bef3656/docs/experiments/EXP-20261120-07-seymour-paper.md)

## Results

Registered before worker startup. The actual prepare hook generated exactly the three pinned benchmark inputs. The pinned upstream checkout has no tracked changes. The native model window opens only after checker, input and isolation preflight.

The operator compared the actual seed with all three approved hashes. At the seed cut the only target theorem has its original proof hole, the other declarations are the problem definitions, and the supplied paper is natural-language evidence. All 19 formal obligations are not completed at this cut, giving **0/19**. With the two manuscript files present the fixed Judge rejected the seed (treecheck:f6112fdd-be99-43d6-b5ab-8f345f394235) and accepted a separate operator-only complete control in 55.651 seconds (treecheck:a46854b9-d2e8-40db-9552-982f6755230b). The repaired worker rejected the original de766071 import and accepted the corrected import. All four effective Compose worker definitions had approved mounts and only the internal network. The native public collaboration implementation had zero tracked changes.

At 10:16:26 UTC the single-attempt launcher entered the queue behind EXP-20261120-08. At 10:33 UTC the owner authorized parallel execution and the operator released the queue. Waiting time is excluded. The four-hour budget starts at native launch. Repository tests passed (736 passed, 38 skipped), four dedicated regressions passed on Lean 4.34.1 and both review axes reported no blocking finding. [Live ten-minute register](https://github.com/LuNa-shi/SwarmEnv/issues/157#issuecomment-7036953360)

## Analysis

Pending observation. Module counts alone cannot establish mathematical progress or integration.

## Next steps

Record ten-minute observations and adjudicate the available immutable proof work against the preregistered items. Link the final fixed-tree verdict and cleanup receipts here.
