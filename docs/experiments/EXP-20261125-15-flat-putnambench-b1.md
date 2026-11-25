# EXP-20261125-15 · Flat PutnamBench 2025 B1

Status · SETTLED · Shared deadline · Final FAIL · Cross-Bot source transfer observed

Follow-up to [EXP-20261125-12](EXP-20261125-12-flat-putnambench-b1.md), with [EXP-20261125-10](EXP-20261125-10-flat-putnambench-b1.md) as a prior accepted proof without established proof adoption. Observe whether four K3 Bots given the actual Mission, current Task ownership and the registered collaboration commands produce distinct work, exchange reusable Lean source and integrate it into a proof within the shared time window. The prompt, command fixes and time window change together. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Main design commit `68eb83e0550109924c56035b4e90077deb399228`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `d2829b5e87f512df2ddf00c4cfdabfeb43049459`. Worker image `sha256:870eec86c9dffc9059a7f915b6cf94158f1dfce980fd78adf71203cf451cca00`, with matching revision label. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. One Mission, original Lean source in the first user message and initial Workspace, and an empty Task pool. The run excludes prior attempts, reference solutions and preassigned Tasks. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, `lean-final-tree` version `1`. Per checker process budget is 300,000 ms, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Model and resources | Real hosted `kimi_proxy/k3`, four concurrent Bot slots, one Execution per Bot, refill after confirmed cleanup. Selection sends `low`. Work and closeout retain Pi effort. No request count, token or fee cap. |
| Window | Up to 1,800,000 ms of research after all four initial slots are ready, up to 600,000 ms per Bot for selection within that common limit, followed by bounded independent assessment and cleanup. |
| Acceptance | Verify the original theorem on the fixed final main with the independent locked Lean checker. For collaboration acceptance, establish that one Bot's saved proof declaration is used by a different Bot in the latter's existing Session and Execution, reaches fixed final main and participates in the target proof's dependencies. Record both findings separately. |
| Evidence boundary | Raw traces, candidate files and databases stay in ignored private run storage. The report publishes pinned inputs, hashes, run aggregates and identifiers needed to verify conclusions. |

## Tracked input hashes

| File | SHA-256 |
|---|---|
| `benchmarks/putnambench-flat/main.ts` | `39680088b260e27797695db6ec33c96736deea26b04f325ec97507e68ae29d3a` |
| `benchmarks/putnambench-flat/run.ts` | `3baec34a32f06e2c816150e1262d7a1e61869a7456dd4963975fc75c6f81c769` |
| `src/core/startup-prompt.ts` | `e2c972ed13ddb476540d00b6bc9350ca9f05adce40a7f28971400c8441d0fd73` |
| `src/cli/service-command.ts` | `67ac954a55204ddc46fdf8c0462067b3da94c41f6c688ab4a23f15e2f88ce87f` |
| `src/cli/swarm-cli.ts` | `18dd810d9189366cc739e9d226c0080d5260d94c801dd126a08dd282b33ca818` |
| `src/environments/flat/controller.ts` | `4d718d125e2b409f3b8b5c0ab6d92f85c3eb9d2bba7891c58fcff62162dce76c` |
| `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| `src/environments/flat/task-service.ts` | `294aada68aa9d01243f81a09669f9c22ef5415dc2a20174f05e255476e41e384` |
| `src/environments/flat/publication-services.ts` | `ff0788f013182352490ca6cdb856dd9fc2352d711280d1f02e492b5122784d3f` |
| `docs/architecture/prompts/source-manifest.json` | `e7fd3b0462eae0d86fc4dd64c9e63b346ea52a0541296bda29ab63edd1f87b9f` |
| `docs/architecture/10-service-api-reference.md` | `1e2d90bd52307329c2f4de1bfbbbf683dce0d2832b177bf59ee5ebc4bef9e622` |

The Putnam Profile leaves Added System Prompt empty. Core renders the startup directory from the same authorized registered manifests used by the CLI. The experiment will check the actual provider input for each Bot, including replacements.

## Launch

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-15 sha256:870eec86c9dffc9059a7f915b6cf94158f1dfce980fd78adf71203cf451cca00 1800 600 low
```

Observe initial and replacement prompt parity, proposal scope, successful Task claims, real snapshots, Lean diagnostics and reusable public revisions. For a directed Material, follow publication, response link, delivery and receipt in the recipient's model input. Compare the subsequent use in source, saved parents, checked merge, final tree and proof dependencies. Stop on Mission acceptance, the common deadline, or a confirmed runtime, provider, fixture, or checker defect that prevents the registered workflow. If all four initial selection windows expire with no Task proposal or claim, stop to diagnose the missing workflow. If a directed notice has an admission receipt, audit the next eligible provider input after the native tool batch completes and stop if the delivery path is confirmed broken. Preserve and independently assess the available main on exit.


