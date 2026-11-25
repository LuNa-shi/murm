# EXP-20261125-10 · Flat PutnamBench 2025 B1

Status · REGISTERED

Repeat of [EXP-20261125-09](EXP-20261125-09-flat-putnambench-b1.md) under the owner's authorization to rerun after independent review. EXP-09 formed four Tasks and published a text Material. The producing Bot repeatedly supplied incorrect recipient arguments when trying to notify other Tasks. This run gives the Bot a working response-link command in its researcher Profile and CLI help, and describes the same contract in the Service manifest. The Service's behavior and authorization rules remain unchanged. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Authoritative main design commit `68eb83e0550109924c56035b4e90077deb399228`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `59c2f2d9d4d284884de03904db302e6cd82d515f`. Worker image `sha256:21fb6bf6a6f0c4b3e5d3e8f44652eca5c2e75a441629dc5bb1a66ec3898308b1`, with matching revision label. |
| Reference and comparison boundary | Original Flat `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828`, immediately preceding hosted diagnostic EXP-09. Compare individual observations with their fixed configurations. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty autonomous Task pool. Reference solutions, historical artifacts and preassigned Tasks excluded from Bot inputs. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Model and resources | Real hosted `kimi_proxy/k3`, four concurrent Bot slots, one Execution per Bot, refill after confirmed cleanup. Gateways preserve Pi's effort for work and closeout and send `low` for trusted selection permits. No research request count, Token or fee cap. |
| Window | Research begins after initial readiness and runs for at most 3,600,000 ms. The per-Bot selection allowance is 600,000 ms. Independent final assessment and cleanup have separate bounded timers. |
| Acceptance | At least one A-origin saved proof revision is actually used by B in the same B Session and Execution, contributes to the fixed final main tree, and is used by the proof of the original statement. The independently locked Lean checker must accept the same tree. The notification alone is recorded as a separate workflow step. |
| Evidence boundary | Raw evidence stays in the private run directory. The public report uses fixed hashes and sanitized observations. |

## Tracked input hashes

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and exact template inventory | `docs/architecture/prompts/source-manifest.json` | `0dabc1e79e93939f80682f4f7c4797febe1d3fa1ce22ea318968fdd1a1414682` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `7f041aa8c9f8005b32051984a419ec8834022fe68350b26022ec9334cdfddfb8` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| Repository-controlled service schema reference | `docs/architecture/10-service-api-reference.md` | `832a9daff65c27f49d431ff047b5afa32cecda3e5e77cafd87e3cd6b73782cb3` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `8e74407672737f9b4881e7e557b7ba23e733b3abb04840597e6323be242f238b` |

The literal researcher Profile and autonomous discovery templates have respective SHA-256 values `074b63e290bdf87234ce5201b1958c0b7000f77db887075a91488b6626a07c8f` and `dcdf147e66b54731757e9a3ab5ee4a8847755ab2a16a9689bfd326da865a4d81`. The registered window determines the dynamic deadline fields.

## Launch command

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-10 sha256:21fb6bf6a6f0c4b3e5d3e8f44652eca5c2e75a441629dc5bb1a66ec3898308b1 3600 600 low
```

## Live observations and stop criteria

Reconcile Task formation and first take with the active Execution receipts and phase-specific model traces. For each new published Material, observe directed link arguments, its durable notification, the identity admitted through the controller, and any actual model receipt or feedback. Separately track proof saves, cross-Bot apply and adoption, checked merge and fixed final tree.

Stop on trusted Mission acceptance, the research deadline, or a confirmed unexpected workflow failure. A first selection cohort in which every selection deadline passes without an accepted proposal or take, repeated recipient-binding failures with the new guidance, rejection of the registered model setting, phase-policy leakage, or a confirmed Worker, Service, checker or cleanup defect qualifies for early diagnosis. An ordinary exclusive-take race or single rejected invalid argument is expected and remains observable. Record all candidate and cleanup facts after closure.
