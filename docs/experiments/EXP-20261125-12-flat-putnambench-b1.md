# EXP-20261125-12 · Flat PutnamBench 2025 B1

Status · SETTLED · Shared deadline · Final FAIL

Repeat of [EXP-20261125-11](EXP-20261125-11-flat-putnambench-b1.md) and follow-up to [EXP-20261125-10](EXP-20261125-10-flat-putnambench-b1.md). EXP-10 passed the original theorem and applied peer revisions, but its final proof was already complete before the applies. Its admitted Material followUps stayed outside subsequent model inputs. EXP-11 added model-chosen checkpoints. All active Bots continued tool work without yielding a checkpoint and the run stopped before its first saved revision. EXP-12 configures Material notifications to use the native steering queue and updates the researcher Profile to ask for early Lean diagnostics and targeted Mathlib search. It evaluates this combination on the same original task. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Main design commit `68eb83e0550109924c56035b4e90077deb399228`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `87f8268b543718ab3062d94e19a8672907033a8c`. Worker image `sha256:7011b3a199dc31c0bcb3b439db511cb4ab463509a89826db6d4f776f44bb03d7`, with matching revision label. |
| Comparison | Original Flat `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828` and immediate comparisons EXP-10 and EXP-11. EXP-10 pins its proof and adoption evidence separately. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty Task pool. Bots receive the original statement and public run state. Reference solutions, preassigned Tasks and prior-run artifacts stay outside the run. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Model and resources | Real hosted `kimi_proxy/k3`; four concurrent Bot slots; one Execution per Bot; refill after confirmed cleanup. Trusted selection forwards `low`. Work and closeout retain Pi effort. No research request count, token or fee cap. The Flat driver routes Material notifications at a native tool continuation and preserves ordinary followUp for handoff and dependency notices. |
| Window | Up to 3,600,000 ms of research after initial readiness, 600,000 ms per-Bot selection window, separate bounded independent final assessment and cleanup. |
| Acceptance | A saved proof declaration from one Bot is used by a different Bot in the latter's existing Session and Execution, reaches fixed final main and contributes to the original theorem's actual proof. The independent locked Lean checker must pass the same final tree. Continue to submit complete proofs when ready. Record verified original-theorem acceptance and proof adoption separately. |
| Evidence boundary | Raw traces, proof source and databases remain in the private run directory. Report only fixed input links, hashes and sanitized aggregated observations. |

## Tracked input hashes

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and template inventory | `docs/architecture/prompts/source-manifest.json` | `688a1445eeb970b3eaa1f5df4e2d644fa7526538c984972eddfa3b6d52521cf5` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `db00c38178aa178e9e247e5eb7ca8b9ac23d558df29e68b0d23a61fddffd643e` |
| Flat notification mode, input identity and fencing | `src/environments/flat/controller.ts` | `e0aab4a720b465adf8467a04af7896b2447230c0069e2e180102973217265fb5` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| Service schema reference | `docs/architecture/10-service-api-reference.md` | `832a9daff65c27f49d431ff047b5afa32cecda3e5e77cafd87e3cd6b73782cb3` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `39680088b260e27797695db6ec33c96736deea26b04f325ec97507e68ae29d3a` |

The generated researcher Profile and autonomous discovery template have respective body digests `4cb2d88fe307d5e6f03a8957098cb83e479bd9207855c9aa8cf2d0db1851c186` and `dcdf147e66b54731757e9a3ab5ee4a8847755ab2a16a9689bfd326da865a4d81`.

The launcher input is typed before forming the trusted gateway options. The same argument values remain valid. This registration updates the tested commit and image after the benchmark-only TypeScript check, before claiming the run ID.

