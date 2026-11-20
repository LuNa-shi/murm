# EXP-20261120-01 · OpenAI Math entries 1 and 2

## Setup

The owner selected the configured order for two successive four-hour pairs. This registration covers the first pair. The previous single-project diagnostic ran on a different verifier revision. [Issue #153](https://github.com/LuNa-shi/SwarmEnv/issues/153) · [PR #147](https://github.com/LuNa-shi/SwarmEnv/pull/147)

| Input | Fixed value |
|---|---|
| Runtime revision | `529d5dfdf602e49014079eb5b9856716d72f4de3`; launch metadata records the exact checkout including this registration |
| Projects | `oai_seymour_second_neighborhood`, `oai_one_way_liveness` |
| Fixture commit | `fa30b4c4f6a68cac222daf3cb5a11e1e2bbbf36a` |
| Challenge source SHA-256 in configured order | `fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98`, `875eb3b5bd7f84214e571fd1bb1257260c81cd583fb28517b401c987faa44c3b` |
| Model and image | `gpt_proxy/gpt-6.2-sol`, `swarmenv-agent:openai-math-gpt62-b4a02f5`, image `029d4b1e09feac0b8a6094188eb132664ab61b61ea6f4eca8fcaa99c54658996` |
| Checker | Lean 4.34.1, Mathlib `d13f23b723b8a846827a245b89c10fc7d3f11612`, `openai-math-v1`, repaired lock `81d6e766f69e32a074b0f89c1c4918bf9f4b19b6530c992c261b4ff038fd85ab`, 120 s per check |
| Budget | 2 simultaneous projects, 4 Cores per project, project and Bot maxima 14,400,000 ms. Trusted acceptance, deadline or operator stop ends a project. Supervision preserves incomplete and interrupted outcomes. |
| Information boundary | Challenge only per public Workspace, private reference proofs used in preflight. Each project report records its prompt and registered service schema hashes. |
| Evidence | Private local `experiments/EXP-20261120-01/`, per-project reports, project, Context, Judge and model ledgers, and supervisor samples. Publish reviewed aggregate results. |

Observe active Cores, model transport, Task take and handoff, Workspace writes, check classification, confirmed mathematical advances and final Mission acceptance for each project. Observe failure symptoms and cleanup through project termination.

## Results

Registered before model launch. Private full-goal controls passed both tasks under the pinned checker. Seymour passed with the reference files in their original module layout. OneWay's original layout reached the checker deadline. Recombining the same Lean sources into one module by import order produced a full kernel-verified PASS in 69.6 s.
