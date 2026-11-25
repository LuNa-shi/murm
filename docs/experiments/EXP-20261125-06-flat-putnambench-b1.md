# EXP-20261125-06 · Flat PutnamBench 2025 B1

Status · SETTLED · benchmark acceptance failed

Repeat of [EXP-20261125-05](EXP-20261125-05-flat-putnambench-b1.md) after a measured selection-window interruption. The corrected entry restores the original 300-second selection allowance and asks Bots to claim a bounded task before detailed proof search. The run starts from the same original fixture and empty Task pool.

The [Phase 0005 Flat math design on main](../phases/0005-core-environment/04-flat-math.md) was merged in [`68eb83e`](https://github.com/LuNa-shi/SwarmEnv/commit/68eb83e0550109924c56035b4e90077deb399228). This registration precedes the first hosted request. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Design commit `95aecaefa2a99a17091b86141ebe16aca88c1191`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `61f6efd0f6fe15a472e54bd2dfa368bc9b496513`. Worker image `sha256:18ee099ab459511b1d21ca85401ad9df77b1fe10b7ff537339f87b6769b8c7fe`, revision label matches the implementation commit. |
| Reference and comparison boundary | Original Flat reference `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828`. One acceptance run with the restored workflow. Historical controlled and hosted observations have their own settings. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, source SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty autonomous Task pool. Reference proofs and preassigned Tasks excluded from Bot inputs. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, checker `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Provider and capacity | `kimi_proxy/k3`, real hosted Responses. Four concurrent Bot slots, one Execution per Bot, confirmed cleanup before refill. No total model request, Token or fee cap. |
| Window and stop | Open after the initial workers are ready. Research at most 3,305,000 ms. EXP-20261125-05 used 294,098.923 ms. Together these windows stay within the original 3,600,000 ms allowance. Stop on trusted Mission acceptance or deadline. Separate bounded final assessment of the fixed candidate and resource close receipts. |
| Acceptance | Track an A-origin fixed revision through B's existing Session and Execution, subsequent B-authored content, ancestry into fixed final main, and real use in the theorem proof. The locked Lean verifier must pass the same candidate. Record cutoff and cleanup separately. |
| Evidence boundary | Private local experiment directory for raw traces, proof and databases. Report links only pinned public inputs and sanitized aggregate evidence. |

## Tracked input hashes

The digests refer to repository-controlled inputs to prompt, Profile and tool composition. Preserve actual per-Bot input and admitted capability receipts if the run launches.

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and exact template inventory | `docs/architecture/prompts/source-manifest.json` | `bf0b1dd81fa8e44243ff097f411f0f0b55e3eedb8d7492937affc7cc6278617f` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `e61169c482a44c74a35a2cba8210b47fa1fd8868c60406a48dbc81ce70515361` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `68a8160f8351997916b814c22856c2dc6fae71f7bff55c0d3e061795f6a75f93` |
| Repository-controlled service schema reference | `docs/architecture/10-service-api-reference.md` | `c5a2de1d5562260b35cb89615e7ede24f986554fcba3701031d0f152cf2b306d` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `0bdc54796734b5faa96ae33c45c3190a21c57283d272de0c31b0dae8a3926fb4` |

## Launch command

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-06 sha256:18ee099ab459511b1d21ca85401ad9df77b1fe10b7ff537339f87b6769b8c7fe 3305
```

## Results

The four slots opened the research window at 07:42:06.254 UTC. Runtime setup took 17.159 seconds after locked checker preflight. The window closed at 08:37:11.254 UTC after 3,305.000 seconds. The final receipt was saved at 08:38:29.540 UTC after checker and cleanup settlement. Combined with EXP-20261125-05, the two real K3 windows used 3,599.099 seconds.

| Observation | Result |
|---|---|
| Hosted model | Exact trace pair `kimi_proxy/k3`. 304 admitted requests received upstream HTTP 200. Core recorded 259 completed responses and 45 interrupted streams with unknown terminal usage. Every admission was in selection. No request started at or after cutoff. |
| Metered usage | 847,747 input tokens and 49,904 output tokens for the 259 completed responses. Usage for the interrupted streams and actual billed cost are unknown. |
| Tasks and proof work | 44 successful Task lists and 44 successful public reads. Zero Task proposals, takes, Executions, Materials, saves, applies, merges or Mission submissions. |
| Retained candidate | Main revision `0.1`, commit `aa5b26a8857579dab7381b6dd00cbe721936859b`, tree `15cdae59fe9ba1dada06eb14959403ab364ac8bd`. The only file matched the original B1 SHA-256 byte for byte. |
| Final checker | Independent `treecheck:1063420d-8219-4a0f-b283-7159494ea8f9` returned **FAIL** for the fixed tree. The inspected source still had its original placeholder. There was no Mission acceptance. |
| Stop and cleanup | Stop reason `deadline`, peak four concurrent slots. 45 domain Bots reached CLOSED, 42 at the selection deadline and three in final controller closure. Core returned 46 stopped and cleaned resource receipts, including one startup canceled near cutoff. Provider inventory showed zero remaining containers. No pending Judge or merge work. |

## Analysis

The real run reached public discovery, repeated slot reuse, cutoff and cleanup. Multiple Bots read command help for creating a Task, and some tried to query Mathlib while still unbound. The trace records two Mathlib denials under the configured policy. Long reasoning streams continued until selection expired across successive teams. The run never exercised the task-creating Service with an actual proposal. The controlled Pi/OpenSandbox diagnostic covered creation, save, apply and feedback through the ordinary entry and does not establish that K3 used any of these operations here.

The evidence identifies the transition from discovery to Task creation as the failure point. It does not isolate whether the discovery prompt, default reasoning behavior or the timing of public reads drove the model's decisions. The independent check rejected the unchanged input. There is no mathematical output or cross-Bot proof adoption to evaluate.

## Next steps

The approved one-hour research allowance is spent. A further hosted run needs a new allowance and a preregistered change to the selection setup. A narrowly scoped follow-up would measure time to first autonomous proposal and take, preserving the real fixture, four slots, and the same proof and adoption gates. [Implementation #213](https://github.com/LuNa-shi/SwarmEnv/pull/213) remains open for the missing hosted acceptance.
