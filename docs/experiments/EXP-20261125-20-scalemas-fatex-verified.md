# EXP-20261125-20 — ScaleMAS FATE-X with verified completion

Status **REGISTERED** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202). Comparison run [EXP-20261125-19](EXP-20261125-19-scalemas-fatex-31.md) used the same original problem and four GPT-6.1 Sol peers. All four ended on rejected proofs after 1m23.436s. The owner retained the 30-minute limit and requested an explicit initial instruction to work until the proof passes.

## Setup

One four-peer shared run on [FATE-X #31](https://github.com/frenzymath/FATE-X/blob/a6fb49ee85fd05bb8ce9fc66e1c66797b5a0592d/FATE-X.json), retaining the frozen dataset, Lean 4.28.0, Mathlib and independent grader from the comparison. Problem SHA-256 is `94d8113d56cbd9162371e02610bbe343c20831c59e4c1f9031a271eb30ad46e7`. The Worker's Pi 1.3.0 image is `sha256:b82fe2e8d969b2519645226bb5c1b6f0792c856295dc04d683e4942e052109ca`. The live model and Responses route are `gpt_proxy/gpt-6.1-sol`. The shared library, collaboration guidance, task statement, file isolation and resources match the comparison. Each peer chooses its own mathematical route, searches, publications and use of contributions.

| Field | Frozen value |
| --- | --- |
| Implementation | `2a3ed11ccaa89726d70e282f9aaf543652dc9e83`. Installed archive SHA-256 `d8f692c63e556fb3b9a5f2e8ba46a08d72e22908f23b3cfd397bb4212eb083e1`. |
| Completion | `fate.verifiedCompletion: true`. Each peer is told to keep working until it submits the exact Lean-passing proof or the work window expires. Failed or absent prior checks do not authorize an early finish. A known unfinished natural reply receives a continuation in the same Session. The host independently grades final submissions. |
| Window | 1,800 seconds starting after all peers are ready, with a passive checkpoint at 900 seconds. Time-only model permission, 100 Service operations and ten working Lean checks per peer. Setup, cleanup and independent scoring are bounded separately. |
| Prompt SHA-256 | System `5d568e240bf664819de63123cbeb371c64ff1eed5621b40df7eb034e6efbc039`, model developer `940bbca11c6b0fbeddcb568bad0b9727554714561e597e1a79edf25c913e3190`, user `cd1534260397a4ecfa9f41f5eb18085016bf43d6e2b0de793445eb784171e24f`, continuation `257fc7f3681b95d17e8ff185d87f43673676078bc6cd3d22fa9a45398f3fb4c0`. [Full task input and composition](../architecture/prompts/09-scalemas-environment.md#fate-initial-input-with-verified-completion-and-a-30-minute-work-window) |
| Service SHA-256 | Manifests `fa87e816dbc95c487b0d0f5231b772e1f1068e1f00adc7a49ce1d9de7505db4b`, input and output schemas `9efde09249c609fede23a63ba5c0ebf8d8441f6b99206718aba18056dbb09291`. |
| Launcher SHA-256 | `c3126af97de6e70043cf444153cad893b7f6d5c863421634cfc58b6fe6b52616`. GPT wrapper `4cef7547ddee553ef3b0911410d0b2a1a9df76e42496e356dd827fe9e761f15c`, time wrapper `aaff234ff2fe2f61fe95809c483c73323f52499fb83a7153c18ea7f6874b2b00`. |

Verify the full initial task and developer text in all four live provider requests. Audit each accepted finish against that peer’s earlier working check and the submitted digest. Report working time, continuation and end reasons, check and operation limits reached, actual final verdicts and standalone regrade. Audit shared publications, exact cross-peer delivery and substantive use in later proof work separately. Observed differences concern a changed completion policy and prompt in two individual runs.
