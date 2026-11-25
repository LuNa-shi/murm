# ScaleMAS FATE-H long-window run

Status **REGISTERED**. The owner approved one harder original problem, three groups of four K3 peers, a 45-minute work limit per group, a 30-minute observation, and no K3 usage ceiling. [Issue #202 approval](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7156832433) · [Design #214](https://github.com/LuNa-shi/SwarmEnv/pull/214) · [Implementation #215](https://github.com/LuNa-shi/SwarmEnv/pull/215)

## Setup

| ID | Condition | Independent Runtime run name | Comparison |
|---|---|---|---|
| `EXP-20261125-10` | Shared library | `exp-20261125-10-12-shared` | `EXP-20261125-07` |
| `EXP-20261125-11` | One library per peer | `exp-20261125-10-12-private` | `EXP-20261125-08` |
| `EXP-20261125-12` | No library | `exp-20261125-10-12-none` | `EXP-20261125-09` |

| Item | Fixed value |
|---|---|
| Implementation | `e00f8c4f2fc7103aca3cbc31aadc1c0ef1740fb5`. [Runtime and checker](../architecture/19-scalemas-environment.md) |
| Installed package and worker | `@swarmenv/core@0.2.0` archive SHA-256 `ed1df463cc4fab6ad171d4d3a5f76670dfc4b64a925c7e081323fc5abedcc8d6`. Pi/OpenSandbox image `sha256:85153578f60ba7ff4bd8cc0681a76dc68f57adebf6318f1fb8d8b79e76dfb922`. |
| Original problem | FATE-H commit `17967b3118082adfba7c5a5fc03b5f4a53717b59`, ID 2. Dataset SHA-256 `21fb5ab61c037858a3b267509d492a98194eb996581662e5e7d2ed461bfead90`, original declaration SHA-256 `0f264f8c2133b071ee0462f59aeed24ac6b00f4403cc3c143d4d47faaf77f417`. [Pinned fixture](https://raw.githubusercontent.com/frenzymath/FATE-H/17967b3118082adfba7c5a5fc03b5f4a53717b59/FATE-H.json#L14) |
| Independent checker | Lean 4.28.0 build `7e01a1bf5c70fc6167d49c345d3bf80596e9a79b`, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`, manifest SHA-256 `ceef049390de26dee9aa9502397d18cc8442dbe067c3c3f30880323459c47c59`. |
| Model | Live `kimi_proxy/k3` through Core, worker model catalog SHA-256 `2495571b7ce4d3193fc851fc143f277e850bf184fbade4c614b1b3225de6f20a`. One run per condition, with no fixed upstream seed or K3 request, token or cost ceiling. |
| Prompt SHA-256 | Peer profile `b3622ddf54fe32c48b1932b2d495b4f9deb0984b9a9a2d44e4c3b4386c27bc79`, common input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`, shared and private library instructions `d70ebf21dbef69765dda3798444a3ee27e1697e2c2aed4a5ff517281a56be2e8`. |
| Config and schema source SHA-256 | Default launch config `425c5c6037c10ae708806ab7a4e743c19a05142cbdb96b647d92fdae9747d2bd`, task Service `d7aa233cb183bb8b4a5c1dba97e92c840981db500c3126259dea1e05de8215bc`, library Service `4afc9653760d6691ca23570a94290065022cebf5feda30173e5169e9d9666b54`. |
| Entry point | Installed `examples/scalemas-environment/main.js --fate-matrix`, installed `fate-config.js`, and `SWARMENV_FATE_BENCHMARK=FATE-H`. Fresh Runtimes in shared, private, none order. |
| Work and stop | All four peers must be ready before work starts. Agents finish through ordinary submission and termination, or at the 2,700-second cutoff. The host attempts a passive observation at work second 1,800 if any peer is still working. Setup and Core close have separate limits of 180 and 120 seconds, and independent scoring has up to 900 seconds per candidate. A cleanup-pending result blocks the next condition. |
| Observation and scoring | Record work durations, activity at the observation, final submissions, model usage, tool and library activity, and cleanup. Score every frozen final candidate in a fresh Lean context and set team Pass@4 to 1 if any passes. Verify any cross-peer adoption through exact publication, read, and a later product that uses the material. |
| Evidence | Raw observations, candidate proof bytes, Service and model ledgers, archive receipts, and standalone regrades are kept in the ignored experiment directory. |

## Results

Pending launch.

## Analysis

Pending settlement.

## Next steps

Execute the registered matrix and independently regrade the final submissions.
