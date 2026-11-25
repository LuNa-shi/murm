# EXP-20261125-19 — ScaleMAS on FATE-X problem 31

Status **SETTLED · 1m23.436s · 0 PROOFS PASSED · 1 CROSS-PEER READ · NO OBSERVED REUSE** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7166982329). The owner requested one run on a substantially harder task after [the FATE-H #2 GPT run](EXP-20261125-18-scalemas-gpt-30min.md) ended in 5m24s with four passing proofs and no cross-peer reads.

## Setup

Use the original FATE-X #31 task, proving that the complex multivariate polynomial ring modulo the sum of the squares is a unique factorization domain for at least five variables. FATE-X is the highest difficulty tier in the [FATE benchmark](https://arxiv.org/html/2511.02872v3#S3.SS2). All peers receive the same upstream problem files. Each chooses its own route, tool usage, publications and final submission.

| Field | Frozen value |
| --- | --- |
| Implementation | `4503fecb7d5447144a743d4d8841f44a1993c990`. Installed `@swarmenv/core@0.2.0` archive SHA-256 `f6d0301d10426a0c7af2d36b33709043c6281631214dd2dc0fd842d9b136f6cb`. |
| Fixture | [FATE-X dataset at `a6fb49e`](https://github.com/frenzymath/FATE-X/blob/a6fb49ee85fd05bb8ce9fc66e1c66797b5a0592d/FATE-X.json), ID 31, `Problem31.UFD_of_ge_5`, formal statement SHA-256 `94d8113d56cbd9162371e02610bbe343c20831c59e4c1f9031a271eb30ad46e7`. Dataset SHA-256 `021ecd8b4cd1c79666d7e64efe4f347d9ef36fa7f6b542fc60a370a4b916daea` and lock SHA-256 `444540e9d26548e4007674373ad297c052b66d0deff1a0febc23536bcf3b3186`. |
| Checker | Lean 4.28.0 commit `7e01a1bf5c70fc6167d49c345d3bf80596e9a79b`, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`. Installed preflight compiled the trusted original, found ten Mathlib results and rejected a known false proof term. A controlled valid proof using a local definition in a namespace passed independent replay. |
| Model and Worker | `gpt_proxy/gpt-6.1-sol`, same configured Responses route as `EXP-20261125-18`, four peers, shared only. Pi 1.3.0 Worker image `sha256:b82fe2e8d969b2519645226bb5c1b6f0792c856295dc04d683e4942e052109ca`. |
| Prompt SHA-256 | System `26b93bd0e7620c50d3270c23be5b958366513acacefe7a630803b0d3269346b0`, separate model developer `9ebdf19cc52e3625e14ed5ebd7a1ea1ac0bf0a98fb530618a5073fd430a58b83`, user `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`. |
| Service SHA-256 | Manifests `d852e951370a9219ab32fe86be68e1d53c0e260e45e867b9983ba56c7b51f195`, schemas `9efde09249c609fede23a63ba5c0ebf8d8441f6b99206718aba18056dbb09291`, equal to the prior GPT run. |
| Launcher SHA-256 | `c3126af97de6e70043cf444153cad893b7f6d5c863421634cfc58b6fe6b52616`. GPT wrapper `e15b7e3e02401a0dde01da655e219dcff917e39a56a4fc0dbf788ae4d2077ff0` and time wrapper `aaff234ff2fe2f61fe95809c483c73323f52499fb83a7153c18ea7f6874b2b00` match the prior GPT run. |
| Window | One group, up to 1,800 seconds after four peers are ready, with a passive checkpoint at 900 seconds and natural early settlement. Same 100 distinct Service operations and ten working Lean checks per peer. Model permissions are time-bound. Setup, cleanup and independent grading are bounded separately. |

Compare timing and use descriptively with the prior GPT group on a different problem. Record voluntary publications and their timing, subsequent cross-peer deliveries, and use in a later proof attempt, publication or final proof. Require the exact delivered work and the recipient's later work as evidence for adoption. Score only each peer's actual final submission and run standalone regrading. A correct proof, cross-peer delivery and substantive reuse are separate observations.

## Results

The four peers started work at 15:32:19.005 UTC on November 25 and all settled through `finish: true` by 15:33:42.441 UTC. Work lasted 1m23.436s and setup took 24.717s. Per-peer work ended between 40.908s and 83.436s, after 11–19 of the 100 available Service operations and one or two of the ten available Lean checks. The 15-minute checkpoint remained `not_reached`. All four submitted candidates matched proofs that had already been rejected during work. Independent grading and a fresh standalone regrade both rejected all four with `LEAN_REJECTED`. All four Session archive digests and stop receipts validated. The launcher exited 0, cleanup was complete and the Runtime had zero remaining containers.

All four peers received byte-identical first developer and user messages and the same `bash`, `edit`, `read` and `write` tool definitions. The official formal statement appeared in tool output forwarded to each peer. All 36 gateway requests retained the expected developer text and `medium` reasoning effort. The provider returned 32 completed responses identifying `gpt-6.1-sol`, with known usage of 256,051 input tokens and 3,562 output tokens. The four other streams were the last request per peer and closed just after their accepted finish caused the peer to stop. Their usage is unknown.

| Observed measure | FATE-H #2 | FATE-X #31 |
| --- | ---: | ---: |
| Work duration | 5m24.177s | 1m23.436s |
| Successful shared searches | 10 | 7 |
| Peers searching the shared library | 4 | 4 |
| Distinct publications / publishers | 5 / 4 | 2 / 2 |
| Cross-peer reads / evidenced reuse | 0 / 0 | 1 / 0 |
| Mathlib searches | 178 | 38 |
| Working Lean verdicts / passes | 33 / 4 | 5 / 0 |
| Final submissions / passing proofs | 4 / 4 | 4 / 0 |

The first contribution appeared 44.389s after work started. It proposed a linear change of variables and a localization argument via Nagata’s criterion, marked as unverified in Lean. A different peer searched for that route and received the exact contribution at 49.584s. The Service receipt, native Session tool result and next model request agree on the contribution content. That next request started at 53.964s and completed successfully. The receiver had already searched Mathlib for the same criterion and related facts before the publication. Its subsequent Lean check corrected the newline escaping in a generic theorem-search attempt. It submitted that rejected attempt without a reference and produced no follow-on contribution. The second publication, at 66.960s, recorded an unresolved descent blocker. No peer subsequently searched or visited the library. One publisher had first passed inline JSON to a file-path flag and then tried a write to `/tmp` that failed. Its third attempt succeeded through standard input.

## Analysis

The harder fixture yielded an actual cross-peer delivery on the normal runtime path. All peers used the shared search, and one relevant result reached a live model context before that peer finished. That recipient was already investigating the same route. The two artifacts summarized ideas and blockers and did not provide a verified Lean lemma the receiver could apply. The trace supports delivery and shows no substantive downstream proof use.

All four peers moved from a short Mathlib search and generic proof probes to a deliberate final submission after one or two working checks each. Time and operation capacity remained for each peer when it finished. The run establishes that the four peers did not solve the harder fixture with the work they chose to do. Their early settlement leaves the outcome of sustained work on this fixture unknown. This is a descriptive comparison of two individual groups on different tasks.

## Next steps

The requested hard-task rerun, independent regrading and cleanup are complete. Natural reuse in later proof work remains unobserved in these two GPT runs.
