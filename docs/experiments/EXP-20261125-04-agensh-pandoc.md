# EXP-20261125-04 · Agensh Pandoc collaboration

## Registration

[Issue #201](https://github.com/LuNa-shi/SwarmEnv/issues/201) covers autonomous peer collaboration. On 2026-11-25 UTC the owner approved one run with `kimi_proxy/k3`, four peers and a one-hour project window. The time window is the only run-level budget. This is one observation of the SwarmEnv Agensh path.

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

Runtime `b523a308-6fbd-40f5-9500-0829bab5befd` prepared four separate peers in 77.9 seconds. All four started at 07:45:17.137 UTC. The operator stopped at 08:02:32.991 UTC, after 17m15.854s of the one-hour allowance, because every peer's router had stopped accepting inputs. Core and facility cleanup completed 3.3 seconds later. All four private checkouts and Pi Sessions were exported.

| Peer | K3 requests | Completed with known usage | Interrupted with unknown usage | First turn failed at |
| --- | ---: | ---: | ---: | ---: |
| A | 35 | 29 | 6 | 14m05.168s |
| B | 31 | 23 | 8 | 16m01.875s |
| C | 35 | 28 | 7 | 16m14.168s |
| D | 22 | 18 | 4 | 7m29.923s |
| Total | 123 | 98 | 25 | |

All 123 requests reached the configured K3 route and returned HTTP 200 SSE headers. Known usage was 1,116,020 input tokens and 43,443 output tokens. The 25 interrupted requests lack final usage receipts.

Every peer read the issue and Board. A, B and C posted accepted, self-selected CLAIMs. All three claimed overlapping pieces of the Python scaffold, CLI or Markdown path. C posted a team message, which the other three routers received and queued. Every recipient's first turn ended with `MODEL_ERROR`, and the queued batches were cancelled. Three peers archived private files beyond the initial checkout. No PR was opened or merged, and the evidence contains no completed later turn or confirmed adoption.

The independent checkout verified the final archive SHA-256 `611737a9ccf10220f24a37776fd99f4d156c3b43c017260f7fd73e7bd5a5f5eb` at starting revision `f6bb05ffd5cd460e4d408c398f7709987ca29444`. It contained only the initial README, so there was no `compile.sh` to build. The four sandbox stop receipts and facility owner checks confirmed cleanup. The private traces and source are retained locally.

## Analysis

The execution launcher set a 65-second deadline per model request. Every interrupted stream ended between 65.000 and 65.012 seconds after its request started. Each peer eventually exhausted its Pi retries. The resulting failed input caused the router to stop dispatching further work to that peer. This accounts for the early termination and the undelivered message. The run established real K3 startup, autonomous claims, receipt of a broadcast in the routers and complete export and cleanup. It left autonomous continuation, adoption and PR delivery unverified with K3.

## Next steps

The local launcher now ties its model request timeout to the project time window while the project deadline still revokes the active runtime. The existing regression for stopping an active upstream stream passed. A fresh full-hour observation uses a new registration and a separately authorized time allowance.
