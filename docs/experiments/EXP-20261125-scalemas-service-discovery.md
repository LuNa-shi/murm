# EXP-20261125-14 — ScaleMAS automatic Service discovery

Status **REGISTERED**. One shared FATE-H run authorized in [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7163618408). Comparison run [EXP-20261125-13](EXP-20261125-scalemas-fate-sharing.md). Implementation [PR #215](https://github.com/LuNa-shi/SwarmEnv/pull/215) and default design [PR #218](https://github.com/LuNa-shi/SwarmEnv/pull/218).

## Setup

| Field | Frozen value |
| --- | --- |
| Condition | One shared run named `exp-20261125-14-shared`, with four independent peers and one original theorem. |
| Implementation | `c3425b4a819d056658f4e2b13ff61b1c60b68bac`. The native startup prompt now includes a directory generated from registered manifests and Profile grants. Two sentences of ScaleMAS guidance remain in Added System Prompt. See [rendered shared prompt and separate user input](../architecture/prompts/09-scalemas-environment.md#fate-startup-in-the-shared-condition). |
| Prompt SHA-256 | Staged system `4dace7fd42576be98b222bccd87cc43980d085edc17cd08f07ca9c37472b1686`. Expected model developer text with Pi cwd `f2ee3defe650faf253cb5ec92cd0784f515ba85267d51bc87f411f17e70c0926`. Added guidance `c9b0859e800cd22f1c08fd47569cbf94e24f25c6e1993b9f93fee38ed4881407`. User input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`, byte-identical to the comparison run. |
| Service contract SHA-256 | JSON array of FATE and shared substrate manifests `908cb0b91861139f7f4e7dab414d79d10bc31b9904311615e23559c5dc56c85c`. JSON array of service ID, operation ID, input schema and output schema tuples `9efde09249c609fede23a63ba5c0ebf8d8441f6b99206718aba18056dbb09291`. |
| Package and Worker | Installed `@swarmenv/core@0.2.0` tarball SHA-256 `a2f4462ef0efb99c8b9572aadc717f38bb79ac77fdca44e8c7bcb87c2eb8c647`. Same Worker and Pi 1.3.0 as comparison, image `sha256:85153578f60ba7ff4bd8cc0681a76dc68f57adebf6318f1fb8d8b79e76dfb922`. |
| Problem and scoring | FATE-H ID 2 at `17967b3118082adfba7c5a5fc03b5f4a53717b59`, declaration SHA-256 `0f264f8c2133b071ee0462f59aeed24ac6b00f4403cc3c143d4d47faaf77f417`, Lean 4.28.0, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`, the same working and independent scoring contracts. |
| Launch and resources | Installed `examples/scalemas-environment/main.js` with installed `fate-config.js`. Live `kimi_proxy/k3` on the previous route, without a K3 request, token or cost ceiling. Per peer 100 Service operations, 10 working Lean checks, CPU 1, 1 GiB memory and 128 MiB / 8,192 inode private work area. |
| Time and stop | Up to 45 minutes from all peers ready, with a 30-minute passive host checkpoint. A peer may settle earlier through the ordinary lifecycle. Setup, close and scoring are timed separately, with respective limits of 180 seconds, 120 seconds, and 900 seconds per candidate. |

Verify that the first gateway request from each peer carries the exact startup directory and separate task input. Record named Service calls, publication and cross-peer delivery times, and adoption in a later Lean attempt or final proof. Count independently passing final candidates and team Pass@4, provider usage, and confirmed resource cleanup. The comparison changes startup presentation and the length of the added guidance together. Each condition covers a single natural run.

## Results

Pending execution.

## Analysis

Pending execution.

## Next steps

Run the registered shared group and publish the observed results on Issue #202.
