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

**Four-hour window completed. The fixed theorem failed offline adjudication.** Agensh ran from 12:27:14.893 to 16:27:14.893 UTC on Nov 20, 2026, and fenced model admission at the deadline. All four worker archives were verified and zero team containers remained after shutdown. The cutoff snapshot and the native final export agree on commit `175ce91f5205a1ac847bd576ff1a2415f6c1f73e` and tree `6df9dfb90c01fe76f40c5ffe8316fe372f2080ff`. The file containing the fixed theorem was byte-for-byte identical to the challenge and still contained the supplied `sorry`.

The native evaluate hook stopped before checking because the host library directory had drifted from its lock. Ubuntu's unattended upgrade had changed `python3-jwt` from `2.10.1-4ubuntu1.3` to `2.10.1-4ubuntu1.4` at 14:14:17 UTC in the research window. The native teardown took 3 min 26.112 s and retained the export. On Nov 21, an offline replay reconstructed the original package files and verified them against the unchanged full checker lock in a private read-only mount namespace. The original checker evaluated the same export and returned **FAIL** with receipt `treecheck:9e92700c-694b-4209-8f77-107d500249b1` and the diagnostic “Final project contains an incomplete proof or an added axiom”. The replay made zero model calls.

The 19-item rubric has no aggregate score for this run. Individual items have yet to be adjudicated against their full statements.

| Minutes | Workers with HTTP 200 | HTTP 200 / other | Main ref changes | Module PASS / FAIL / ERROR | Server main |
|---:|---:|---:|---:|---:|---|
| 10 | 4 | 153 / 0 | 8 | 8 / 0 / 0 | 2d6e150c71 |
| 20 | 4 | 138 / 0 | 4 | 8 / 0 / 0 | 21a4326a7f |
| 30 | 4 | 104 / 0 | 3 | 4 / 0 / 0 | a367be4ce9 |
| 40 | 4 | 78 / 0 | 1 | 5 / 0 / 0 | bc6278ab7a |
| 50 | 3 | 74 / 43 | 1 | 5 / 0 / 0 | 325d178c8c |
| 60 | 3 | 14 / 116 | 1 | 0 / 0 / 0 | 4d35e08358 |
| 70 | 2 | 22 / 0 | 2 | 4 / 0 / 0 | 545f090662 |
| 80 | 1 | 20 / 0 | 1 | 1 / 0 / 0 | b301e51ae8 |
| 90 | 1 | 15 / 0 | 1 | 1 / 0 / 0 | f53d4e87e4 |
| 100 | 0 | 0 / 0 | 0 | 0 / 0 / 0 | f53d4e87e4 |
| 110 | 1 | 12 / 0 | 1 | 1 / 0 / 0 | b6fce6a23b |
| 120 | 1 | 12 / 4 | 1 | 1 / 0 / 0 | 1ce7035645 |
| 130 | 1 | 8 / 0 | 0 | 0 / 0 / 0 | 1ce7035645 |
| 140 | 1 | 8 / 0 | 1 | 1 / 0 / 0 | aac59a00e8 |
| 150 | 1 | 18 / 0 | 1 | 1 / 0 / 0 | 9fa5708c41 |
| 160 | 1 | 14 / 0 | 1 | 1 / 0 / 0 | d9f92b1be3 |
| 170 | 1 | 4 / 0 | 0 | 0 / 0 / 0 | d9f92b1be3 |
| 180 | 1 | 12 / 0 | 1 | 1 / 0 / 0 | fab8dfff87 |
| 190 | 1 | 22 / 0 | 1 | 2 / 0 / 0 | 175ce91f52 |
| 200 | 4 | 44 / 0 | 0 | 0 / 0 / 0 | 175ce91f52 |
| 210 | 1 | 3 / 0 | 0 | 0 / 0 / 0 | 175ce91f52 |
| 220 | 1 | 3 / 0 | 0 | 0 / 0 / 0 | 175ce91f52 |
| 230 | 0 | 0 / 0 | 0 | 0 / 0 / 0 | 175ce91f52 |
| 240 | 4 | 29 / 0 | 0 | 0 / 0 / 0 | 175ce91f52 |

