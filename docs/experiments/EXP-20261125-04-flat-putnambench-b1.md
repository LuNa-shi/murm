# EXP-20261125-04 · Flat PutnamBench 2025 B1

Status · STARTUP FAILED

The [Phase 0005 Flat math design on main](https://github.com/LuNa-shi/murm/blob/fb457bbfc8fc038ac8f2cfbbcfd1ab4a4e655b02/docs/phases/0005-core-harness/04-taskpool-math.md) was merged in [`68eb83e`](https://github.com/LuNa-shi/SwarmEnv/commit/68eb83e0550109924c56035b4e90077deb399228). This registration precedes the first hosted request. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Design commit `95aecaefa2a99a17091b86141ebe16aca88c1191`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `e1494d60f71235d20eb82f08079edc67702ec6d1`. Worker image `sha256:ccf2e8dfed51158bb46bd7223b494c092f6a23d7756883743e53af124525d213`, revision label matches the implementation commit. |
| Reference and comparison boundary | Original Flat reference `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828`. One acceptance run with the restored workflow. Historical controlled and hosted observations have their own settings. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, source SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty autonomous Task pool. Reference proofs and preassigned Tasks excluded from Bot inputs. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, checker `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Provider and capacity | `kimi_proxy/k3`, real hosted Responses. Four concurrent Bot slots, one Execution per Bot, confirmed cleanup before refill. No total model request, Token or fee cap. |
| Window and stop | Open after the initial workers are ready. Research at most 3,600,000 ms. Stop on trusted Mission acceptance or deadline. Separate bounded final assessment of the fixed candidate and resource close receipts. |
| Acceptance | Track an A-origin fixed revision through B's existing Session and Execution, subsequent B-authored content, ancestry into fixed final main, and real use in the theorem proof. The locked Lean verifier must pass the same candidate. Record cutoff and cleanup separately. |
| Evidence boundary | Private local experiment directory for raw traces, proof and databases. Report links only pinned public inputs and sanitized aggregate evidence. |

## Tracked input hashes

The digests refer to repository-controlled inputs to prompt, Profile and tool composition. Preserve actual per-Bot input and admitted capability receipts if the run launches.

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and exact template inventory | `docs/architecture/prompts/source-manifest.json` | `c872e9f679ff54d1cbe8dee946c4f48264af4787c010d3750219de9333eeda55` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `5169332b457e1e71b9ed89ecbdb6eab581d76e6cf5fdc2bdbfce27afbeffc37a` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `68a8160f8351997916b814c22856c2dc6fae71f7bff55c0d3e061795f6a75f93` |
| Repository-controlled service schema reference | `docs/architecture/10-service-api-reference.md` | `c5a2de1d5562260b35cb89615e7ede24f986554fcba3701031d0f152cf2b306d` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `8c91b02507441aca1e2aa7a23b6beb99c1b865c88f54c747c0225734586462fe` |

## Launch command

```sh
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-04 sha256:ccf2e8dfed51158bb46bd7223b494c092f6a23d7756883743e53af124525d213
```

## Results

The command exited before Runtime allocation and before any upstream model dispatch. The checker rejected a file mode mismatch in the compiled module checker. The launcher recorded the experiment identity before the rejection. No research time elapsed and no Bot containers were allocated.

## Analysis

The launch used a restrictive process umask while the build uses process umask for checker artifact permissions. The artifact lock detected the permission difference and prevented execution. Under the standard build mode, the checker artifacts match the existing lock.

## Next steps

Repeat with the pinned build mode and original inputs in [EXP-20261125-05](EXP-20261125-05-flat-putnambench-b1.md).
