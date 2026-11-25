# EXP-20261125-17 · Flat PutnamBench 2025 B1

Status · SETTLED · Original theorem accepted · Cross-Bot proof adoption verified

Model · `gpt_proxy/gpt-6.1-sol`

Conditional model comparison against [EXP-20261125-15](EXP-20261125-15-flat-putnambench-b1.md), authorized if the K3 run does not meet delivery. The original case, first inputs and Service instructions, Lean, four slots, 30-minute shared window and selection effort remain fixed. The provider/model selection and its launcher change. The host deployment lock was refreshed after an operating-system package update. A matched pair of individual runs can show observed differences in progression and results. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Main design commit `68eb83e0550109924c56035b4e90077deb399228`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `8e39303870e10ecd5ba6ba6a43a2e1f7acab6071`. Worker image `sha256:f461d488567216013059cb834d02fa19f48f4a853932815d697c8105ada465d8`, with matching revision label. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. One Mission, original Lean source in the first user message and initial Workspace, and an empty Task pool. The run excludes prior attempts, reference solutions and preassigned Tasks. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `75e288d8644e93325f4e932fcbf9dace9a4d1e214242caff5169658657c03030`, `lean-final-tree` version `1`. Per checker process budget is 300,000 ms, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Model and resources | Real hosted `gpt_proxy/gpt-6.1-sol`, four concurrent Bot slots, one Execution per Bot, refill after confirmed cleanup. Selection sends `low`. Work and closeout retain Pi effort. No request count, token or fee cap. |
| Window | Up to 1,800,000 ms of research after all four initial slots are ready, up to 600,000 ms per Bot for selection within that common limit, followed by bounded independent assessment and cleanup. |
| Acceptance | Verify the original theorem on the fixed final main with the independent locked Lean checker. For collaboration acceptance, establish that one Bot's saved proof declaration is used by a different Bot in the latter's existing Session and Execution, reaches fixed final main and participates in the target proof's dependencies. Record both findings separately. |
| Evidence boundary | Raw traces, candidate files and databases stay in ignored private run storage. The report publishes pinned inputs, hashes, run aggregates and identifiers needed to verify conclusions. |

The loopback startup check found and reproduced a K3-only guard in the shared research proxy. The registered implementation binds that guard to the selected model and still rejects mismatched requests before forwarding. No hosted requests were made by the check.

## Tracked input hashes

| File | SHA-256 |
|---|---|
| `benchmarks/putnambench-flat/main.ts` | `2d0432aba3638aef51b81083191bb174ebcb4814bef95c7134396db7c84f2721` |
| `benchmarks/putnambench-flat/run.ts` | `83a3e1c8b84556c26c5370439f6c643fa7ca0e55a28074ba25c63ec26afce423` |
| `src/core/startup-prompt.ts` | `e2c972ed13ddb476540d00b6bc9350ca9f05adce40a7f28971400c8441d0fd73` |
| `src/cli/service-command.ts` | `67ac954a55204ddc46fdf8c0462067b3da94c41f6c688ab4a23f15e2f88ce87f` |
| `src/cli/swarm-cli.ts` | `18dd810d9189366cc739e9d226c0080d5260d94c801dd126a08dd282b33ca818` |
| `src/environments/flat/controller.ts` | `4d718d125e2b409f3b8b5c0ab6d92f85c3eb9d2bba7891c58fcff62162dce76c` |
| `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| `src/environments/flat/task-service.ts` | `294aada68aa9d01243f81a09669f9c22ef5415dc2a20174f05e255476e41e384` |
| `src/environments/flat/publication-services.ts` | `ff0788f013182352490ca6cdb856dd9fc2352d711280d1f02e492b5122784d3f` |
| `docs/architecture/prompts/source-manifest.json` | `b709dde89f6bce9a235ccf2313c210203d9f30bdb41017e353d247d091b32fb5` |
| `docs/architecture/10-service-api-reference.md` | `1e2d90bd52307329c2f4de1bfbbbf683dce0d2832b177bf59ee5ebc4bef9e622` |
| `benchmarks/shared/run-window.ts` | `47014686a3299c460c2455fede548c3ae2fac5aff3bf727b2f914eeabb80357e` |

The Putnam Profile leaves Added System Prompt empty. Core renders the startup directory from the same authorized registered manifests used by the CLI. The audit checks the actual provider input for each Bot, including replacements.

An OS package update changed `python3-oauthlib` inside the host-library mount. Initial offline preflight rejected the old lock. The trusted lock command verified the same source pins, dependencies and deployment configuration and changed only the `host-library-0` entry. Its new SHA-256 is `fcfab40eac05b93a87c92e40707c3e97b2e2c631ba7d2f175b75ce3bb0f91d0e`. The Lean, Mathlib, Comparator, exporter, verifier and explicit tool artifacts retain their hashes.

## Launch

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-17 sha256:f461d488567216013059cb834d02fa19f48f4a853932815d697c8105ada465d8 1800 600 low gpt-6.1-sol
```

Observe initial and replacement prompt parity, proposal scope, successful Task claims, real snapshots, Lean diagnostics and reusable public revisions. For a directed Material, follow publication, response link, delivery and receipt in the recipient's model input. Compare the subsequent use in source, saved parents, checked merge, final tree and proof dependencies. Stop on Mission acceptance, the common deadline, or a confirmed runtime, provider, fixture, or checker defect that prevents the registered workflow. If all four initial selection windows expire with no Task proposal or claim, stop to diagnose the missing workflow. If a directed notice has an admission receipt, audit the next eligible provider input after the native tool batch completes and stop if the delivery path is confirmed broken. Preserve and independently assess the available main on exit.

