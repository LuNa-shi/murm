# EXP-20261125-05 · Agensh Pandoc full-window repeat

## Registration

[Issue #201](https://github.com/LuNa-shi/SwarmEnv/issues/201) covers autonomous peer collaboration. On 2026-11-25 UTC the owner approved one run with `kimi_proxy/k3`, four peers and a one-hour project window. The time window is the only run-level budget. The owner authorized a new full-hour run after [EXP-20261125-04](EXP-20261125-04-agensh-pandoc.md) ended early. The same implementation and task are used. The launcher sets the transport lifetime to the project duration so requests are governed by the shared project deadline. It sets no call-count, accumulated-token or per-response output limit.

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

Registered before launch. Results pending.

## Analysis

Pending.

## Next steps

Observe the registered run through its deadline and verify the shared archive and cleanup.
