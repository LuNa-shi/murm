# EXP-20261125-10 · Flat PutnamBench 2025 B1

Status · SETTLED · ORIGINAL THEOREM PASS · PROOF ADOPTION NOT ESTABLISHED

Repeat of [EXP-20261125-09](EXP-20261125-09-flat-putnambench-b1.md) under the owner's authorization to rerun after independent review. EXP-09 formed four Tasks and published a text Material. The producing Bot repeatedly supplied incorrect recipient arguments when trying to notify other Tasks. This run gives the Bot a working response-link command in its researcher Profile and CLI help, and describes the same contract in the Service manifest. The Service's behavior and authorization rules remain unchanged. [Issue #200](https://github.com/LuNa-shi/SwarmEnv/issues/200)

## Setup

| Item | Fixed value or reference |
|---|---|
| Parent Issue, design and implementation | [#200](https://github.com/LuNa-shi/SwarmEnv/issues/200), [#212](https://github.com/LuNa-shi/SwarmEnv/pull/212), [#213](https://github.com/LuNa-shi/SwarmEnv/pull/213). Authoritative main design commit `68eb83e0550109924c56035b4e90077deb399228`, design Git blob `0db49d8de9a83426fe374aa40b7800089622e230`. |
| Tested implementation | `59c2f2d9d4d284884de03904db302e6cd82d515f`. Worker image `sha256:21fb6bf6a6f0c4b3e5d3e8f44652eca5c2e75a441629dc5bb1a66ec3898308b1`, with matching revision label. |
| Reference and comparison boundary | Original Flat `fcbe0107d8b4b204db0bcfa2a1ad1b2339c6293e`, migration baseline `ce3e503ba534d2b9cf42423aa0cdcdcc80766828`, immediately preceding hosted diagnostic EXP-09. Compare individual observations with their fixed configurations. |
| Original fixture | PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`, `lean4/src/putnam_2025_b1.lean`, target `putnam_2025_b1`, SHA-256 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`. Empty autonomous Task pool. Reference solutions, historical artifacts and preassigned Tasks excluded from Bot inputs. |
| Lean and verifier | Lean 4.33.1, Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`, artifact lock `6a6b65cb5d0ae4a91d5b5c72e41da7c579c01a26ed0ea2614e610783ea5d0d4a`, `lean-final-tree` version `1`. 300000 ms per checker process budget, 4 GiB memory, 0 swap, 64 tasks, 200% CPU. |
| Model and resources | Real hosted `kimi_proxy/k3`, four concurrent Bot slots, one Execution per Bot, refill after confirmed cleanup. Gateways preserve Pi's effort for work and closeout and send `low` for trusted selection permits. No research request count, Token or fee cap. |
| Window | Research begins after initial readiness and runs for at most 3,600,000 ms. The per-Bot selection allowance is 600,000 ms. Independent final assessment and cleanup have separate bounded timers. |
| Acceptance | At least one A-origin saved proof revision is actually used by B in the same B Session and Execution, contributes to the fixed final main tree, and is used by the proof of the original statement. The independently locked Lean checker must accept the same tree. The notification alone is recorded as a separate workflow step. |
| Evidence boundary | Raw evidence stays in the private run directory. The public report uses fixed hashes and sanitized observations. |

## Tracked input hashes

| Input | File | SHA-256 |
|---|---|---|
| Prompt source and exact template inventory | `docs/architecture/prompts/source-manifest.json` | `0dabc1e79e93939f80682f4f7c4797febe1d3fa1ce22ea318968fdd1a1414682` |
| Benchmark prompt, Profile assembly and time window | `benchmarks/putnambench-flat/run.ts` | `7f041aa8c9f8005b32051984a419ec8834022fe68350b26022ec9334cdfddfb8` |
| Flat Profile, identity grants and service selection | `src/environments/flat/environment.ts` | `a90e3a2cf4d0b013fbeb637afb4ce14d9d8a5e4876ee4e2f9c74d2f82de87ca0` |
| Repository-controlled service schema reference | `docs/architecture/10-service-api-reference.md` | `832a9daff65c27f49d431ff047b5afa32cecda3e5e77cafd87e3cd6b73782cb3` |
| Model, runtime, isolation and launcher entry | `benchmarks/putnambench-flat/main.ts` | `8e74407672737f9b4881e7e557b7ba23e733b3abb04840597e6323be242f238b` |

The literal researcher Profile and autonomous discovery templates have respective SHA-256 values `074b63e290bdf87234ce5201b1958c0b7000f77db887075a91488b6626a07c8f` and `dcdf147e66b54731757e9a3ab5ee4a8847755ab2a16a9689bfd326da865a4d81`. The registered window determines the dynamic deadline fields.

## Launch command

```sh
umask 022
node benchmarks/putnambench-flat/main.ts run PRIVATE_CHECKER_CONFIG PUTNAMBENCH_ROOT EXP-20261125-10 sha256:21fb6bf6a6f0c4b3e5d3e8f44652eca5c2e75a441629dc5bb1a66ec3898308b1 3600 600 low
```

## Live observations and stop criteria

Reconcile Task formation and first take with the active Execution receipts and phase-specific model traces. For each new published Material, observe directed link arguments, its durable notification, the identity admitted through the controller, and any actual model receipt or feedback. Separately track proof saves, cross-Bot apply and adoption, checked merge and fixed final tree.

Stop on trusted Mission acceptance, the research deadline, or a confirmed unexpected workflow failure. A first selection cohort in which every selection deadline passes without an accepted proposal or take, repeated recipient-binding failures with the new guidance, rejection of the registered model setting, phase-policy leakage, or a confirmed Worker, Service, checker or cleanup defect qualifies for early diagnosis. An ordinary exclusive-take race or single rejected invalid argument is expected and remains observable. Record all candidate and cleanup facts after closure.

## Results

Three independent prelaunch reviews confirmed the configuration and Worker image. The locked seed preflight gave ordinary project `PASS` and original-theorem `FAIL`. The implementation's isolated full suite recorded 1,245 passes, zero failures and 68 opt-in or environment-dependent skips.

Research started at `10:06:08.084 UTC`. The first Task was proposed after 15.508 seconds and the first Execution activated after 19.914 seconds. Four Tasks and five Executions were created over the run. One initial Bot reached the selection deadline and was replaced after cleanup. Four slots were active concurrently. A Bot called finish after publishing two Materials and was replaced in the same slot. The completion reason was `mission-accepted`, after 3,364.370 seconds of research. All six Bots closed and no owned containers or tracked merge/checker operations remained pending.

Real hosted `kimi_proxy/k3` processed 209 requests. All 23 selection requests used upstream effort `low`. All 186 work requests kept Pi effort `medium`. The 206 completed requests recorded 20,928,187 input tokens and 559,214 output tokens. Three interrupted requests remain unmetered in the local ledger.

The researchers made 98 successful Mathlib queries. Four Bots saved 35 private-directory snapshots into immutable public revisions. Judge stored 29 source-check failures and four passes. Three checked merges advanced main. The first researcher edited and saved in one active Execution, consumed the actual source diagnostics in subsequent K3 calls, and eventually reached a module pass at revision `0.16`. Whole-project merge accepted it into main `0.18`, with a placeholder in the original theorem. The same researcher later published another partial result in main `0.31`.

The first researcher used the receiver-first command to link two Materials to three peer Tasks each. All six response links succeeded and Flat recorded accepted `followUp` inputs for the respective active Executions. The six archived Pi sessions each contain one user input. No recipient's actual model request or archived user inputs contained the queued Material notifications, and no handling receipt was recorded before closure.

The submitting researcher saved a compiling proof at private-origin public revision `0.26`. Its merge initially conflicted with main `0.18`. A dirty-directory apply was rejected, and the researcher then successfully applied `0.18` in the same active Session and Execution. It resolved the conflict and saved `0.30` with parents `0.26` and `0.18`. The researcher later applied the advanced main `0.31`, saved `0.33` with parents `0.30` and `0.31`, and merged the checked tree into main `0.34`. All these operations occurred within the same submitting Execution.

The independent final checker accepted original theorem `putnam_2025_b1` from main `0.34`, commit `0ad5a5db01a049c35a292c4bcde69ffe13834309`, tree `aff00cc2da70c396cd11ae20b1f1b14ac9c0382f`, result `treecheck:afe9e61f-1e84-4be2-96c0-61e77c1cd315`. The earlier proof in `0.26` also passed a separate post-run strict verification on its own fixed tree `90fc9f68f4bd2c85d8cce1de1b09bd709eafb0a9`. The original theorem source in `0.34` is byte-identical to `0.26`. It is the only Lean file in the accepted tree. The later merge preserved a non-Lean artifact from the other researcher.

## Analysis

The new command guidance resolved the observed producer-side recipient errors. The run verified an actual publication and routing path, real Lean source save-and-check cycles, checked merges, two same-Session integrations with conflict resolution, original-theorem acceptance and cleanup. The final theorem proof was already present before the first apply. An independent audit confirmed the earlier revision also passes the strict checker. Merge ancestry and the retained non-Lean artifact establish repository integration. This run provides no source or dependency evidence that one Bot's lemma contributed to another Bot's accepted proof.

The model produced continuing tool turns from its initial user message. Native `followUp` entries are surfaced at the end of the active tool loop. This run had no recipient turn reach that point after its notifications were queued and before Mission acceptance. The original runner also uses `followUp` for ordinary notifications. Bounded work turns can create an opportunity to deliver them while retaining the same Task, Execution and Session.

## Next steps

Retain the mathematical result and rerun for the remaining proof-adoption criterion. Restore explicit work selection guidance about overlapping Tasks and independent project modules. Ask Bots to return a brief checkpoint when their immediate work unit is finished so queued inputs can enter the same Session, and continue to verify actual file and proof dependencies.
