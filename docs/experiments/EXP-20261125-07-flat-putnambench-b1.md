# EXP-20261125-07 · Flat PutnamBench 2025 B1

Status · STOPPED · selection cutoff reproduced

Repeat of [EXP-20261125-06](EXP-20261125-06-flat-putnambench-b1.md) under the owner's authorization to rerun with independent review and stop at confirmed deviations. The previous run reached public discovery but never called the Task creation Service. This version restores operational startup information from the original Flat behavior and makes the normal CLI Task help actionable. The fixture, model, settings, checker and empty Task pool remain fixed. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Design commit `95aecaefa2a99a17091b86141ebe16aca88c1191`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `f6bff342d22d41f0f9a8715d50d9760385ab67fe`. Worker image `sha256:b89e13d9a2386d8649ceaffa6aa03340ce511333f303d4724562795f7685bac0`, revision label matches the implementation commit. |
| Reference and comparison boundary | Original Flat reference `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828`. One acceptance run with the restored workflow. Historical controlled and hosted observations have their own settings. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, source SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty autonomous Task pool. Reference proofs and preassigned Tasks excluded from Bot inputs. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, checker `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Provider and capacity | `kimi_proxy/k3`, real hosted Responses. Retain the same Pi default and verify medium reasoning from actual sessions. Four concurrent Bot slots, one Execution per Bot, confirmed cleanup before refill. No total model request, Token or fee cap. |
| Window and stop | Open after the initial workers are ready. Research at most 3,600,000 ms with a 300,000 ms Bot selection window. Stop on trusted Mission acceptance, deadline or a confirmed first progression defect. Record bounded final assessment and resource cleanup separately. |
| Acceptance | Track an A-origin fixed revision through B's existing Session and Execution, subsequent B-authored content, ancestry into fixed final main, and real use in the theorem proof. The locked Lean verifier must pass the same candidate. Record cutoff and cleanup separately. |
| Evidence boundary | Private local experiment directory for raw traces, proof and databases. Report links only pinned public inputs and sanitized aggregate evidence. |

## Tracked input hashes

The digests refer to repository-controlled inputs to prompt, Profile and tool composition. Preserve actual per-Bot input and admitted capability receipts if the run launches.

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and exact template inventory | `docs/architecture/prompts/source-manifest.json` | `825d8c037e585b09edeb9ebd9251cc9176c3d35e4b3c5385bafd945514fb5e9d` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `8f90185292b518cba73663a20456ae9e925f6bf53444d4d131cf4bc052d7f494` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| Repository-controlled service schema reference | `docs/architecture/10-service-api-reference.md` | `c5a2de1d5562260b35cb89615e7ede24f986554fcba3701031d0f152cf2b306d` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `0bdc54796734b5faa96ae33c45c3190a21c57283d272de0c31b0dae8a3926fb4` |

## Launch command

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-07 sha256:b89e13d9a2386d8649ceaffa6aa03340ce511333f303d4724562795f7685bac0
```

## Live observations and stop criteria

Watch the fixed first four Bot identities from TaskService and reconcile actual accepted proposals, exclusive take and active Execution receipts with private Service traces. Record elapsed time to first proposal, take, save and subsequent collaboration. If all four first selection deadlines pass without an accepted proposal or take anywhere, stop the runner with SIGTERM and inspect the exact point where the workflow stopped. Confirmed worker, provider, repeated valid Service, checker or cleanup defects also trigger an early stop. Isolated rejected guesses and expected exclusive-claim races do not establish a system defect when another Bot progresses.

If the selection transition works, continue observing save, public publication, a second Bot's actual apply, main integration and independent original-theorem acceptance until a confirmed defect or the bounded window closes.

## Results

The four initial workers jointly opened the window at 09:07:50.603 UTC after 17.373 seconds of Runtime setup. The operator sent SIGTERM when the fourth selection deadline passed with zero Tasks or Executions. The research window closed after 297.932 seconds. All four initial Bots received the revised discovery message and read the locked original from revision `0.1` with the expected source hash.

| Observation | Result |
|---|---|
| Model | Four initial sessions sent real `kimi_proxy/k3` requests with reasoning effort `medium`. Core recorded 15 selection requests, with nine completed, four interrupted after HTTP 200, and two interrupted without an upstream status during shutdown and refill. The completed requests metered 22,539 input and 1,490 output tokens. Other usage and billed cost are unknown. |
| First selection cohort | Four sustained HTTP 200 responses had 36,355 to 46,720 reasoning characters each. None emitted a completed output item, a function call or a terminal response. No Task creation or take reached the service. |
| Proof work | Zero Tasks, Executions, Materials, added Workspace revisions and Mission submissions. Main stayed at `0.1`, tree `15cdae59fe9ba1dada06eb14959403ab364ac8bd`. |
| Final assessment | The operator stop canceled the post-stop checker, which returned ERROR for `treecheck:31d46bac-399a-4cda-8ca0-a7675a226a09`. The separate locked preflight returned project PASS and final FAIL for the unchanged original seed. |
| Cleanup | Peak four occupied slots. Six persisted domain Bots closed. Seven Core Bot allocations were included in cleanup, with one startup interrupted near shutdown. Runtime cleanup reported complete with no live sandbox, pending checker or pending merge for this run. |

## Analysis

The restored startup information reached the actual model and the documented public reads succeeded. The first-squad trace reproduced the long selection response before any Task service request. The gateway received continuous reasoning deltas from the upstream, with no function call to deliver. There is no evidence of a Task write rejected by the service. The observations do not establish whether a longer selection window would let K3 produce its first proposal.

## Next steps

Compare a registered longer selection window with the same prompt, provider, initial fixture, empty Task pool, checker, capacity and total research window. Track the first completed proposal and take. Continue into proof collaboration if the transition works.
