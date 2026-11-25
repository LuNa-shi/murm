# EXP-20261125-08 · Flat PutnamBench 2025 B1

Status · REGISTERED

Repeat of [EXP-20261125-07](EXP-20261125-07-flat-putnambench-b1.md) under the owner's authorization to rerun with independent review and stop at confirmed deviations. Corrected startup guidance reached all four Bots in the previous run. Their first long reasoning streams were interrupted at the original five-minute Bot selection deadlines before any proposal. This run lengthens that internal selection window to ten minutes to observe whether those streams reach an autonomous proposal and take. The benchmark's ordinary default remains five minutes. The full research window stays at one hour. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Design commit `95aecaefa2a99a17091b86141ebe16aca88c1191`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `cb9a6489254b163b638e1f5034906ea80d77b9f4`. Worker image `sha256:102b97faca7a35cab5b951f10a0b034a85a8d57879143eed5695ec2e865c2655`, revision label matches the implementation commit. |
| Reference and comparison boundary | Original Flat reference `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828`. One acceptance run with the restored workflow. Historical controlled and hosted observations have their own settings. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, source SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty autonomous Task pool. Reference proofs and preassigned Tasks excluded from Bot inputs. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, checker `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Provider and capacity | `kimi_proxy/k3`, real hosted Responses. Retain the same Pi default and verify medium reasoning from actual sessions. Four concurrent Bot slots, one Execution per Bot, confirmed cleanup before refill. No total model request, Token or fee cap. |
| Window and stop | Open after the initial workers are ready. Research at most 3,600,000 ms with a registered 600,000 ms Bot selection window. Stop on trusted Mission acceptance, deadline or a confirmed first progression defect. Record bounded final assessment and resource cleanup separately. |
| Acceptance | Track an A-origin fixed revision through B's existing Session and Execution, subsequent B-authored content, ancestry into fixed final main, and real use in the theorem proof. The locked Lean verifier must pass the same candidate. Record cutoff and cleanup separately. |
| Evidence boundary | Private local experiment directory for raw traces, proof and databases. Report links only pinned public inputs and sanitized aggregate evidence. |

## Tracked input hashes

The digests refer to repository-controlled inputs to prompt, Profile and tool composition. Preserve actual per-Bot input and admitted capability receipts if the run launches.

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and exact template inventory | `docs/architecture/prompts/source-manifest.json` | `3b553f1ca220226a4905b9a42020083372b842c4b1bd3b601d72eefbff401231` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `0f6c07d59c41a7a08d111a825fae3ee960beff6b46bdba8a4605ffeaa31e1be7` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| Repository-controlled service schema reference | `docs/architecture/10-service-api-reference.md` | `c5a2de1d5562260b35cb89615e7ede24f986554fcba3701031d0f152cf2b306d` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `a47ab4981970af96dc89e2dc5413a7ae5aeb3aee7f8684b34d8c727819ae1c56` |

The literal researcher Profile and discovery templates have the same respective SHA-256 values as EXP-07, `e413390a531428c818d966111b64c20faef59e12b6476b05427ba0e20f9ee7c8` and `dcdf147e66b54731757e9a3ab5ee4a8847755ab2a16a9689bfd326da865a4d81`. Runtime deadline fields reflect the registered timing.

## Launch command

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-08 sha256:102b97faca7a35cab5b951f10a0b034a85a8d57879143eed5695ec2e865c2655 3600 600
```

## Live observations and stop criteria

Watch the fixed first four Bot identities from TaskService and reconcile actual accepted proposals, exclusive take and active Execution receipts with private Service traces. Record elapsed time to first proposal, take, save and subsequent collaboration, including the state at the original 300-second boundary where applicable. If all four first selection deadlines pass without an accepted proposal or take anywhere, stop the runner with SIGTERM and inspect the exact point where the workflow stopped. Confirmed worker, provider, repeated valid Service, checker or cleanup defects also trigger an early stop. Isolated rejected guesses and expected exclusive-claim races do not establish a system defect when another Bot progresses.

If the selection transition works, continue observing save, public publication, a second Bot's actual apply, main integration and independent original-theorem acceptance until a confirmed defect or the bounded window closes.
