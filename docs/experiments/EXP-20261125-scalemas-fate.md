# ScaleMAS one-problem FATE-M acceptance

Status **REGISTERED**. The owner authorized K3, one original problem, four peers, and no K3 usage ceiling. Each of the three conditions runs once. [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202) · [Phase design review](https://github.com/LuNa-shi/SwarmEnv/pull/214)

## Setup

| ID | Condition | Independent Runtime run ID |
|---|---|---|
| `EXP-20261125-07` | Shared library | `exp-20261125-07-09-shared` |
| `EXP-20261125-08` | One library per peer | `exp-20261125-07-09-private` |
| `EXP-20261125-09` | No library | `exp-20261125-07-09-none` |

| Item | Fixed value |
|---|---|
| Implementation | `c1a348020629b93f0c7c3524c5f227b8e4843730` on the `68eb83e` main baseline. Runtime behavior and evidence paths are described in [Architecture](../architecture/19-scalemas-environment.md). |
| Installed package and worker | `@swarmenv/core@0.2.0` archive SHA-256 `bf4951cd8eb01d50b10a06e237ff904cccde4d1c0d8476a328e709b202a56c48`. Pi/OpenSandbox image `sha256:b303d55321e08f54b10d8d332e02e4b1632f18ee0a60dada407dea1ed85bbc01`. |
| Original problem | FATE-M commit `4eb33c8ccd0ff058b461cd763cc406509129743f`, ID 1, `prod_card_eq_card_pow`. Dataset SHA-256 `39c13a39f82bb2f39fc42d0a0efb41c6b0ef16b8194c8c8e0ae281c5cf0276fb`, original declaration SHA-256 `02eeacdb337b721238dc9171e5bcfb247cf7f0279536c6088ff6d6084236e032`. [Pinned fixture](https://github.com/frenzymath/FATE-M/blob/4eb33c8ccd0ff058b461cd763cc406509129743f/FATE-M.json) |
| Independent checker | Lean 4.28.0 build `7e01a1bf5c70fc6167d49c345d3bf80596e9a79b`, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`, Lake manifest SHA-256 `e6efb741f70db112585a49e84e3d04272a6dcf22549b97af072e0c90b08082b0`. |
| Model | Live `kimi_proxy/k3` through Core. Worker model catalog SHA-256 `2495571b7ce4d3193fc851fc143f277e850bf184fbade4c614b1b3225de6f20a`. No fixed upstream seed is supplied. |
| Prompt SHA-256 | Peer profile text `bc37798eae1b901c52498c637a659bbbc53b14340dc1bdec4686c8635964f17a`, common input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`, library instructions present in shared and private only `d70ebf21dbef69765dda3798444a3ee27e1697e2c2aed4a5ff517281a56be2e8`. |
| Config and schema source SHA-256 | Profile and launch config `be6b307ca80a1fb7b0b2c8756514fe30d864a77e63c639b3fc930960afc2bf0c`, task Service schemas `59dc6db02319f37eda4d269b7d110cbbd8d5d10c7f36375a9eb2beedb4ae20ab`, library Service schemas `4afc9653760d6691ca23570a94290065022cebf5feda30173e5169e9d9666b54`. |
| Entry point and order | Installed `examples/scalemas-environment/main.js --fate-matrix` with the installed `fate-config.js`; shared, private and none in order, fresh Runtime and four peers each. |
| Time and stop | Work starts when all four peers are ready and ends on peer termination or after 1,800 seconds. Setup is bounded at 180 seconds, Core close at 120 seconds, and each frozen candidate score at 900 seconds. The matrix stops before starting another group if cleanup is pending. No K3 request, token or cost ceiling. |
| Observations | Record live model use, accepted final submissions, independent Lean verdicts, exact cross-peer reuse if it occurs, timing, and cleanup. A team scores 1 when any frozen final candidate passes. This matrix observes one problem and one run per condition. |
| Evidence | Frozen candidate bundle, Core usage and Service-call ledgers, timestamps, substrate history, and replay verdicts remain under the ignored `experiments/` tree. Publish only aggregate results and stable identities. |

## Results

Pending execution.

## Analysis

Pending execution.

## Next steps

Run the registered conditions, independently regrade their frozen bundles, and record measured setup, work, scoring and cleanup durations.
