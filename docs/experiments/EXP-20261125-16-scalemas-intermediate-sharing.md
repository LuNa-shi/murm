# EXP-20261125-16 — ScaleMAS intermediate sharing

Status **REGISTERED** under [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202). Comparison runs [EXP-20261125-14](EXP-20261125-scalemas-service-discovery.md) and [EXP-20261125-13](EXP-20261125-scalemas-fate-sharing.md), each truncated to its first 30 minutes for Service activity.

## Setup

Run FATE-H #2 once with four peers in shared mode. The shared Added System Prompt gives examples of contributions useful before a full proof and encourages another focused search at a new subgoal or blocker, even after an empty result. The task input and rendered Service directory match the preceding run. This run uses the corrected CLI help shipped in a different Worker image. A single comparison changes both the guidance and the help.

| Field | Frozen value |
| --- | --- |
| Implementation | `69ede68417b4dcac77f6bc5caa5e5dab3db1a265`. [Shared startup and task input](../architecture/prompts/09-scalemas-environment.md#fate-startup-in-the-shared-condition). |
| Package and Worker | Installed `@swarmenv/core@0.2.0` tarball SHA-256 `1528ff66583a3fc064e8d7845d638c269e2c404d3bbe2ef6f1db709b18da6da3`. Pi 1.3.0 Worker image `sha256:b82fe2e8d969b2519645226bb5c1b6f0792c856295dc04d683e4942e052109ca`. |
| Prompt SHA-256 | Staged system `26b93bd0e7620c50d3270c23be5b958366513acacefe7a630803b0d3269346b0`. Model developer text including Pi cwd `9ebdf19cc52e3625e14ed5ebd7a1ea1ac0bf0a98fb530618a5073fd430a58b83`. Added guidance `2e68c68bf332ee8866859395534b891e78fc6fa0f47176024a2018a43bd73038`. User input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`. |
| Service SHA-256 | FATE and shared substrate manifest array `d852e951370a9219ab32fe86be68e1d53c0e260e45e867b9983ba56c7b51f195`. Service, operation and input/output schema tuples `9efde09249c609fede23a63ba5c0ebf8d8441f6b99206718aba18056dbb09291`. |
| Problem and scoring | FATE-H at `17967b3118082adfba7c5a5fc03b5f4a53717b59`, declaration SHA-256 `0f264f8c2133b071ee0462f59aeed24ac6b00f4403cc3c143d4d47faaf77f417`, Lean 4.28.0, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`. Same working checker and independent scorer as the comparison runs. |
| Launch | Installed ScaleMAS entry and FATE config with a host wrapper for the 1,800,000 ms work and gateway request limits and a passive 900,000 ms checkpoint. Wrapper SHA-256 `aaff234ff2fe2f61fe95809c483c73323f52499fb83a7153c18ea7f6874b2b00`. Launcher SHA-256 `eee8236060d2116bc1b491152039237c84023e41fe4db0e326353ece59cf8d95`. |
| Model and resources | Live `kimi_proxy/k3`. Per peer CPU 1, 1 GiB memory, 128 MiB and 8,192 inodes in its work area, 100 Service operations, and up to 10 Lean trial checks. No K3 usage or fee cap. |
| Time and stop | Up to 30 minutes from all peers ready, with their ordinary earlier settlement allowed. Separate setup, cleanup and scoring limits of 180 seconds, 120 seconds and 900 seconds per candidate. |

Check the actual first request from all four peers for the expected developer text, separate task input and native tools. Count successful searches, repeat searches after an empty result, distinct accepted publications, deliveries to a different peer, and concrete downstream use in a later Lean attempt or submitted proof. Join deliveries to the recipient's actual tool response and model input. Record independent scoring, provider usage and cleanup separately.

The full handoff observation requires a voluntary publication, a second peer retrieving the content, and observable use of the contribution in proof work. A publication or visit alone establishes only that step. If the startup input is verified and this run has no full handoff, the owner also authorized one matched GPT-6.1 Sol run with the same shared configuration and work limit. That conditional run receives its own registration before launch.