The proxy logged 807 successful responses by cutoff, 126 HTTP 429 responses, and 37 HTTP 503 responses. Between minutes 50 and 60 there were 14 successes and 116 errors. The four routers and workers were still up, but from minute 80 to minute 190 only zero or one worker per ten-minute window received a successful model response. All four received successful responses again in the windows ending at minutes 200 and 240. The 38 HTTP 502 responses after cutoff were recorded during shutdown. Reported usage was 77,110,590 input tokens, including 75,001,088 cached, and 284,181 output tokens. Response timestamps can follow admission.
The final session audit covered 4 workers. Supplied-paper instruction matches: 0; manuscript text tool-return matches: 0; audited reference-marker or credential hits: 0.

Registered before the formal model window. The actual prepare hook emitted one challenge file, an empty context list and an empty manuscript instruction. Four actual worker containers matched their read-only mount plans and were attached only to the private network. Native seed b1f43d102d700ae1ca5b9a093cf51c2f58d312d4 had exactly one 913-byte benchmark file in addition to native repository metadata. With UID/GID 10000:10000 each live worker elaborated the positive Mathlib probe and rejected the wrong module import. All four actual Pi sessions received the challenge instruction and zero manuscript instructions. Initial goal verification failed on the original hole (treecheck:bb1aaa9a-c4db-49c4-bc0b-ecdbdd45666d); in private preflight the complete positive control passed the same lock (treecheck:90ba74ae-fcc8-49d9-aa7e-00c47c9ec718).

Launch was 12:27:14.893 UTC on 2026-11-20. The first native wake was 12:28:07.857 UTC; the deadline is 16:27:14.893 UTC. All four workers had successful responses by 12:30:53 UTC (50 HTTP 200 in total). [Live ten-minute observations](https://github.com/LuNa-shi/SwarmEnv/issues/157#issuecomment-7039469409)

## Analysis

The final tree contains 26 Lean files, including the original challenge. The observer recorded 44 module PASS events across sampled commits. Local proofs were reused across workers. Worker 3's inverse-matrix reduction in `a367be4` used Worker 4's weighted blowup result from `9310fc3`. Worker 1 strengthened the reduction with an arc-deletion bound in `325d178`. Worker 3 then proved that it would suffice to rule out a primitive inverse obstruction in `4d35e08`, and Worker 4 derived a bound on the inverse's second-neighborhood mass in `545f090`. No merged declaration ruled out those obstructions in general, and the fixed target file never imported this chain.

Worker 4 also integrated tournament-completion results for graphs whose missing edges form a matching, finite-order results through eleven vertices, and a strict bound relative to minimum outdegree. These proofs settle particular cases or bounds. The final integration at 15:35:33 UTC took place about 188 minutes after launch, with approximately 52 minutes left in the window. The cutoff snapshot shows no subsequent revision on main.

EXP-09 reached trusted whole-target acceptance after 35 min 35.326 s with the manuscript and had an early local-checker permission incident. EXP-10 ran four hours and closed with the original proof hole still present. The provider errors, differing worker activity, and one observation per condition limit what these outcomes say about the separate effect of manuscript availability or decentralized prioritization.

## Next steps

The research window and offline recheck are complete. The per-item rubric remains available for statement-level adjudication against the retained cuts.

## Evidence and limitations

The final session audit covered all four workers. A source comparison of the final Lean tree against checked-in upstream reference modules and two previous completed submissions found zero exact file matches and zero matching ten-line windows outside the public challenge. These checks cover the staged files, recorded tool outputs and retained trees. [Ten-minute monitoring record](https://github.com/LuNa-shi/SwarmEnv/issues/157#issuecomment-7039469409)