## Launch command

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-12 sha256:7011b3a199dc31c0bcb3b439db511cb4ab463509a89826db6d4f776f44bb03d7 3600 600 low
```

## Live observations and stop criteria

Track first-cohort Task formation, first actual file save and Judge diagnostic, separately importable producer files, directed Material publication and authenticated routing. For each directed delivery, reconcile the durable recipient record, Core mode and admission disposition, next eligible native Pi model input and processing feedback. Track actual source adoption in the recipient's existing Session and Execution, its subsequent save, checked merge, fixed final main and the original theorem's proof dependencies. Record Mission and proof adoption separately.

Stop on trusted Mission acceptance, the common deadline or a confirmed workflow deviation. Stop early if every first-cohort selection deadline passes without a proposal or take, the provider rejects the registered settings, the selection override leaks into work, or a Worker, Service, checker or cleanup defect is confirmed. If an eligible admitted Material remains outside the next eligible model input after Pi completes a normal tool batch, verify the admission and request chronology and debug the boundary. A pending response, one invalid call or an ordinary source conflict is not sufficient evidence of a defect. Pin the settled candidate and record cleanup on every exit.

## Results

- The shared window opened at `12:03:41.645 UTC` and closed after `3,600 s`. Three Bots proposed and took work in the first 29 seconds. A fourth missed selection, closed and was replaced. Four Tasks and four Executions formed. Peak concurrency was four.
- Four Bots produced 50 post-seed immutable saves and received 48 settled Judge results. These comprised 34 `FAIL`, nine `PASS` and five `ERROR`. Error receipts included the checker diagnostic-retention bound, an original placeholder and Lean resource limits. The run also recorded 107 successful pinned Mathlib queries.
- The separate helper module at `0.18` passed at `12:44:09 UTC` and contained seven public declarations with no placeholder. Its successor `0.32` passed a module check at `12:50:06 UTC`. At `0.35`, the original path contained two auxiliary declarations. The fixed original target declaration was absent from that version. There was no Mission submission.
- No Bot published or linked a Material, called apply, or advanced main. The four admitted handoff warnings are a separate type. The formal trial therefore provided no observation of the new Material delivery mode. Frozen main remained seed `0.1`, commit `2bc07bedb01f7727ba3ea1c6e45f4bed6b1ae411`, tree `15cdae59fe9ba1dada06eb14959403ab364ac8bd`. Independent final assessment `treecheck:9fb7764f-9349-4136-9400-db831a5fdba8` returned `FAIL` for that tree.
- The gateway recorded 238 K3 attempts, with 235 metered completions totaling 24,183,468 input and 567,518 output tokens. Three interrupted attempts lack metered usage. The actual trace shows 20 selection requests at `low`, 210 work requests at `medium` and eight closeout attempts at `medium`. No request started after the common cutoff. All five Bots closed and released their slots. The cleanup audit found zero Worker containers and no pending checker or merge.

Each of the four Tasks requested a complete proof of the same theorem and was taken by its own proposer. No Task declared a dependency. All four takes pinned `0.1` and provided zero input Materials. Six of the seven successful Task listings explicitly queried `ready`. The unfiltered listing was in the opening burst, before any Task existed. The replacement Bot queried `ready` while three Tasks were already running, then created a fourth full-proof Task. No Bot submitted a Task finish. Every model request retained one user input, which was the discovery input. The four handoff warnings had controller admission receipts and stayed absent from the recorded K3 inputs.

| Bot | Task and Execution | Observed work |
|---|---|---|
| `ccde66ef` | `41326f50` and `1c4655c5` | 18 saves and 19 diagnostics. The first compiling saves were scratch checks. |
| `862405ef` | `a6386b9d` and `aea08e55` | 14 saves and 13 diagnostics. Separate reusable module passed at `0.18` and `0.32`. |
| `19e54f51` | `24c14de9` and `e7f55b33` | 8 saves and 6 diagnostics. No pass. |
| `c8ea0230` | Unclaimed | Reached the selection deadline without taking work. |
| `031d0e8c` | `5b7cc317` and `e153eefd` | Replacement. 10 saves and 10 diagnostics. Two auxiliary declarations compiled at `0.35`. |

## Analysis

The run had four autonomous workers but no decomposition of the Mission into distinct Task contracts. The ready queue hid claimed work from the actual discovery calls. Multiple local edits and diagnostics followed, but none crossed the notification or revision-adoption boundary. Keeping private directories pinned to their own revisions meant other researchers needed to find a saved revision, receive a Material, or read an updated main before adopting work. Main never advanced. One checked-result continuation took about 398 seconds and next requested a Mathlib search. Ten completed work responses took more than five minutes and the longest took about 1,249 seconds. Longer reasoning consumed time that could have been spent on file and Tool operations. The absence of distinct work and publication was already visible independently of that latency.

## Next steps

Further runs are on hold during owner review of Task discovery, division of work and the handoff flow. Keep strict original-theorem acceptance and an actual cross-Bot proof dependency as the combined pass condition.
