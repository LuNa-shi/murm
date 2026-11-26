# EXP-20261125-05 · Flat PutnamBench 2025 B1

Status · OPERATOR STOP · selection window defect

Repeat of [EXP-20261125-04](EXP-20261125-04-flat-putnambench-b1.md), which stopped before model dispatch. The implementation, fixture, Worker, model, checker lock and run allowance retain their original pins. The launcher rebuilds with the file mode expected by the pinned checker.

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
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-05 sha256:ccf2e8dfed51158bb46bd7223b494c092f6a23d7756883743e53af124525d213
```

## Results

The research window opened at 07:32:02.431 UTC and ran for 294.099 seconds before an operator stop. Setup took 17.056 seconds after locked checker preflight. The controlled ledger recorded 90 admitted responses, 78 completed K3 responses and 12 interrupted or unknown responses. The metered completed subset used 227,674 input and 9,420 output tokens. The record contains no actual billing amount.

Twelve Bots were provisioned with a peak of four and all resources were cleaned up. The first eight Bots reached their selection deadline. They read the original source and no Task proposal or take settled. There were no Executions, materials, checker submissions or published work revisions. The retained candidate was the seed main 0.1, tree `15cdae59fe9ba1dada06eb14959403ab364ac8bd`. The interrupted run recorded an ERROR for its post-stop assessment. The separate locked seed preflight established that this original placeholder is rejected.

## Analysis

The first eight Sessions streamed K3 reasoning after reading the fixture and lost authority at the 120-second selection boundary. The original Putnam runner allowed 300 seconds. No Task claim or subsequent mathematical evidence was available to assess collaboration or proof completion. Core model ledger receipts are authoritative for tool-visible completions. The window transport projection marked all calls aborted and is unsuitable for completion counts on this run.

## Next steps

Use the unspent portion of the one-hour research allowance in [EXP-20261125-06](EXP-20261125-06-flat-putnambench-b1.md), with the selection correction and the original checker lock.
