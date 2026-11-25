# EXP-20261125-11 · Flat PutnamBench 2025 B1

Status · REGISTERED

Repeat of [EXP-20261125-10](EXP-20261125-10-flat-putnambench-b1.md) for the remaining proof-adoption criterion. EXP-10 verified the original theorem and observed two cross-Bot apply operations. The accepted proof was the submitter's pre-apply proof, and none of the queued Material notifications reached the model in that run. This run changes only the researcher Profile. It asks Bots to detect overlapping work, deliver reusable lemmas in importable modules and return short work checkpoints that let queued peer results enter an existing Session. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Main design commit `68eb83e0550109924c56035b4e90077deb399228`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `c00b18b632be22e2d02d21a13b72ae18f18da92b`. Worker image `sha256:f56dfac327d4c754aca99793774441059d48b4f96eb70d0c053e0b7a96a77c3a`, with matching revision label. |
| Comparison | Original Flat `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828` and immediate comparison EXP-10. EXP-10 pins its proof and adoption evidence separately. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty Task pool. Bots receive the original statement and public run state. Reference solutions, preassigned Tasks and prior-run artifacts stay outside the run. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Model and resources | Real hosted `kimi_proxy/k3`; four concurrent Bot slots; one Execution per Bot; refill after confirmed cleanup. Trusted selection forwards `low`. Work and closeout retain Pi effort. No research request count, token or fee cap. The model chooses its work checkpoints. |
| Window | Up to 3,600,000 ms of research after initial readiness, 600,000 ms per-Bot selection window, separate bounded independent final assessment and cleanup. |
| Acceptance | A saved proof declaration from one Bot is used by a different Bot in the latter's existing Session and Execution, reaches fixed final main and contributes to the original theorem's actual proof. The independent locked Lean checker must pass the same final tree. Continue to submit complete proofs when ready. Record verified original-theorem acceptance and proof adoption separately. |
| Evidence boundary | Raw traces, proof source and databases remain in the private run directory. Report only fixed input links, hashes and sanitized aggregated observations. |

## Tracked input hashes

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and template inventory | `docs/architecture/prompts/source-manifest.json` | `da0cbd96b7d358148f410fa4b106ef807983a5cc24da46fbc48480ff1a81ed82` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `a92c4f9f14125da749be23f4c01bc41e7f1bab7c05ba607db05c731de9e7802a` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| Service schema reference | `docs/architecture/10-service-api-reference.md` | `832a9daff65c27f49d431ff047b5afa32cecda3e5e77cafd87e3cd6b73782cb3` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `8e74407672737f9b4881e7e557b7ba23e733b3abb04840597e6323be242f238b` |

The fixed researcher Profile and autonomous discovery text have respective SHA-256 values `be00dfbc7ed6b169c8bfcb5451afccb9d4442a36e9250974d6dd4160c9260057` and `dcdf147e66b54731757e9a3ab5ee4a8847755ab2a16a9689bfd326da865a4d81`.

## Launch command

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-11 sha256:f56dfac327d4c754aca99793774441059d48b4f96eb70d0c053e0b7a96a77c3a 3600 600 low
```

## Live observations and stop criteria

Track first-cohort Task formation, individual session checkpoints and trusted phase traces. For a directed Material, reconcile publication, routing, Core input admission, recipient model input and processing. Track separately importable producer files, recipient read/apply in the original Session and Execution, recipient proof changes, fixed final main and actual dependency from the final theorem.

Stop on trusted Mission acceptance, the common deadline or a confirmed workflow deviation. Stop early for a first cohort with every selection deadline elapsed and no accepted proposal or take, rejection of the registered model setting, phase-policy leakage, or a confirmed Worker, Service, checker or cleanup defect. If an eligible queued notice remains absent after its recipient returns a checkpoint and has a subsequent admitted input, reconcile the native queue before proceeding. Ordinary conflicts or single invalid guesses remain part of the run. Final assessment and cleanup are always recorded.
