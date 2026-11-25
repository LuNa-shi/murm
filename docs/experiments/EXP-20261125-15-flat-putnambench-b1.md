# EXP-20261125-15 · Flat PutnamBench 2025 B1

Status · REGISTERED

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

Observe initial and replacement prompt parity, proposal scope, successful Task claims, real snapshots, Lean diagnostics and reusable public revisions. For a directed Material, follow publication, response link, delivery and receipt in the recipient's model input. Compare the subsequent use in source, saved parents, checked merge, final tree and proof dependencies. Stop on Mission acceptance, the common deadline, or a confirmed runtime, provider, fixture, or checker defect that prevents the registered workflow. Preserve and independently assess the available main on exit.
