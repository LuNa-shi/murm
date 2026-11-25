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

## Results

The run started at 11:59:24.391 UTC on 2026-11-25 after 77.56 seconds of setup. Project admission stopped at 12:59:24.394 UTC, after 3,600,003 ms. No model request started after the stop. All four peers were still active in their original work batches at the last sample. Four requests were in flight at stop. The gateway forwarded the Pi-supplied output allowance unchanged on all 786 requests, with medium reasoning throughout.

| Peer | Provider attempts | Completed usage records | Verified PR merges requested by peer | Unique steer notices in model requests |
| --- | ---: | ---: | ---: | ---: |
| A | 213 | 212 | 6 | 17 |
| B | 206 | 205 | 3 | 16 |
| C | 186 | 185 | 3 | 18 |
| D | 181 | 180 | 4 | 27 |
| Total | 786 | 782 | 16 | 78 |

- **H1, peer-led delivery.** All four peers chose their own work and opened PRs from branches in the run repository. The first merge was A's executable differential-test harness on `work-tests-harness` at 4m08s. A later requested two merges of PR #5 at head `6bff289` that returned `DELIVERY_NOT_READY`. A updated the branch with current `main` and requested head `04a413f`. The verified merge `fac13a9` contains both D's core commit `634c79e` and A's LaTeX and plain-text writers. The final first-parent history contains all 16 verified PR merge commits. Ten additional merge attempts were definitively rejected and delivery closed with a stable pin.
- **H2, delivery within the active batch.** The routers recorded 80 accepted steer inputs. The model request traces confirmed 78 unique notices in the same ordinary work batch before settlement, comprising 67 Board deliveries and 11 DMs. The first Board delivery was at 1m03s, and the first DM delivery was at 3m21s. All 11 accepted Mattermost DMs reached their recipients. Two copies of the final Board entry were queued for B and D about seven seconds before cutoff, with no matching model request. No observed notice identity appeared twice in one model request or returned as a separate ordinary batch.
- **Observed use.** B initially claimed a test harness alongside an HTML reader and Markdown writer. B received A's Board harness claim at model request 51 and amended its claim around eight seconds later to drop the overlap. D sent A the AST interface and the name of D's pushed core branch at 12:20:32 UTC. A received it in model request 275 about two seconds later and immediately fetched and inspected that branch. A then based its writer branch on D's commit. The actual PR #5 history verifies incorporation of both peers' work into the final shared result.
- **Delivery and shutdown.** Final `main` was `383f612cbb8a017db255e7a4ba3ac9eee4dd1b22`. The archived main SHA-256 was `57b241d49f0229cb66fa8cc963c6db73c41ad7481a506349e204a971aa910c43`. An isolated, offline checkout built with `compile.sh`, produced an executable, and matched the reference bytes for the registered Markdown-to-HTML sample. All four private workdirs and four Pi Session archives were retained and all eight manifests verified against stored bytes. Core and facility cleanup were complete and the runtime and facility labels found no remaining containers or networks. The local all-refs bundle verified with SHA-256 `a20c41d8e393f7b84904fd716da26318abaca33bdc4b18360394ab9493389f13`.

The controlled two-peer probe used native Pi 1.3.0 against a local scripted Responses endpoint with real Gitea, Mattermost and Board. A's in-progress Bash finished, both B's DM and Board update appeared in A's immediate next model request, and A settled once. B completed a verified merge from `work/self-chosen-probe`. The first probe exposed Pi's one-at-a-time default. The implementation selects the existing `all` mode to admit both pending notices at the same execution boundary. The final `npm test` run passed 1,235 and skipped 65 opt-in tests. Type-check, architecture generation and verification, and whitespace checks also passed. Standards review found a bounded-close defect in the draft, resolved with a router-drain deadline and a held-steer regression. Spec review found no blocker.

## Analysis

Both hypotheses were supported by the Pandoc observation. Compared with the previous SwarmEnv run, self-chosen branches now entered the verified PR path and DMs visibly reached running peers. Compared with native Agensh, the basic collaboration behaviors occurred in both systems. SwarmEnv's Core steer delivers an additional prompt at a Pi execution boundary. Native Agensh appends notices to an eligible MCP tool response. The two systems also differ in startup timing, prompts and tools, so the observed merge counts and timings describe these runs.

## Next steps

The pinned result, its archive, the independent smoke result and the collaboration indices are the evidence for #201. The independent check covers buildability and one reference sample. The original ProgramBench evaluator was outside this run's check.
