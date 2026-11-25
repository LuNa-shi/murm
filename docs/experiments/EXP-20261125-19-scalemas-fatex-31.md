# EXP-20261125-19 — ScaleMAS on FATE-X problem 31

Status **REGISTERED** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202). The owner requested one run on a substantially harder task after [the FATE-H #2 GPT run](EXP-20261125-18-scalemas-gpt-30min.md) ended in 5m24s with four passing proofs and no cross-peer reads.

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
