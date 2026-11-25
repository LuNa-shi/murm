# EXP-20261125-17 — ScaleMAS GPT-6.1 Sol comparison

Status **REGISTERED** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202). Comparison run [EXP-20261125-16](EXP-20261125-16-scalemas-intermediate-sharing.md).

## Setup

The owner requested a model switch while the K3 run was in progress. The K3 run received a normal stop at 17m37s of work with zero shared publications. The four first model requests had matched the frozen prompt and task input. This shared-only run uses the same implementation, installed package, Worker, prompt, services, FATE-H problem #2, Lean/Mathlib pins, four-peer size, per-peer resources, checker, scoring, checkpoint and 30-minute work limit. [Inherited frozen values](EXP-20261125-16-scalemas-intermediate-sharing.md#setup)

| Field | Frozen value |
| --- | --- |
| Implementation | `69ede68417b4dcac77f6bc5caa5e5dab3db1a265`. Same package and input hashes as the K3 run. |
| Model | Live `gpt_proxy/gpt-6.1-sol` on the registered Responses provider route. The authenticated model catalog returned HTTP 200 and listed the exact model before launch. |
| Launch | Installed ScaleMAS entry and the preceding 30-minute host configuration, with the model alias and upstream route overridden. Launcher SHA-256 `800e17e49d9d0d3a2866c601ca63b4777f1939ccfaa2c67ae78e028fa5fe6e30`. GPT configuration SHA-256 `e15b7e3e02401a0dde01da655e219dcff917e39a56a4fc0dbf788ae4d2077ff0`. |
| Time and stop | Up to 1,800 seconds from all peers ready, with normal earlier settlement. Passive checkpoint at 900 seconds. Setup, cleanup and independent scoring are reported separately. |

Verify all four actual initial model requests. Count successful and repeat shared searches, distinct accepted publications, deliveries to a different peer, and concrete downstream use in proof work. Trace a claimed handoff through the authenticated call, the recipient's actual response and model context, and the corresponding Lean attempt or final proof. Record scoring, provider usage and cleanup separately. Compare with K3 over its observed 17m37s window, then report any later GPT events separately. The model and its provider route change together. One run per model gives a behavioral comparison with limited causal inference.
