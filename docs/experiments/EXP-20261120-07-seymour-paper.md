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

The registration commit ec20e65 changed experiment documentation only. The active service used that checkout. The authoritative research start was 08:56:18.416 UTC on November 20, 2026, with deadline 12:56:18.416 UTC. Initial public revision 0.1 (Git b70a806509c3bb3620d584719e209baee0180dfd) contains the unchanged 913-byte goal, 387,437-byte PDF and 39,808-byte text. All three hashes match the selected inputs.

All four initial Bots received HTTP 200 model responses and took distinct responsibilities. Core 2, 3 and 4 tool returns at 08:56:39.295, 08:56:41.450 and 08:56:47.403 UTC match lines of the supplied manuscript. Initial running Tasks included the strongly connected reduction (830f0aca), subset deficit from arc-minimality (1f8858d2), selection of a minimal counterexample (8f9dd264), and transitive-block amplification (4021b60c). These are observed work assignments. The initial observation recorded these responsibilities before the first proof assessment.

The offline final checker rejected the original hole with the two paper files present. In the same condition it accepted the full private reference proof in 56.775 seconds (treecheck:e326fc93-d39a-4eb8-bb74-7126fd1eb3db). The actual worker passed all three built-image contract tests and the disk quota probe. A separate read-only recorder now retains time-cut revision, Judge and Material identifiers. Its initial export was recovered from timestamped records after correcting the Material producer column name. The fixed start cut contains just public revision 0.1 and no Judge checks.

### Trusted outcome

**PASS.** The final-tree Judge accepted the configured declaration `OAI.SeymourSecondNeighborhood.exists_goodVertex` at 09:55:13.132 UTC. The fixed public revision was `0.147`, Git `7d90cb5ec7d344ea554967f655bbcc29dc5db1f3`. The accepted submission was `accept-seymour-0147-dbfca9b6` and its receipt was `treecheck:a6290c86-0ced-42fd-a1ef-20b1229602ef`. From research start to trusted acceptance the elapsed time was **58 min 54.716 s**. The project recorded `solved=true`, `protocol_valid=true` and no invalid reasons. Under the preregistered rubric the final score is **1.00** via whole-target acceptance. Individual milestone completion times were not adjudicated.

| UTC | Public evidence | What it establishes |
|---|---|---|
| 08:56:18.416 | Research start, revision 0.1 | The only Lean file was the original target with its proof hole. The manuscript PDF and searchable text were present. |
| 09:42:55.772 | Revision 0.134, module check b2a20bd0-3c78-432e-b4ae-cd4f1e9470d5 | A candidate closed the configured root using the transitive-blowup adapter and the unconditional pruning theorem. |
| 09:45:44.519 | Main 0.137 | The integrated target and pruning module match the corresponding checked candidate files byte for byte. |
| 09:46:54.439 and 09:49:45.399 | Main 0.137 and 0.144, final receipts a35e1230 and 407f1eb6 | The whole-project source filter matched words in Lean comments. The first tree had two matching comments; the second still had one. |
| 09:52:11.837 → 09:55:13.132 | Main 0.147, third submission | Following edits to those comments, final verification of the fixed tree passed in 3 min 1.295 s from submission. |

The report ended at 09:55:44.155 UTC, ahead of the first full research hour. Setup took 119.814 s and the final cleanup phase took 1.020 s. All 39 Bots closed and the report has no cleanup errors. The Judge store recorded 54 ordinary passes, 59 source failures and 6 Lean resource limits. The three final submission decisions are recorded separately. Of 977 model attempts, 967 completed with usage receipts covering 41,070,107 input and 290,840 output tokens. Ten interrupted transports have unknown usage. Monetary cost was unavailable.

## Analysis

The accepted tree shows how results moved across responsibilities. Core 1's selected-matching interface (Task a32ec1db, Material 52f400d0) and the joint rank premises (Task b304122c, Material b3ff9f14) are both called inside the final pruning theorem. Core 2's integrating Execution 8dd11af3 recorded both Material uses. The target imports this pruning module and the composition module, then applies the blowup adapter contributed by Core 3 (Material 3a34f91e). The comparator accepted that same target on integrated main. This establishes a specific chain of production, consumption, integration and acceptance.

The ten-minute observer first recorded main 0.136 with an open target, then main 0.147 with the final decision pending, and finally the accepted tree at settlement. Its evidence is read-only. The two earlier rejections arose because the runner applies its source filter to all submitted Lean text, including comments. Both offending lines were documentation. The third submission retained the mathematical content of the corrected modules and passed the full checker.

The historical four-Core no-paper run ended without a trusted root. This run supplies direct evidence that the team used the manuscript and assembled a checked proof. Differences in runtime revision, Bot contract, time accounting and stochastic model trajectories limit a causal estimate of the paper's effect or of the benefit of four Cores.

## Next steps

The registered stopping condition was reached. The startup, prospective hourly and settlement recorder captured start and settlement; no full research hour elapsed. The hourly cuts after acceptance do not apply.
