# EXP-20261121-04 · Native Agensh Seymour manuscript with readable Lean dependencies from startup

## Setup

The owner approved a single fresh four-worker paper-arm repeat under [Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157). Repeat [EXP-20261120-09](EXP-20261120-09-agensh-seymour-paper.md) using the released worker-permission fix in merge `490a215f3d7658908e3f693ecc0170fe9b12135d`. Compare the two native cases and the [SwarmEnv matched-brief run EXP-20261121-02](https://github.com/LuNa-shi/SwarmEnv/issues/159#issuecomment-7062741862). The question is how this paper case proceeds with local Lean available from the start. All timings are single-run observations.

| Condition | Registered selection |
|---|---|
| Public input | Original Seymour theorem, fixture `fa30b4c4f6a68cac222daf3cb5a11e1e2bbbf36a`, target digest `fa4a3783`, and manuscript 173 PDF/text digest prefixes `20be8597` and `eab9cae7`, manifest `7154d525`. Fresh Git and messages. The reference proof and 19-item rubric stay with the evaluator. |
| Workers | Four equal native Pi 1.3.0 workers on Agensh `2dae4e14`, image `a93a70e09b30`, each 4 CPUs and 8 GiB. `gpt_proxy/gpt-6.2-sol`, medium, effective context 500,000 and output ceiling 128,000. Unique profile `exp157sey112104`. |
| Brief | The shared original-theorem and paper-formalization assignment from the native pack. Both paper paths are named. Workers choose responsibilities through Agensh's messaging, board and PR workflow. The operator supplies no mathematical work assignments. Native brief template SHA-256 `e508a0dec25841fac3f6ac3b4b676cbae6c4e1e23c0cf47324b4ce7ed43aad3f`. |
| Lean and Judge | Lean 4.34.1, Mathlib `d13f23b7`. Staging copies the same public compiled libraries into readable, read-only mounts. Validate the four staged worker mount plans and probe each with the worker image as UID/GID `10000:10000` before launch. Use the native locked `f0a85f18` independent fixed-theorem checker with 600 s per check. Confirm that the seed fails and an operator-only complete control passes with both paper files present. |
| Timing and spend | One run, the native four-hour wall window from driver launch, and the existing provider allowance with metered usage. Record preparation, driver launch, first worker wake, trusted acceptance and settlement separately. Compare first-wake and launch durations where available. No automatic replacement. |
| Evidence and stop rule | Observe all four actual sessions, first paper reads, early responsibilities, local-tool returns, public Git and independent receipts. Stop on a trusted PASS for the current published main, the four-hour cutoff, confirmed input or protocol integrity failure, or owner request. Final export is checked again. |

Private staged-input manifest file SHA-256 `b6b2e8d32ee9a89a09962afd5a0d8f7e9627ed57fcbe630cf2fdb22dbad0b583`. The native and SwarmEnv runs retain their respective harnesses, verification paths and startup boundaries. Whole-target acceptance scores 1.00. A partial score requires independent adjudication of all 19 milestones in a compatible package.

The [initial startup attempt](EXP-20261121-03-agensh-seymour-paper-fixed-uid.md) exited before any worker woke or any model request was admitted. This entry replaces that startup under the same authorized one-run model allowance. The private Judge environment uses an ownership-preserving, read-only copy of the locked host library tree. A real checker child verified the full library fingerprint. A driver preflight exercised its actual privileged Docker image lookup.

## Results

**PASS, score 1.00.** Independent fixed-goal receipt `treecheck:9731bba6-3cf2-4997-b585-fea92901808d` accepted tree `189b26da015d41c1a44046b82797dc67d6836490` at 13:35:30.432 UTC. The observer's checked commit `16144db2` and the current server main `da43fd0c62b4ec2a38770cbbfa7d0b9b1d1dbcce` have the same tree. The native final export of that same main and tree passed again with `treecheck:dd53f7e4-e1de-40c0-a68f-7dd29e63b767` under the original `f0a85f18` lock.

Setup for this attempt took 4 min 47.914 s. Driver launch was 13:12:56.679 UTC. First wake was 13:13:49.264 UTC, 52.585 s later. Time to first trusted acceptance was **21 min 41.168 s from first wake**, or **22 min 33.753 s from driver launch**. The model admission fence closed at 13:35:36.808 UTC. Native settlement took 4 min 45.109 s from that fence, including final export and independent verification. All four worker archives were verified. The driver and observers exited successfully. There were no leftover team containers, networks or active run services.

Before launch the independent Judge rejected the original hole with both paper files present (`treecheck:85208237-6bf7-491e-8c6e-d8cd323584a0`) and accepted the operator-only complete control (`treecheck:87359dee-570d-4d54-92b5-b4dc2049ed37`). All four staged worker UID probes passed. The live mount audit confirmed the exact public seed, internal networking and the pinned image in all four workers. All four live Pi identities could read Mathlib and had the approved 4 CPU and 8 GiB limits.

All four Pi sessions received the paper assignment and read manuscript text by 13:15:53.210 UTC. The public board recorded four initial claims by 13:16:00.796 UTC. They covered Lemma 2.2 and minimality, Lemma 2.3 blowup, the Section 3 rank bound, and Section 4 with integration. All four workers had successful local Lean builds during the first ten minutes. The session audit counted 33 successful local builds through the fence and found no Lean library permission denials in the paired local-check returns. Its reference and credential markers returned no hits.

| Time from launch | Main | Verified observation |
|---|---|---|
| 10 min | `93c7a97f` | Section 2 deficit and blowup, Section 4's conditional result, and Section 3 support-rank work were on main. The root was unproved. |
| 20 min | `53268a19` | Matching-to-pruning conversion, augmented matrix rank and generic matching-minor results were integrated. The complete matching bound merged just after this cut, followed by the final proof in PR #19. |
| 22m33.753s | `da43fd0c` | The independent Judge accepted the current main tree. |

The proxy recorded 434 HTTP 200 responses before the fence, from all four workers, and 44 HTTP 502 responses after the fence. Reported usage was 28,905,807 input tokens including 28,041,984 cached, and 104,604 output tokens. Provider cost was unavailable. The independent observer logged 36 module passes and 18 fixed-goal rejections on earlier trees, then the fixed-goal pass. Its 13 unavailable Git samples all occurred before first wake while the native Git service was starting.

## Analysis

The accepted root calls `pairPruning_of_augMatchingBound` with the team's `augMatchingBound` result. The assembled reduction uses the accepted deficit, blowup and Section 4 contradiction. This use in the accepted tree connects the distributed paper responsibilities to the original theorem.

The prior manuscript run had recorded local Lean permission failures in all four workers and its main stayed at the seed through the 20-minute cut. In this repeat, all four used the local tool successfully in the first ten minutes and main contained results from Sections 2, 3 and 4 by that cut. The native first-wake timings were 34m42.332s in the historical run and 21m41.168s here. The SwarmEnv matched-brief run took 25m1.926s from its research start. Native Agensh and SwarmEnv use different coordination, checker wrappers and startup boundaries. These single trajectories show the earlier local-check and integration difference. The 13-minute native timing difference cannot isolate the size of the permission effect or establish a general platform speed ordering.

## Next steps

The authorized single model run has settled. Raw session, Git, usage and checker artifacts remain private. [Registration and startup correction](https://github.com/LuNa-shi/SwarmEnv/issues/157#issuecomment-7063071923)
