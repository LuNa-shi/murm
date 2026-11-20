# EXP-20261120-07 · Seymour with the full manuscript

## Setup

The owner requested a fresh Seymour run on the main revision that shipped the paper. The historical single-project run was EXP-20261120-02. The question is how the team divides, verifies and integrates a known proof. [Issue #159](https://github.com/LuNa-shi/SwarmEnv/issues/159) · [Historical resources and outcomes](EXP-20261120-02-seymour-single-4h.md)

| Condition | Frozen value |
|---|---|
| Runtime | Merged main `dfe8d8fae3dc26c66a8e8f761e7656fb6421d659`, ordinary openai/math runner, fresh project |
| Model and capacity | `gpt_proxy/gpt-6.2-sol`, Pi 1.3.0, one Seymour project, four Cores, four hours from research start, Bot upper bound four hours |
| Input | Original goal SHA-256 `fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98`, plus the PDF and its searchable text from manuscript manifest `7154d525431d105a19735bdacf3f0e34344df0c591dba8168deae1c3c9c6e74a` |
| Judge | Same Lean 4.34.1, Mathlib d13f23b, 600 seconds for ordinary and final checks, 8 GiB memory, 200% CPU, one Lake job |
| Worker | Merged runtime image `sha256:2ef3e022730622de197788860d5fc05b983f71ca13102d5ec0072bf7d1387dcc` |
| Evidence cuts | Freeze by event time at research start, each completed hour, and exit. For historical comparison also use the common research duration, capped at the historical deadline of 14,281,315 ms. Report setup and cleanup separately. |
| Stop | Trusted acceptance of the configured declaration, four-hour research deadline, owner stop, or an integrity or infrastructure failure compromising the study |
| Evaluator | Pinned 19-item rubric SHA-256 `e42f4cfc567311b77b10feb6adc2c64cd6418f4bdfdd636e5c1d3d65f70a1f91`. Rubric and reference Lean proof remain evaluator-side. |

For each score, preserve the public revision, exact statement, permitted assumptions, compatible witnesses and Lean evidence. An accepted root scores 1. Otherwise count distinct verified items in the best compatible package divided by 19. With unresolved assessments, publish the item statuses and leave the total pending. The fraction describes verified paper obligations. Difficulty and formalization effort vary by item. [Rubric and adjudication rules](../../benchmarks/openai-math-12/paper-progress/README.md)

For collaboration, follow a checked result from its producing Execution to a different Bot's use in a downstream proof, then to an integrated revision and the obligations that revision establishes. Record the first observed paper read separately from initial file availability. Preserve checked work in other directions with its mathematical scope. The historical run used ca85777, a different host runtime and Bot contract, and charged setup against its four hours. A causal paper-only comparison requires both conditions on the same implementation.

The new deployment lock is `ade992f23fa8a66ae888b746f77cbe5cf8959b01a34c5ad3e58404fa5522111d`. Comparison with the historical lock found the same Lean, Mathlib, comparator, module checker, resource policy and kernel validator. The merged verifier adds an exporter compatibility probe and the resource-owner helper changes one diagnostic string. Repository-bound artifacts are now pinned at this worktree. The merged Bot system prompt SHA-256 is `7c93d2320bb74c6fa150e500366606fd594dbd8e535995295fd3b044bdf5520f`. Per-service manifest hashes are captured by the project report. The owner confirmed one paper run on current main with historical results serving as context.

## Results

Registered before research. Results pending.
