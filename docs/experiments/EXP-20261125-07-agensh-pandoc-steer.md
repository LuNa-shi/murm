# EXP-20261125-07 · Agensh Pandoc peer delivery and steering

## Registration

[Issue #201](https://github.com/LuNa-shi/SwarmEnv/issues/201) covers autonomous peer collaboration. The owner approved this follow-up test with four equal K3 peers on the same Pandoc task for one hour. The launcher sets the transport lifetime to the project duration and leaves provider response defaults in effect. The host observes events and admissions. The same project issue is provided to all peers and no host work roles are assigned.

| Setting | Frozen value |
| --- | --- |
| SwarmEnv code | `d43f3127e72290e9b1cd8ff21c565d823d28c05f` |
| Comparisons | [Previous SwarmEnv run](EXP-20261125-05-agensh-pandoc.md) and [native Agensh](EXP-20261125-06-native-agensh-pandoc.md) |
| ProgramBench task | `jgm__pandoc.5caad90`, cleanroom image `sha256:02add2de637e9b5f42ecb3600944a15f7a6311107a872f2a95b31eb97c279681` |
| SwarmEnv Worker with cleanroom materials | `sha256:63fcc980599256347d6788b21a4ac6f545ef13f74437c166b73ed5e4ee417fec`, Pi `1.3.0` |
| Project SHA-256 | `d71ac17c0582aca7ce27be2167a52df9d438bd1a980bbc7653ec17db263293a5` |
| Peer Profile and prompt source SHA-256 | `3a2e0c21e5cb883d2414d33a07397991737f6c8352e54a3b6a339c4c8565fc98` |
| Router composition source SHA-256 | `cacf139d1c8a3d0023bea2f110f72a977605fbff89128ec4012fa2b8c6332ec1` |
| Service contract source SHA-256 | `50725aaf71ca9670510e9d3c31e83fc0932a160554e2fdf16a6884d7fe025745` |
| Model and resources | `kimi_proxy/k3`, 4 peers, 1 CPU, 1 GiB memory and 128 MiB project disk per peer |
| Work and stop | 3,600,000 ms after all four peer routers are ready. Setup, settlement and export are measured separately. Stop new events and merges at the deadline, preserve one protected `main` and each peer's private work. |

H1. A peer chooses work and a branch, creates a PR from the run repository, and requests a verified merge without host assignment. Look for peers continuing work from a merged result.

H2. A direct message or admitted Board entry reaches a peer's model while its ordinary work batch is active. Match the notice identity and same-batch model request independently of the Core queue receipt. Look for downstream adoption in tool operations and changed work. Acknowledged or observed messages alone establish neither adoption nor delivery of code.

Independently verify the final `main` archive, build and Markdown smoke behavior using the same checker as the prior SwarmEnv run. The behavioral comparison uses individual runs and the observations support statements about what occurred. Keep all raw traces, candidate source and private facility records in local ignored evidence.
