# EXP-20261125-16 — ScaleMAS intermediate sharing

Status **OPERATOR STOP · 17m37.200s · NO PUBLICATIONS OR SUBMISSIONS** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7165261463). Comparison runs [EXP-20261125-14](EXP-20261125-scalemas-service-discovery.md) and [EXP-20261125-13](EXP-20261125-scalemas-fate-sharing.md), each truncated to the observed window for Service activity.

## Setup

Run FATE-H #2 once with four peers in shared mode. The shared Added System Prompt gives examples of contributions useful before a full proof and encourages another focused search at a new subgoal or blocker, even after an empty result. The task input and rendered Service directory match the preceding run. This run uses the corrected CLI help shipped in a different Worker image. A single comparison changes both the guidance and the help.

| Field | Frozen value |
| --- | --- |
| Implementation | `69ede68417b4dcac77f6bc5caa5e5dab3db1a265`. [Shared startup and task input](https://github.com/LuNa-shi/SwarmEnv/blob/781428d11add844a60492f5654cca7106ee4b80d/docs/architecture/prompts/09-scalemas-environment.md#fate-startup-in-the-shared-condition). |
| Package and Worker | Installed `@swarmenv/core@0.2.0` tarball SHA-256 `1528ff66583a3fc064e8d7845d638c269e2c404d3bbe2ef6f1db709b18da6da3`. Pi 1.3.0 Worker image `sha256:b82fe2e8d969b2519645226bb5c1b6f0792c856295dc04d683e4942e052109ca`. |
| Prompt SHA-256 | Staged system `26b93bd0e7620c50d3270c23be5b958366513acacefe7a630803b0d3269346b0`. Model developer text including Pi cwd `9ebdf19cc52e3625e14ed5ebd7a1ea1ac0bf0a98fb530618a5073fd430a58b83`. Added guidance `2e68c68bf332ee8866859395534b891e78fc6fa0f47176024a2018a43bd73038`. User input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`. |
| Service SHA-256 | FATE and shared substrate manifest array `d852e951370a9219ab32fe86be68e1d53c0e260e45e867b9983ba56c7b51f195`. Service, operation and input/output schema tuples `9efde09249c609fede23a63ba5c0ebf8d8441f6b99206718aba18056dbb09291`. |
| Problem and scoring | FATE-H at `17967b3118082adfba7c5a5fc03b5f4a53717b59`, declaration SHA-256 `0f264f8c2133b071ee0462f59aeed24ac6b00f4403cc3c143d4d47faaf77f417`, Lean 4.28.0, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`. Same working checker and independent scorer as the comparison runs. |
| Launch | Installed ScaleMAS entry and FATE config with a host wrapper for the 1,800,000 ms work and gateway request limits and a passive 900,000 ms checkpoint. Wrapper SHA-256 `aaff234ff2fe2f61fe95809c483c73323f52499fb83a7153c18ea7f6874b2b00`. Launcher SHA-256 `eee8236060d2116bc1b491152039237c84023e41fe4db0e326353ece59cf8d95`. |
| Model and resources | Live `kimi_proxy/k3`. Per peer CPU 1, 1 GiB memory, 128 MiB and 8,192 inodes in its work area, 100 Service operations, and up to 10 Lean trial checks. No K3 usage or fee cap. |
| Time and stop | Up to 30 minutes from all peers ready, with their ordinary earlier settlement allowed. Separate setup, cleanup and scoring limits of 180 seconds, 120 seconds and 900 seconds per candidate. |

Check the actual first request from all four peers for the expected developer text, separate task input and native tools. Count successful searches, repeat searches after an empty result, distinct accepted publications, deliveries to a different peer, and concrete downstream use in a later Lean attempt or submitted proof. Join deliveries to the recipient's actual tool response and model input. Record independent scoring, provider usage and cleanup separately.

The full handoff observation requires a voluntary publication, a second peer retrieving the content, and observable use of the contribution in proof work. A publication or visit alone establishes only that step. If the startup input is verified and this run has no full handoff, the owner also authorized one matched GPT-6.1 Sol run with the same shared configuration and work limit. That conditional run receives its own registration before launch.

## Results

The four peers entered work at 14:26:15.282 UTC. At the owner's request the host sent a normal stop at 14:43:52.475 UTC to switch models. The last peer ended at 14:43:52.482 UTC. Setup took 25.240 seconds. The 15-minute host checkpoint recorded four active peers, two successful shared searches, no publication and no candidate. The launcher exited 0. All four Session archive digests and stop receipts validated, and no containers remained under the Runtime label. Standalone regrading reproduced four `NO_SUBMISSION` verdicts.

All four first requests contained the exact developer text, separate user input and four native tools. All 87 requests retained the expected developer text. The ledger recorded 83 completed requests with known usage of 2,068,309 input and 167,267 output tokens. Four streams ended during cancellation with usage unknown.

| First 17m37.200s | EXP-20261125-13 | EXP-20261125-14 | EXP-20261125-16 |
| --- | ---: | ---: | ---: |
| Successful shared searches | 8 | 4 | 2 |
| Repeat searches after empty results | 4 | 0 | 0 |
| Publications | 1 | 0 | 0 |
| Cross-peer deliveries / observed proof use | 0 / 0 | 0 / 0 | 0 / 0 |
| Successful Mathlib searches | 177 | 142 | 242 |
| Working Lean checks returning verdicts | 10 | 0 | 0 |
| Accepted submission calls | 0 | 0 | 0 |

The two successful shared searches came from different peers at 0m24.175s and 7m13.779s. Both returned an empty library. Two peers omitted the required `limit` field on their initial attempts, and one of them later succeeded after reading help. The old literal `--field` error did not recur. No archive had a publish or visit command.

## Analysis

The actual startup input and approved Service contract reached the model. The observed K3 window shows no improvement in publication, repeat retrieval or use. The only successful shared operations returned empty results. Mathlib lookup dominated activity, and the traces contained no Lean checks or submissions before stop. The prompts and CLI help changed together relative to EXP-20261125-14. Behavior after the earlier stop is unobserved.

## Next steps

The owner requested the GPT comparison before the 30-minute K3 deadline. The corrected installed entry ran the GPT comparison under a separate registration. [EXP-20261125-18](EXP-20261125-18-scalemas-gpt-30min.md)
