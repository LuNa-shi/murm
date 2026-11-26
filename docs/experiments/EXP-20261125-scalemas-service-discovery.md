# EXP-20261125-14 — ScaleMAS automatic Service discovery

Status **OPERATOR STOP · 35m08.495s · NO PUBLICATIONS OR SUBMISSIONS**. One shared FATE-H run authorized in [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7163618408). Comparison run [EXP-20261125-13](EXP-20261125-scalemas-fate-sharing.md). Implementation [PR #215](https://github.com/LuNa-shi/SwarmEnv/pull/215) and default design [PR #218](https://github.com/LuNa-shi/SwarmEnv/pull/218).

## Setup

| Field | Frozen value |
| --- | --- |
| Condition | One shared run named `exp-20261125-14-shared`, with four independent peers and one original theorem. |
| Implementation | `c3425b4a819d056658f4e2b13ff61b1c60b68bac`. The native startup prompt now includes a directory generated from registered manifests and Profile grants. Two sentences of ScaleMAS guidance remain in Added System Prompt. See [rendered shared prompt and separate user input](https://github.com/LuNa-shi/SwarmEnv/blob/781428d11add844a60492f5654cca7106ee4b80d/docs/architecture/prompts/09-scalemas-environment.md#fate-startup-in-the-shared-condition). |
| Prompt SHA-256 | Staged system `4dace7fd42576be98b222bccd87cc43980d085edc17cd08f07ca9c37472b1686`. Expected model developer text with Pi cwd `f2ee3defe650faf253cb5ec92cd0784f515ba85267d51bc87f411f17e70c0926`. Added guidance `c9b0859e800cd22f1c08fd47569cbf94e24f25c6e1993b9f93fee38ed4881407`. User input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`, byte-identical to the comparison run. |
| Service contract SHA-256 | JSON array of FATE and shared substrate manifests `908cb0b91861139f7f4e7dab414d79d10bc31b9904311615e23559c5dc56c85c`. JSON array of service ID, operation ID, input schema and output schema tuples `9efde09249c609fede23a63ba5c0ebf8d8441f6b99206718aba18056dbb09291`. |
| Package and Worker | Installed `@swarmenv/core@0.2.0` tarball SHA-256 `a2f4462ef0efb99c8b9572aadc717f38bb79ac77fdca44e8c7bcb87c2eb8c647`. Same Worker and Pi 1.3.0 as comparison, image `sha256:85153578f60ba7ff4bd8cc0681a76dc68f57adebf6318f1fb8d8b79e76dfb922`. |
| Problem and scoring | FATE-H ID 2 at `17967b3118082adfba7c5a5fc03b5f4a53717b59`, declaration SHA-256 `0f264f8c2133b071ee0462f59aeed24ac6b00f4403cc3c143d4d47faaf77f417`, Lean 4.28.0, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`, the same working and independent scoring contracts. |
| Launch and resources | Installed `examples/scalemas-environment/main.js` with installed `fate-config.js`. Live `kimi_proxy/k3` on the previous route, without a K3 request, token or cost ceiling. Per peer 100 Service operations, 10 working Lean checks, CPU 1, 1 GiB memory and 128 MiB / 8,192 inode private work area. |
| Time and stop | Up to 45 minutes from all peers ready, with a 30-minute passive host checkpoint. A peer may settle earlier through the ordinary lifecycle. Setup, close and scoring are timed separately, with respective limits of 180 seconds, 120 seconds, and 900 seconds per candidate. |

Verify that the first gateway request from each peer carries the exact startup directory and separate task input. Record named Service calls, publication and cross-peer delivery times, and adoption in a later Lean attempt or final proof. Count independently passing final candidates and team Pass@4, provider usage, and confirmed resource cleanup. The comparison changes startup presentation and the length of the added guidance together. Each condition covers a single natural run.

## Results

The run entered work at 13:28:58.942 UTC. The owner requested stop at 14:04:07.428 UTC, and all four peers ended by 14:04:07.437 UTC. Setup took 24.137 s and total wall time was 35m34.151s. The CLI exited 0 after saving the result. All four stop and Session archive receipts passed validation, and the Runtime label matched zero remaining containers. Standalone regrading reproduced four `NO_SUBMISSION` verdicts. No proof entered independent Lean grading.

All 77 gateway requests carried the pinned developer text. The first request from each peer also carried the original user input as a separate message and the four native tools. Seventy-three model requests completed with known usage of 2,765,070 input and 279,476 output tokens. Four streams ended during operator stop with unknown usage.

| Observation | EXP-20261125-13 | EXP-20261125-14 |
| --- | ---: | ---: |
| Work observed | 45:00.010 | 35:08.495, operator stop |
| Successful substrate searches | 8, all empty | 4, all empty |
| First publication | 17:29.586 | None through stop |
| Publications / visits | 2 / 0 | 0 / 0 |
| Successful Mathlib searches | 218 | 235 |
| Cross-peer deliveries / verified adoption | 0 / 0 | 0 / 0 |
| Final submissions / independently passing proofs | 3 / 2 | 0 / 0 through stop |

The 30-minute passive checkpoint found four peers active, 219 successful Mathlib searches, zero Lean checks, zero publications and zero submissions. At shutdown the Bridge trace showed four successful substrate searches and one rejected search. The substrate database independently recorded four searches, zero messages and zero references. The archive has zero publish or visit commands, including unsuccessful attempts. Each successful search happened at the opening. The last started at 2:55.410, leaving 32m13s of observed work with zero further substrate calls.

| Peer ID prefix | First successful substrate search | Mathlib searches | Evidence from the Session or model trace |
| --- | ---: | ---: | --- |
| `8c2b9dba` | 0:27.021 | 53 | Took the help placeholder `--field` literally for both searches, then recovered using JSON stdin. Later spent about 8.5 minutes on one generation. |
| `dc33b4aa` | 1:22.688 | 87 | Passed JSON as an `--input` filename, then recovered using stdin. Later explicitly distinguished substrate visits from Mathlib address lookups. Its last generation was active for about 8 minutes at stop. |
| `06366f55` | 1:35.009 | 49 | Explicitly planned to check substrate and then Mathlib. Recovered from two schema denials caused by the literal `--field`. One later generation ran for about 9 minutes. |
| `be1c0a17` | 2:55.410 | 46 | Explicitly looked for another agent's publication, then used the correct command after a positional-argument error. One later generation ran for about 11 minutes. |

The 235 successful Mathlib calls covered 206 distinct normalized queries, with 23 queries repeated across peers. Forty-four Mathlib declarations were returned to all four peers. All four Sessions explored the Sylow-counting route, with zero file edits, working Lean checks or final submissions recorded before stop.

## Analysis

The catalog reached every model request and each peer used the correct shared search at least once. The peer who discussed both address types explicitly chose the appropriate Service. This demonstrates discovery and successful reading of an empty scope. The first break in this run was contribution creation through the shared interface. With zero publication requests, the run supplied no opportunity to observe retrieval of a peer contribution or its use in a proof. The effective work path was four parallel individual searches and proof attempts. A separate controlled native test previously verified that the FATE substrate can deliver a published artifact to a second Agent after the publisher exits, and that the second Agent can cite and submit a proof using it. [Controlled handoff](EXP-20261125-scalemas-fate.md#results)

The first few minutes exposed a concrete help issue. The example syntax showed a literal-looking `--field` placeholder, which two peers copied into four rejected calls. Two other command-form errors occurred before the Bridge. Every peer recovered and reached an empty shared scope. Later traces show sustained independent Mathlib exploration, often with several minutes inside one generation. There was no subsequent shared search and no publication attempt. The effect of the early help errors on publication remains unknown.

The previous run with the longer collaboration guidance published an outline after a peer exhausted its working checks, and a proof summary after a different peer passed a working check. This run never issued a working check. The shorter wording leaves the meaning of a reusable intermediate result to the agent, including whether an unverified lemma application or failed branch is worth publishing. That is a plausible friction point alongside the long local reasoning intervals. Its effect remains unmeasured. In the previous run the first break after publication was retrieval, since every shared search preceded the first contribution.

The intervention combines the catalog with shorter guidance, and this observation ended earlier than the comparison. The results establish the recorded behavior through the operator stop. Behavior in the remaining time and the effect on paper-level performance remain unobserved.

## Next steps

Keep the publication, other-peer delivery and downstream-use checks as separate evidence requirements. The old CLI help was corrected in `2ed6b41900b990408a78039f94f8111617ef4713` after the observed run had started. The new locally built Worker was checked with a controlled authenticated Service, including actual help output, a working search command, and denied access to an ungranted operation. Use this follow-up as engineering evidence for the help change.
