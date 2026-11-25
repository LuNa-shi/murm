# EXP-20261125-16 · Agensh Pandoc full-window repeat

Registry ID `EXP-20261125-16` was assigned when integrating the parallel branches. The original run and its evidence use `EXP-20261125-05`.

## Registration

[Issue #201](https://github.com/LuNa-shi/SwarmEnv/issues/201) covers autonomous peer collaboration. On 2026-11-25 UTC the owner approved one run with `kimi_proxy/k3`, four peers and a one-hour project window. The time window is the only run-level budget. The owner authorized a new full-hour run after [EXP-20261125-15](EXP-20261125-04-agensh-pandoc.md) ended early. The same implementation and task are used. The launcher sets the transport lifetime to the project duration so requests are governed by the shared project deadline. It sets no call-count, accumulated-token or per-response output limit.

| Setting | Frozen value |
| --- | --- |
| Tested code | `ce7b0d6cf12dbec1b990d9dd1b013e589f5a4774` |
| Upstream Agensh reference | `2dae4e14a653da48549fd9aa093f834841475d6c` |
| ProgramBench task | `jgm__pandoc.5caad90`, official cleanroom digest `sha256:02add2de637e9b5f42ecb3600944a15f7a6311107a872f2a95b31eb97c279681` |
| SwarmEnv Worker with cleanroom materials | `sha256:63fcc980599256347d6788b21a4ac6f545ef13f74437c166b73ed5e4ee417fec`, Pi `1.3.0` |
| Project JSON SHA-256 | `d71ac17c0582aca7ce27be2167a52df9d438bd1a980bbc7653ec17db263293a5` |
| Peer profile and prompt source SHA-256 | `b03d4ae66c60b53fecb15b9cec372ea32d445e211537cd149708f92c45571b17` |
| Router composition source SHA-256 | `0951e377f5cdc24340b23a9bbd2d8cd0187cd1710033539b7f4bff02373bc462` |
| Service contract source SHA-256 | `12a435a24c0bdf999635c0f540cb799785bdbf66e1c074c64f87496c7ec57b73` |
| Peer resources | 1 CPU, 1 GiB memory and 128 MiB project disk each. Use the provider response defaults. |
| Baseline | Single SwarmEnv run with a shared goal and four equal peers. No comparison arm. |
| Window and stop | Start when all four peers and their inputs are ready. Stop admission at 3,600,000 ms, then verify the shared Git archive and collect private work and Sessions. Setup and cleanup are timed separately. |

Observe self-selected work, reuse of another peer's output, delivery via PR, later input on the same Session, and complete shutdown. Inspect the pinned final archive independently, including whether it can build. The run has no task score threshold. Store provider usage, raw traces, candidate source and internal facility data locally.

## Results

The four peers started at 08:09:52.787 UTC on 2026-11-25 after 78.36 seconds of setup. The project deadline stopped admission at 09:09:52.790 UTC, after 3,600,003 ms. The host observed the run without sending input, assigning work or merging branches. The last status sample at 59m30s showed all four peers working. Four requests were still in flight at shutdown.

| Peer | Provider attempts | HTTP successes | Completed usage records | Known input tokens | Known output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 104 | 103 | 103 | 7,411,170 | 101,606 |
| B | 182 | 182 | 181 | 14,733,582 | 101,405 |
| C | 112 | 112 | 111 | 9,715,323 | 121,366 |
| D | 175 | 175 | 174 | 12,928,968 | 110,805 |
| Total | 573 | 572 | 569 | 44,789,043 | 435,182 |

Usage is counted from completed provider records. Requests interrupted at the deadline have unknown final usage. Thirty-one completed requests exceeded the previous run's 65-second watchdog. The longest completed request took 338.57 seconds. Pi supplied its normal `max_output_tokens` values, ranging from 92,842 to 128,000. The gateway forwarded them unchanged on all 573 requests. All 569 metered requests ended with provider status `completed`, and the largest recorded response used 13,762 output tokens.

All four peers read the project issue and Board and chose work themselves. The Board accepted nine `CLAIM` entries. The messaging service accepted nine direct messages and three team posts. One of C's team posts reached model input on D's second turn at 27m36s and on A's second turn at 56m56s. No direct message reached a new model turn before the cutoff. B and C used Git to inspect code from D's pushed implementation branch. The run produced four pushed work branches. No PR was created or merged. D's PR submissions from a branch outside its configured work branch were denied, and one merge request for the project issue number was rejected.

The pinned shared archive independently unpacked to `main` at `5267b1e31fee49aba89fe1db4ce97a897ccbec2b`. Its SHA-256 was `8449381dcdd5081df4692d496dc0d77c2f00fb699fcb8c47002203b04cdca789`. It contained the initial README only. The independent build check found no `compile.sh`, so no task score was produced. The archived pushed branches were `peer-a/core-skeleton` (`e358fd105cf5`), `test-corpus` (`466de34fc3c0`), `work-b` (`1492983d7e20`) and `work-d-core` (`48701e12f509`). A verified full-history Git bundle holds all pushed refs and has SHA-256 `99398b93551593e1cd43cd9f3d9b5b2ba84bb8f803fab72765346006d0dc7331`.

The Core close receipt remained `CLEANUP_PENDING`. OpenSandbox expired all four sandboxes 4.179 to 16.268 seconds before the project deadline. Each sandbox was already gone when Core attempted to stop its Worker. Its unpushed workspace files and Session archive could not be recovered. After verifying the shared archive, backing up all pushed refs, and independently confirming all four sandboxes were absent, the operator stopped the retained run process and removed its four local facility containers and network. Raw evidence, the as-launched script and the operator receipt are retained outside Git.

## Analysis

The repeat demonstrates self-selected work, use of shared collaboration facilities and later model turns on existing peers. Git traces establish that peers inspected another peer's pushed code. The unchanged `main` gives no evidence that peer work was integrated into the shared delivery. The branch rejection shows a difference between the peers' branch choices in this run and the set the Service accepts for opening PRs.

The project clock and sandbox lifetime had different start points. The sandbox provider's one-hour default was measured from each allocation, while the work window started later, when the peers were ready. The project deadline fired on schedule, after the sandboxes had already expired and destroyed ephemeral state. The terminal shared archive came from Gitea, which remained available during close.

## Next steps

The follow-up sets the sandbox lifetime explicitly to cover the foreground startup and work window plus the close wait. The same one-hour project deadline governs work. The installed example requests 3,750 seconds of sandbox lifetime and the corrected local Pandoc launcher requests 3,900 seconds to cover its longer close wait. The follow-up has a local regression check. It has no live one-hour validation against this run.
