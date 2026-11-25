# ScaleMAS one-problem FATE-M acceptance

Status **COMPLETE**. The owner authorized K3, one original problem, four peers, and no K3 usage ceiling. Each of the three conditions ran once. [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202) · [Phase design review #214](https://github.com/LuNa-shi/SwarmEnv/pull/214) · [Implementation review #215](https://github.com/LuNa-shi/SwarmEnv/pull/215) · [Preregistered configuration](https://github.com/LuNa-shi/SwarmEnv/blob/64734edeefd1cd95833bc479143425a3aab162b4/docs/experiments/EXP-20261125-scalemas-fate.md)

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

| Condition | Runtime | Work interval (UTC) | Setup | Work | Final cleanup | Score | Passed final proofs |
|---|---|---|---:|---:|---:|---:|---:|
| Shared | `e11535a5-5624-4349-9dd0-5cd73d0cba6b` | 07:51:03.825–07:53:15.176 | 24.348 s | 131.351 s | 0.562 s | 16.314 s | 4/4 |
| Private | `ac769482-77dd-4062-bbb1-b23e9ee2ba5b` | 07:53:56.912–07:57:04.812 | 24.837 s | 187.900 s | 0.555 s | 16.723 s | 4/4 |
| None | `4937b058-d3e3-47c4-808e-06627684df20` | 07:57:46.612–08:00:18.163 | 24.502 s | 151.551 s | 0.546 s | 15.908 s | 4/4 |

Work starts when all four peers are ready and ends when the last peer finishes. Final cleanup is measured from that finish to the Environment close report. Earlier peer cleanup overlaps work. The three sequential launches took approximately 9 min 55 s including setup, close and scoring. The matrix exited 0, all 12 peers submitted and ended before the deadline, and each team scored 1/1. The standalone scorer reproduced the verdicts and proof hashes for all 12 final submissions. All 12 Session archives and stop receipts were present. A Docker query using each Runtime's label returned zero remaining containers.

| Condition | Core model attempts | HTTP 200 with usage | Usage unknown | Known input tokens | Known output tokens | Library operations |
|---|---:|---:|---:|---:|---:|---|
| Shared | 48 | 44 | 4 | 241,282 | 8,831 | One publication. No reads or cross-peer references. |
| Private | 48 | 44 | 4 | 241,331 | 10,201 | One personal publication and one personal search. |
| None | 42 | 38 | 4 | 190,280 | 9,631 | Library tools absent. |

All four peers in each group used the live model. Core recorded 138 attempts with zero pending attempts and zero lost trace records. The 12 transport interruptions began after the corresponding final submission was recorded, during peer shutdown. Their usage and the monetary cost remain unknown. The metered totals are 672,893 input and 28,663 output tokens across 126 responses.

The controlled, installed-package test independently exercised handoff in native Pi/OpenSandbox Runtime `b461f6bf-1203-4ab9-810b-300cdc9a83db`. Core recorded publication at sequence 18 and confirmed producer cleanup at 24. A Docker lookup confirmed deletion before the consumer continued in its existing Session. The consumer searched at 28, visited at 32, published a successor citing the exact original bytes at 36, and submitted the proof at 44. The proof passed both scorers. Fault probes on the installed package also verified atomic rollback of content and citation weight after an injected SQLite receipt failure, stable retry and exact decay, durable failure before allocation for a missing fixture, and one unknown input preserved alongside independently pending cleanup.

## Analysis

The installed configuration delivered correct, reproducible final proofs in all three conditions. The live shared run recorded a publication and zero cross-peer adoption. The controlled native handoff establishes that the publication survives physical removal and can be used in a later peer's proof. The one-problem comparison observes a tied team outcome. The three durations are individual observations from independent four-peer groups. Estimating a change in success rate or time due to sharing would require more problems and repeats.

## Next steps

The registered one-problem matrix and its regrade are complete. The design and implementation are pending owner review in #214 and #215.
