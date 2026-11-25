# EXP-20261125-20 — ScaleMAS FATE-X with verified completion

Status **SETTLED · 30m · 0 PROOFS PASSED · VERIFIED REUSE IN A PROOF DRAFT** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7167462274). Comparison run [EXP-20261125-19](EXP-20261125-19-scalemas-fatex-31.md) used the same original problem and four GPT-6.1 Sol peers. All four ended on rejected proofs after 1m23.436s. The owner retained the 30-minute limit and requested an explicit initial instruction to work until the proof passes.

## Setup

One four-peer shared run on [FATE-X #31](https://github.com/frenzymath/FATE-X/blob/a6fb49ee85fd05bb8ce9fc66e1c66797b5a0592d/FATE-X.json), retaining the frozen dataset, Lean 4.28.0, Mathlib and independent grader from the comparison. Problem SHA-256 is `94d8113d56cbd9162371e02610bbe343c20831c59e4c1f9031a271eb30ad46e7`. The Worker's Pi 1.3.0 image is `sha256:b82fe2e8d969b2519645226bb5c1b6f0792c856295dc04d683e4942e052109ca`. The live model and Responses route are `gpt_proxy/gpt-6.1-sol`. The shared library, collaboration guidance, task statement, file isolation and resources match the comparison. Each peer chooses its own mathematical route, searches, publications and use of contributions.

| Field | Frozen value |
| --- | --- |
| Implementation | `2a3ed11ccaa89726d70e282f9aaf543652dc9e83`. Installed archive SHA-256 `d8f692c63e556fb3b9a5f2e8ba46a08d72e22908f23b3cfd397bb4212eb083e1`. |
| Completion | `fate.verifiedCompletion: true`. Each peer is told to keep working until it submits the exact Lean-passing proof or the work window expires. Failed or absent prior checks do not authorize an early finish. A known unfinished natural reply receives a continuation in the same Session. The host independently grades final submissions. |
| Window | 1,800 seconds starting after all peers are ready, with a passive checkpoint at 900 seconds. Time-only model permission, 100 Service operations and ten working Lean checks per peer. Setup, cleanup and independent scoring are bounded separately. |
| Prompt SHA-256 | System `5d568e240bf664819de63123cbeb371c64ff1eed5621b40df7eb034e6efbc039`, model developer `940bbca11c6b0fbeddcb568bad0b9727554714561e597e1a79edf25c913e3190`, user `cd1534260397a4ecfa9f41f5eb18085016bf43d6e2b0de793445eb784171e24f`, continuation `257fc7f3681b95d17e8ff185d87f43673676078bc6cd3d22fa9a45398f3fb4c0`. [Full task input and composition](../architecture/prompts/09-scalemas-environment.md#fate-initial-input-with-verified-completion-and-a-30-minute-work-window) |
| Service SHA-256 | Manifests `fa87e816dbc95c487b0d0f5231b772e1f1068e1f00adc7a49ce1d9de7505db4b`, input and output schemas `9efde09249c609fede23a63ba5c0ebf8d8441f6b99206718aba18056dbb09291`. |
| Launcher SHA-256 | `c3126af97de6e70043cf444153cad893b7f6d5c863421634cfc58b6fe6b52616`. GPT wrapper `4cef7547ddee553ef3b0911410d0b2a1a9df76e42496e356dd827fe9e761f15c`, time wrapper `aaff234ff2fe2f61fe95809c483c73323f52499fb83a7153c18ea7f6874b2b00`. |

Verify the full initial task and developer text in all four live provider requests. Audit each accepted finish against that peer’s earlier working check and the submitted digest. Report working time, continuation and end reasons, check and operation limits reached, actual final verdicts and standalone regrade. Audit shared publications, exact cross-peer delivery and substantive use in later proof work separately. Observed differences concern a changed completion policy and prompt in two individual runs.

## Results

Work started at 15:58:47.755 UTC on November 25. Every peer ended at the work deadline, between 30m00.000s and 30m00.006s after the common start. Setup took 24.505 seconds. The 15-minute checkpoint recorded four active peers, four drafts, 33 contributions and 89–100 Service operations used per peer. The four frozen candidates came from eight accepted draft submissions. No peer received a passing working check or submitted an accepted finish. The independent score and standalone regrade both rejected all four final drafts with `LEAN_REJECTED`. All four Session archives validated, and the launcher exited 0 with complete cleanup and zero remaining containers for the Runtime.

The live first requests from all four peers matched the pinned developer and user messages byte for byte. The provider returned 416 completed responses identifying `gpt-6.1-sol` from 418 gateway requests. The two incomplete streams had unknown usage. Known provider usage was 24,807,099 input tokens and 101,003 output tokens.

| Observed measure | Prior same task | Verified completion |
| --- | ---: | ---: |
| Work duration | 1m23.436s | 30m00.006s |
| Successful shared searches / visits | 7 / 0 | 35 / 4 |
| Distinct publications / publishers | 2 / 2 | 35 / 4 |
| Cross-peer hits, including repeated reads | 1 | 147 |
| Distinct reader–contribution pairs from other peers | 1 | 66 |
| Mathlib searches | 38 | 271 |
| Working Lean verdicts / passes | 5 / 0 | 39 / 0 |
| Frozen candidate submissions / independent passes | 4 / 0 | 4 / 0 |

At 7m12.377s, one peer published a Lean block for irreducibility of the transformed quadric. A different peer searched for it at 7m36.164s and retrieved it by address at 8m10.824s. The search receipt, Session tool result and successful next model request record the exact contribution. The recipient’s earlier working checks contained none of the 23 artifact lines of at least 35 characters. Its subsequent checks and final frozen draft included 22 of those lines after removing whitespace. It combined the block with its own coordinate change to establish the domain step. The working check on the resulting domain draft left the unique factorization step unresolved. The recipient published its combined work and cited the source in its final draft. In total, four accepted publications and five accepted drafts cited another peer’s contribution. Three of the four frozen drafts retained such a citation.

Two peers exhausted the 100-operation allowance and three reached ten working Lean trials. The two peers that naturally settled before the deadline received 172 and one continuations respectively. The larger count came from repeated reports that the operation allowance was exhausted and further checking was unavailable. Two other peers issued successful Bash wait commands totaling about ten and 12 minutes 40 seconds respectively, measured from their archived tool calls and results. The full 30-minute window includes such waits and repeated responses. It does not measure 30 minutes of active proof construction.

The four focused Service and installed Worker tests passed. The controlled Worker showed the initial time and finish instructions, continued in the same Session after a known unfinished reply, checked the exact proof, accepted its finish and independently graded it as passing. The full `npm test` suite had 1,234 passes, 67 skips and zero failures. Architecture generation and checking, whitespace checks and both review axes completed successfully.

## Analysis

This run establishes substantial adoption of another peer’s Lean work in an independently graded draft, with a trace from publication to delivery, working checks and candidate assembly. The team still had no passing solution. The earlier run ended on rejected proofs. Under verified completion, all four stayed eligible through the deadline and made more attempts, with observable reuse in an unfinished proof. The instruction and exit policy changed together between two single runs. The data do not isolate either change’s effect.

The persistence rule also continued a peer after it had no Service operations left. This increased model work without reopening its checker or enabling a valid finish. The operation and check limits, intentional waits and time cap bound what the run establishes about sustained theorem proving.

## Next steps

The requested rerun, standalone regrading and cleanup are complete. The strongest observed collaboration outcome is reuse in the domain portion of a rejected final draft.