## Results

- Three independent reviews followed the change through Task and Mission, CLI and authorization, and Material and Workspace. All four exact-image native tests passed, including two notification delivery modes. The real Putnam entrypoint driven by a local controlled backend delivered the exact original statement and 31 authorized commands to all four positions. The repository suite passed on an isolated repeat with 1,250 passes, 69 conditional skips and zero failures.
- The research window opened at `14:15:28.293 UTC` and closed after 1,800 seconds. Four slots were available and nine Bots started across replacements. All nine actual first K3 requests carried the same system prompt digest `6a7cfc922dcbcdfea79ab58972ecb79c56b9ee1ae75e73ef2fae75f1b137cdce`, the original Lean source, the Mission and the Flat workflow. All nine had the four native tools.
- Four distinct Task IDs formed. Each contract targeted the complete original theorem and each first claimant took its own proposal. The first proposal was 14 seconds after the start. The second proposer reused a list read while the pool was empty and created its Task almost six minutes later. Two other initial Bots reached their selection timeboxes. Their replacements listed the two running Tasks and still chose whole-proof Tasks. Seven Executions formed across replacement handoffs, and no Task declared a dependency.
- The run made 38 successful Mathlib searches, three post-seed saves and three successful Judge calls corresponding to two fixed check results. The first save, at 23m43s, reached `0.2`. The checker reached its Lean recursion limit on that source. It recorded `ERROR` with a completed process. Revision `0.3` received `FAIL`. Two text Materials were published late.
- Three directed Material notices had admission receipts. Bot `61da6a86` received one in its next model request, read the Material and recorded feedback. The other two recipient traces show no subsequent model request after admission. A later Bot, `05d9d065`, read the first Material and separately applied `61da6a86`'s revision `0.3` in its active Execution. It saved `0.4` with parents `0.1` and `0.3` and a recorded Material use. Revisions `0.3` and `0.4` have identical project tree `64330cd2e16891bbbb52c1a94c6fa17691f66375`, confirming the transferred bytes and absence of further source edits in that save. The cited Material came from `84d51528`; the applied file came from `61da6a86`. A later apply was refused during soft closeout.
- No revision merged to main and no Mission submission occurred. Final main stayed at seed `0.1`, commit `3a85b93f0be267add65dc5fe1a913dccfb8c8069`, tree `15cdae59fe9ba1dada06eb14959403ab364ac8bd`. Independent result `treecheck:7b15ecf7-1d80-45ab-983f-4acebfa51dba` returned `FAIL`. No cross-Bot contribution reached a final proof.
- There were 101 K3 requests. Of these, 95 metered completions used 2,583,553 input and 160,972 output tokens. Two selection, two work and two closeout attempts have unknown usage. Actual request settings were `low` for 29 selection attempts and `medium` for 59 work and 13 closeout attempts. No model request started after the deadline. All nine slots were released, with zero Workers, pending Judge operations or pending merges.

## Analysis

The provider inputs confirm prompt delivery, and the actual calls confirm that models could use Task, Mathlib, Workspace and Material commands. The first four Tasks duplicated the same delivery responsibility. One duplicate followed a stale list result despite explicit refresh guidance. Two more followed fresh results containing the running whole-proof Tasks. Knowing what work exists did not lead those Bots to define checkable subtasks.

Long reasoning turns delayed actions. Two initial selection requests were interrupted at their selection limits. The first claimant sent its first work request around 18 seconds in and spent more than 13 minutes before its next tool-bearing request. Neither of the two initial claimants saved a revision. The late transfer verifies that the normal collaboration path can carry a peer's actual file. It left no checked integration or dependency in final main.

During the run the host updated its Python OAuth library at `14:16:46 UTC`. The next launch preflight detected a changed fingerprint for the whole read-only `/usr/lib` mount. The registered startup lock identified the deployment when this run opened. The late independent assessment used the same loaded verifier, after the host update. Upstream Lean and Mathlib, the verifier, process settings and named executable artifacts were verified unchanged at re-enrollment for the comparison.

## Next steps

The conditional model comparison uses [EXP-20261125-17](EXP-20261125-17-flat-putnambench-b1.md). It retains the original task, prompts, checker implementation, four slots and research time and records the refreshed host artifact fingerprint.
