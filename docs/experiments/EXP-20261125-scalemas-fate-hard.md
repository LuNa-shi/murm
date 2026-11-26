# ScaleMAS FATE-H long-window run

Status **RUNS SETTLED · ONE CANDIDATE VERDICT UNRESOLVED**. The owner approved one harder original problem, three groups of four K3 peers, a 45-minute work limit per group, a 30-minute observation, and no K3 usage ceiling. [Issue #202 approval](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7156832433) · [Design #214](https://github.com/LuNa-shi/SwarmEnv/pull/214) · [Implementation #215](https://github.com/LuNa-shi/SwarmEnv/pull/215) · [Preregistered configuration](https://github.com/LuNa-shi/SwarmEnv/blob/42371bbae54ed3ea59c173eef5d86720e98b8534/docs/experiments/EXP-20261125-scalemas-fate-hard.md)

## Setup

| ID | Condition | Independent Runtime run name | Comparison |
|---|---|---|---|
| `EXP-20261125-10` | Shared library | `exp-20261125-10-12-shared` | `EXP-20261125-07` |
| `EXP-20261125-11` | One library per peer | `exp-20261125-10-12-private` | `EXP-20261125-08` |
| `EXP-20261125-12` | No library | `exp-20261125-10-12-none` | `EXP-20261125-09` |

| Item | Fixed value |
|---|---|
| Implementation | `e00f8c4f2fc7103aca3cbc31aadc1c0ef1740fb5`. [Runtime and checker](https://github.com/LuNa-shi/SwarmEnv/blob/781428d11add844a60492f5654cca7106ee4b80d/docs/architecture/19-scalemas-environment.md) |
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

| Condition | Runtime ID | Work interval (UTC) | Setup | Final cleanup | Scoring | Final submissions / passing proofs | Team Pass@4 |
|---|---|---|---:|---:|---:|---:|---:|
| Shared | `7e56ebc4-a11a-4bdb-bb17-df33b03ab306` | 08:25:38.446–09:10:38.450 | 24.570 s | 0.990 s | 16.509 s | 1 / 1 | 1 |
| Private | `7c8569a6-0e3f-4f64-a6c0-58479411c1ad` | 09:11:21.110–09:56:21.113 | 25.104 s | 1.013 s | 17.005 s | 2 / 2 | 1 |
| None | `3d47150c-226f-4b30-90f8-f8309e469e5d` | 09:57:04.149–10:42:04.175 | 24.951 s | 1.021 s | 17.504 s | 2 / 1, with 1 checker error | 1 |

The configured work cutoff was 45 minutes. The last local peer-end record can follow the cutoff by a few milliseconds while cancellation settles. Setup ends when all four peers are ready. Final cleanup runs from the last peer work end to the Environment close report. Scoring uses the frozen final submissions after close. The CLI exited 1 with `FATE_SCORE_INCOMPLETE` because one no-library candidate hit `LEAN_PROCESS_FAILED`. All 12 stop receipts were complete, and files matched their Session archive manifests by byte count and SHA-256. Docker queries for the three exact Runtime labels returned zero containers. The separately invoked installed scorer reproduced each candidate identity and verdict, including the repeated checker error and explicit no-submission rows. The full matrix took approximately 2 h 17 min 9 s including setup, cleanup and scoring.

| Condition | Active peers at minute 30 | Successful Mathlib searches | Working Lean checks | Submitted proofs | Published contributions |
|---|---:|---:|---|---:|---:|
| Shared | 4 | 219 | 1 rejected | 0 | 0 |
| Private | 4 | 201 | 1 rejected | 0 | 0 |
| None | 4 | 191 | 3 rejected | 0 | 0 |

The host captured all three observations at the scheduled offset within 1 ms. All 12 peers were still active at their respective observations. Every passing working check and final submission occurred after the observation.

| Condition | Total successful Mathlib searches | Working Lean checks | First passed working check from start | Final submission times from start | Peers at deadline |
|---|---:|---|---:|---|---:|
| Shared | 261 | 2 passed, 17 rejected, 1 operation-limit denial | 34:29.943 | 38:12.155 | 3 |
| Private | 246 | 2 passed, 8 rejected | 35:53.148 | 37:32.645, 39:02.737 | 2 |
| None | 215 | 1 passed, 18 rejected, 2 checker errors, 1 operation-limit denial | 41:39.440 | 42:49.107, 44:35.163 | 3 |

| Condition | K3 attempts | Completed HTTP 200 with usage | Interrupted with unknown usage | Known input tokens | Known output tokens |
|---|---:|---:|---:|---:|---:|
| Shared | 131 | 127 | 4 | 9,070,008 | 446,694 |
| Private | 145 | 141 | 4 | 9,782,391 | 394,167 |
| None | 167 | 163 | 4 | 10,879,106 | 443,960 |

Core records confirm live `kimi_proxy/k3` activity from all four peers in each Runtime. The total recorded counts were 443 attempts, 29,731,505 known input tokens and 1,284,821 known output tokens. The interrupted calls coincided with shutdown after a submission or at the work cutoff. Their usage and monetary charges are unknown. Core reported zero lost or pending model trace records across all groups.

### Shared library evidence

All four shared peers searched an empty library early. The first and only publication arrived at 37:10.060. No subsequent shared search or visit occurred, and no different peer referenced the publication in a successor or final submission. The publishing peer cited its own contribution in the final proof submitted at 38:12.155. One other shared peer's working Lean check passed at 43:40.073. That peer made no final submission before the deadline. The score uses the frozen submissions only. One shared peer also reached the task and library operation limit while trying another proof. The private group published two personal contributions at 37:27.767 and 38:56.246. Both of its final submissions cited the original problem and Mathlib resources.

The separate FATE-M installed-package native test used Runtime `7a753410-5f18-4c56-a272-115c0c776af9`. Its accelerated observation offset was 1 second and it recorded the active consumer 1 ms after the scheduled time. It verified exact cross-peer handoff with the producer's sandbox already physically removed. The consumer used the artifact in its original Session and submitted a passing proof. The controlled handoff ran in a separate Runtime with its own score. The seven focused checks passed. The full suite recorded 1,231 passed, 0 failed and 66 opt-in skips. TypeScript, documentation and whitespace validation passed.

### Reproduced checker failure

The initial scorer and standalone replay preserved the same second no-library candidate digest, `checker_error` verdict and `LEAN_PROCESS_FAILED` code. The pinned Lean process panicked in its `TryThis` suggestion code while mapping a byte offset to a UTF-8 character boundary. The same peer had two working checks with that process error earlier in the run.

A small synthetic proof of `True` reproduced the panic through the installed proof guard in a single process. It succeeds when the outer file byte at issue is ASCII or when Lean parses the proof directly in its own source positions. The guard parses a proof string separately, and the suggestion formatter can look up the resulting syntax offset against the enclosing source. Removing foreign positions in a private diagnostic copy of the guard allowed the synthetic case to compile. The experiment and replay used the preregistered checker, and the saved formal verdict remains unresolved for that candidate.

## Analysis

All three four-peer teams solved the theorem within the 45-minute window. The host accepted five final submissions and the pinned checker verified four. The no-library team's second submission had a reproducible checker error, so its individual proof verdict is unresolved. One other independently verified proof is sufficient for that team's Pass@4.

The live shared run establishes that a peer can publish and cite its own completed work during a real task. Observed cross-peer use was zero. The separate installed test establishes that another peer can adopt an artifact after its producer is removed. The number of passing proof submissions is descriptive for the three peer pools. One problem and one run per condition provide no estimate of ScaleMAS's success-rate or runtime effect across problems. The original FATE-M test used a different theorem and work limit, so its timings are a comparison of observed task durations only.

## Next steps

Execution, cleanup and pinned replay are settled. A source-position correction needs review on #202 before changing the checker and rescoring the same frozen candidate. Phase design #214 and implementation #215 are open for review.
