# EXP-20261120-10 · Native Agensh on Seymour without a manuscript

## Setup

One fresh native Agensh attempt after PR #158 merged. Compare with the manuscript-supplied native team in EXP-09. The registered question is whether local proofs are produced and consumed, and when they reach the fixed theorem. [Owner authorization on Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157#issuecomment-7039304105) · [Paper run](EXP-20261120-09-agensh-seymour-paper.md)

| Condition | Frozen value |
|---|---|
| Implementation | Merged main 490a215f3d7658908e3f693ecc0170fe9b12135d. Original Microsoft Agensh 2dae4e14a653da48549fd9aa093f834841475d6c, worker image sha256:a93a70e09b30787e9706ed619fa0c26d353ddb54c9b23aad4f10bf7350282fd6. Input-manifest SHA-256 24da7e87066c7246a6e473082a937ed5f1826484eb3b9df18f73d3b08ce4ff45. |
| Task and allowed inputs | Original `OAI.SeymourSecondNeighborhood.exists_goodVertex` with the supplied proof hole, source fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98, fixture fa30b4c4f6a68cac222daf3cb5a11e1e2bbbf36a. Fresh native Git, messages, board and Pi sessions. Only the single Lean problem enters the seed. The manuscript, evaluator rubric, reference implementation and other runs' proofs remain operator-only. |
| Team and budget | Four persistent, equal peers on Pi 1.3.0, gpt_proxy/gpt-6.2-sol medium, effective 500k context and 128k output limit. Four hours wall time including native team setup. No aggregate token or currency cap. Prior authorization allows overlap with EXP-08. |
| Verification | Pinned Lean 4.34.1, Mathlib d13f23b7, EXP-02 Judge ca857773 and original lock f0a85f18. Worker libraries are content-verified, read-only copies. Actual Pi UID/GID 10000:10000 must prove the Mathlib preflight before the clock opens. Measure both the repaired local tool and independent fixed-tree Judge. |
| Sampling and stopping | One-minute service records and ten-minute actual worker/model/UID, board, Git, module and root checks. Preserve immutable refs and timestamped receipts. On trusted acceptance of the current server main, deadline, owner stop or information-boundary breach, close admission and finalize. Record the final export and settlement separately. |
| Outcomes | Launch-to-first-trusted-current-main and first-wake-to-acceptance, or elapsed observation if unsolved. Use the same evaluator-only 19-item rubric as EXP-09. A final accepted root scores 1.00. If unsolved, require exact premises, compilation/axiom evidence and compatible results; report unknown items without a numerical total until adjudicated. Keep other strategies and actual cross-worker adoption visible. |

EXP-09 underwent an in-run local permission repair after about 27 minutes. This run begins with the repair. Single-run outcomes, overlap and infrastructure differences limit causal interpretations of the manuscript effect.

## Results

Registered before the formal model window. The actual prepare hook emitted one challenge file, an empty context list and an empty manuscript instruction. Four actual worker containers matched their read-only mount plans and were attached only to the private network. Native seed b1f43d102d700ae1ca5b9a093cf51c2f58d312d4 had exactly one 913-byte benchmark file in addition to native repository metadata. With UID/GID 10000:10000 each live worker elaborated the positive Mathlib probe and rejected the wrong module import. All four actual Pi sessions received the challenge instruction and zero manuscript instructions. Initial goal verification failed on the original hole (treecheck:bb1aaa9a-c4db-49c4-bc0b-ecdbdd45666d); in private preflight the complete positive control passed the same lock (treecheck:90ba74ae-fcc8-49d9-aa7e-00c47c9ec718).

**Running.** Launch was 12:27:14.893 UTC on 2026-11-20. The first native wake was 12:28:07.857 UTC; the deadline is 16:27:14.893 UTC. All four workers had successful responses by 12:30:53 UTC (50 HTTP 200 in total). [Live ten-minute observations](https://github.com/LuNa-shi/SwarmEnv/issues/157#issuecomment-7039469409)

## Analysis

Pending the observed proof and collaboration records.

## Next steps

Inspect the final exported tree, trusted receipts and worker archives. Relate independently checked local work to the main proof and report the limitations of this comparison.