## Results

- Parallel reviews checked Task and Mission semantics, the CLI and authorization contract, and Material and Workspace handoffs. The exact GPT image passed the same four-slot controlled startup check as K3. That check compared all 31 authorized operations against the actual shell CLI. The hosted trace captured the first request of all 12 Bots, including replacements. Every one had the same system prompt digest as K3 (`6a7cfc922dcbcdfea79ab58972ecb79c56b9ee1ae75e73ef2fae75f1b137cdce`), the four native tools and the exact original Lean source, Mission and Flat workflow in the user message. The registered GPT launcher passed all eight case and run-window tests, plus benchmark type checking and the Architecture checks.
- The first Task was proposed 10.3 seconds into the research window. Four initial Bots had claimed work within 34 seconds. The eventual integrator, `e7e9a92d`, proposed its own Task during selection and two more during its Execution. `0b264105` claimed the combinatorial Task that the integrator had proposed. Other initial Bots worked on the circle-to-plane bridge and the geometry of the finite grid. The run formed 11 Tasks and nine Executions. Eight Bots finished a Task and exited, making room for replacements. Three Tasks remained open when the Mission stopped.
- The first source save landed after 58.9 seconds. The run made 19 post-seed saves and one checked merge. Six Workspace applies succeeded. Twenty Materials were published. All 24 Material notices admitted to a running Execution appeared in a subsequent provider input for that recipient and were handled. Five other notifications had no assigned recipient Execution. An initial apply and consume used invalid parameter names. The integrator corrected the parameters and completed both operations. Another Bot also retried an invalid apply successfully.
- In the same Pi Session and Execution `58053075`, the integrator applied public revisions `0.11`, `0.10`, `0.12` and `0.13`, recorded Material use, and saved the combined proof at `0.17`. The revision parents record the incoming snapshots. Comparing the fixed Git tree confirms these three peer modules in final main have exact source bytes from their respective authors.

  | Module on final main | Peer Bot and source revision | Git blob |
  |---|---|---|
  | `BoolGrid.lean` | `0b264105`, `0.10` | `b455ecb130d57f96cdfc6b21af462d1a871bdb94` |
  | `Putnam2025B1Grid.lean` | `65ae3c30`, `0.12` | `45c03f5fb73b36856b879ab016b0605a3f285ecb` |
  | `CircleBridge.lean` | `1f865677`, `0.13` | `7680c659725f5589c6ba6089a6cb8a5d2be63a36` |

- The checked merge advanced main to `0.20` after 6m24s. Its commit `e1d79d08f6ddb3a9966ca07f55e3002ba2bd4692` has tree `eacc95ef8c253eb8fe31f1eee38bfc945fc0c8fd`, identical to the combined save `0.17`. The Mission accepted original theorem `putnam_2025_b1` at `15:05:05.727 UTC`, 8m34.206s after start, using the locked checker result `treecheck:f6acc98a-6de6-4090-ad4d-e35a9384f11e`. The controller stopped the research window after 8m36.170s.
- An independent source and Session audit confirmed the authors, exact module bytes and continuity of the integrator's Session. A second locked replay accepted the same tree as `treecheck:80a40af0-765e-45f7-8ae6-7c51d68b0642`. The accepted Lean export has SHA-256 `b5de23b48f2cd287c3a3930f95ef00eed1b3aab2cedb2febecf5cfd1febbf73e`. Traversing constants in the target's proof term yielded a path to a theorem in each peer module.

  - `putnam_2025_b1 → Putnam2025B1.color_eq_of_grid → Putnam2025B1.bool_grid_colors`
  - `putnam_2025_b1 → Putnam2025B1.exists_circle_grid`
  - `putnam_2025_b1 → Putnam2025B1.tripleRule_of_circumcenter → Putnam2025B1.color_center_of_three`

- The provider ledger recorded 205 metered completions, with 4,933,770 input and 32,245 output tokens. Actual provider requests used `low` effort for all 62 selection calls and `medium` for all 143 work calls. Peak concurrency was four. All 12 Bots were released and no Sandbox, checker or merge work remained. At Mission shutdown, the controller recorded the integrator's still-active Execution as `FAILED / flat-ended`. The independently accepted Mission result is `PASS`.

## Analysis

The GPT Bots turned the shared problem into work on distinct pieces of one proof, selected a Task proposed by a peer, and produced separate Lean modules. A single long-lived Execution integrated those modules while the peer Executions finished and their slots refilled. The first Material appeared before the first source save, and the notice audit shows that publication led to model-visible inputs throughout active work.

K3 had the same startup text, tools and Service instructions. It made its first source save after 23m43s, eventually transferred a peer revision, and reached the time limit without a checked merge. GPT saved before the first minute and delivered an accepted original proof in just over eight minutes. The observed difference includes work selection, tool cadence and delivery in two individual runs. Both providers used the same fixture, concurrency and time limit. The launcher selected a different provider and the host had the package update recorded above. This comparison does not estimate a population effect of the model.

## Next steps

Preserve both outcomes and their fixed inputs in Issue #200. The GPT result shows one accepted collaborative proof through the ordinary Flat entrypoint. Establishing how often either provider produces this outcome would require repeated runs.
