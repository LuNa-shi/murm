# EXP-20261125-18 — ScaleMAS 30-minute GPT-6.1 Sol run

Status **SETTLED · 5m24.177s · 4 PROOFS PASSED · 5 PUBLICATIONS · NO CROSS-PEER READS** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7165860299). Follows the [startup attempt](EXP-20261125-17-scalemas-gpt-comparison.md) and compares with the [observed K3 run](EXP-20261125-16-scalemas-intermediate-sharing.md).

## Setup

Run the same FATE-H #2 with four peers in shared mode. The owner requested switching from K3 to GPT-6.1 Sol. The prior GPT startup attempt allocated no Runtime and made no model request. This revision admits the exact approved GPT pair through the installed example. The shipped configuration still selects K3. The installed Runtime, FATE driver, Worker backend, startup renderer, Bridge, FATE services, substrate and checker modules used by the run were checked against the K3 package. Their compiled bytes match in the compared modules. [K3 setup and inherited frozen values](EXP-20261125-16-scalemas-intermediate-sharing.md#setup)

| Field | Frozen value |
| --- | --- |
| Implementation | `c468ce034b2747ee9fe934f0affa4a11476f4a5c`. Installed `@swarmenv/core@0.2.0` tarball SHA-256 `453a6b3308e35c1de6b9ec844c011531f2932e58dc1a7299edaee73be2e787ab`. |
| Model | Live `gpt_proxy/gpt-6.1-sol` via its configured Responses provider route. The authenticated model catalog listed the exact model. |
| Prompt SHA-256 | Model developer text `9ebdf19cc52e3625e14ed5ebd7a1ea1ac0bf0a98fb530618a5073fd430a58b83` and separate user input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`, both identical to the K3 run. |
| Launch | Launcher SHA-256 `800e17e49d9d0d3a2866c601ca63b4777f1939ccfaa2c67ae78e028fa5fe6e30`. GPT configuration SHA-256 `e15b7e3e02401a0dde01da655e219dcff917e39a56a4fc0dbf788ae4d2077ff0`. Inherited 30-minute wrapper SHA-256 `aaff234ff2fe2f61fe95809c483c73323f52499fb83a7153c18ea7f6874b2b00`. |
| Time and stop | Same 1,800-second work limit from readiness, passive 900-second checkpoint, ordinary earlier peer settlement and separate setup, scoring and cleanup bounds. |

Check all first requests and the actual provider response. Compare the first 17m37.200s with the K3 run and report the rest of the GPT interval separately. Record successful shared searches, repeat searches after an empty result, distinct publication receipts, cross-peer deliveries and substantive downstream use. An adoption claim requires the delivery evidence, the recipient's model context and the later proof work, with independent scoring reported separately. The selected model and its provider route differ. There is one observed group per model.

## Results

The four GPT peers entered work at 14:49:42.622 UTC and all ended by submission at 14:55:06.799 UTC, after 5m24.177s of work. Setup took 25.178 seconds. Since every peer finished before 15 minutes, the scheduled checkpoint remained `not_reached`. Each of the four distinct frozen proofs passed the independent Lean scorer and passed again on standalone regrading. The launcher exited 0, all four Session archives and stop receipts validated, and the Runtime label matched zero remaining containers.

The first requests from all eight peers in the two runs had byte-identical developer and user text, identical native tool definitions and `medium` reasoning effort. All 109 GPT gateway requests retained the pinned developer text. The provider returned 105 completed responses identifying `gpt-6.1-sol`, with known usage of 2,226,315 input and 21,062 output tokens. Four requests had transport interruptions and unknown usage. Provider token accounting may differ between the routes.

| Measure | K3 at 5m24.177s | K3 at operator stop, 17m37.200s | GPT at natural end, 5m24.177s |
| --- | ---: | ---: | ---: |
| Successful shared searches | 1 | 2 | 10 |
| Peers with a successful shared search | 1 | 2 | 4 |
| Repeat searches after empty results | 0 | 0 | 6 |
| Distinct accepted publications / publishers | 0 / 0 | 0 / 0 | 5 / 4 |
| Cross-peer deliveries / observed proof use | 0 / 0 | 0 / 0 | 0 / 0 |
| Successful Mathlib searches | 76 | 242 | 178 |
| Working Lean checks returning verdicts / passes | 0 / 0 | 0 / 0 | 33 / 4 |
| Final submissions / passing proofs | 0 / 0 | 0 / 0 | 4 / 4 |

All four GPT peers sent their first successful shared search within 8.239 seconds and their second before 1m04s. All ten searches returned empty results. The last one settled at 2m44.215s, 38.912 seconds before the first publication settled at 3m23.127s. Service and archive records show zero search or visit attempts after that first publication. The other peers still issued 29 successful FATE task calls and 19 model requests after it. The persistent library contained five messages and zero references. Four GPT Mathlib calls were rejected at input validation and the peers continued using the Service.

One peer published a counting approach at 4m05.644s, 66.838 seconds before its own successful working check. Four publications followed their authors' own successful checks, and each author ended by submitting a passing proof. Three peers had independently tried the transfer route in Lean before the first publication. The three eventual transfer proofs came from those separate attempts.

## Analysis

This GPT group used the mechanism more than the K3 group over the matched observation, including repeat searches and voluntary intermediate publication. The developer and task inputs, tool definitions, Worker, Service behavior and checker were held fixed. The difference is evidence that the model and provider configuration matter here. The observed proof success arose from independent work because every shared search preceded publication. The timing failure from the earlier K3 run with publications recurred: contributions began after the last retrieval.

The observations cover one question and one group per model. K3 was stopped by the owner at 17m37.200s, and GPT finished normally before the configured 30-minute deadline. This comparison establishes more observed tool use and stronger independent proof outcomes for the GPT group. The cross-peer adoption observation remained zero in both groups.

## Next steps

This run completes the requested model comparison. The open collaboration observation remains a peer reading a live contribution and using it in later proof work.
