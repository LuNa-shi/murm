# EXP-20261120-01 · OpenAI Math entries 1 and 2

## Setup

The owner selected the configured order for two successive four-hour pairs. This registration covers the first pair. The previous single-project diagnostic ran on a different verifier revision. [Issue #153](https://github.com/LuNa-shi/SwarmEnv/issues/153) · [PR #147](https://github.com/LuNa-shi/SwarmEnv/pull/147)

| Input | Fixed value |
|---|---|
| Runtime revision | `b56d030`; launch metadata records the exact checkout including this registration |
| Projects | `oai_seymour_second_neighborhood`, `oai_one_way_liveness` |
| Fixture commit | `fa30b4c4f6a68cac222daf3cb5a11e1e2bbbf36a` |
| Challenge source SHA-256 in configured order | `fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98`, `875eb3b5bd7f84214e571fd1bb1257260c81cd583fb28517b401c987faa44c3b` |
| Model and image | `gpt_proxy/gpt-6.2-sol`, `swarmenv-agent:openai-math-wait-b56d030`, image `d09c08f6859cb5ee0d75ae2c370fed47eefab4a9ece217e9ffb446ee00e0d7cf` |
| Checker | Lean 4.34.1, Mathlib `d13f23b723b8a846827a245b89c10fc7d3f11612`, `openai-math-v1`, 600 s for ordinary Lean and final acceptance, deployment lock `f0a85f1886c8fc546dfb925a9133908e1e69ff96c8bd4ddd80d303c4adadf891` |
| Budget | 2 simultaneous projects, 4 Cores per project, project and Bot maxima 14,400,000 ms. Trusted acceptance, deadline or operator stop ends a project. Supervision preserves incomplete and interrupted outcomes. |
| Information boundary | Challenge only per public Workspace, private reference proofs used in preflight. Each project report records its prompt and registered service schema hashes. |
| Evidence | Private local `experiments/EXP-20261120-01/`, per-project reports, project, Context, Judge and model ledgers, and supervisor samples. Publish reviewed aggregate results. |

Observe active Cores, model transport, Task take and handoff, Workspace writes, check classification, confirmed mathematical advances and final Mission acceptance for each project. Observe failure symptoms and cleanup through project termination.

## Results

Registered before model launch. The owner subsequently authorized the same 600 s maximum for ordinary Lean and final checks across all four problems. Before this adjustment, private full-goal controls passed the first pair under the 120 s lock. Seymour passed with the reference files in their original module layout. OneWay's original layout reached the checker deadline. Recombining the same Lean sources into one module by import order produced a full kernel-verified PASS in 69.6 s.

Under the approved 600 s lock, the private complete proofs passed for all four entries. The public model inputs still contain only the corresponding challenge. These times measure formal verification of existing proofs.

| Configured entry | Time | Final checker receipt |
|---|---:|---|
| SeymourSecondNeighborhood | 55.580 s | `e6d464eb-883d-4765-8d79-4ac45665bca1` |
| OneWayLiveness | 68.946 s | `60faf7a7-0522-41f9-86cb-662b647ab54c` |
| PartialPermutation | 266.030 s | `92cda2cd-6a1e-4d36-b24a-963295fdb050` |
| ShortEgyptianFractions | 253.638 s | `0c80fd8f-732e-41f9-9aa2-4ab4ef225776` |

A separate offline replay matched all 22 historical module errors from the single-project run to their immutable Workspace revisions. Seven modules passed and 15 returned Lean source errors. Six passing modules or their dependencies still carried placeholders. The original run's recorded verdicts and Mission outcome stand.

The image passed the isolated Pi startup, fixed input and filesystem quota probes. Its CLI reported the deployed HTTP allowance of 2,430,000 ms for Judge checks. The ordinary and final Lean process limits are each 600,000 ms, also bounded by remaining lifecycle time.
