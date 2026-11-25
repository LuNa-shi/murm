# EXP-20261125-13 — ScaleMAS FATE-H sharing instructions

## Setup

The owner scoped this follow-up to one shared-library run. [Scope and registration in Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202#issuecomment-7161467781). Compare it with the original shared-library observation [EXP-20261125-10](EXP-20261125-scalemas-fate-hard.md). The follow-up asks whether concrete guidance on when to read and write leads to reusable intermediate contributions and observable use by a different peer. The paired observations are descriptive. Both are single runs and the model endpoint has no fixed upstream seed.

| Item | Fixed value |
|---|---|
| Condition | Shared library, Runtime run name `exp-20261125-13-shared`, four independent peers. |
| Implementation | `f03a19f341ff6d05ac7426b6cd8b581cc10beb44`. The changed runtime text is the library portion of the FATE Profile. [Exact Profile and send path](../architecture/prompts/09-scalemas-environment.md) |
| Prompt SHA-256 | Common Profile `b3622ddf54fe32c48b1932b2d495b4f9deb0984b9a9a2d44e4c3b4386c27bc79`, initial input `c52a3d0689bda0ec046a846342b3539d7247acaba51ec595a8767e75ec6dc3bf`, library guidance `049a7c138d85e46c81c552cd14037187691ed7731fea9a78df94d61df2e4f7f5`, combined Profile `272f632d2552753f378eb64edfd9b63fb6e966ffc17b0a1ec71433caafea8aea`. |
| Package and worker | Installed `@swarmenv/core@0.2.0` tarball SHA-256 `efa2d56475b1d4cecba57c9d46960fd04d3d96e61c899792d640333c29c91c2d`. Worker image `sha256:85153578f60ba7ff4bd8cc0681a76dc68f57adebf6318f1fb8d8b79e76dfb922`. |
| Problem and scoring | FATE-H ID 2 at `17967b3118082adfba7c5a5fc03b5f4a53717b59`; declaration SHA-256 `0f264f8c2133b071ee0462f59aeed24ac6b00f4403cc3c143d4d47faaf77f417`. Use the same pinned Lean 4.28.0, Mathlib `8f9d9cff6bd728b17a24e163c9402775d9e6a365`, checker and Service schemas as EXP-20261125-10. |
| Launch | Installed `examples/scalemas-environment/main.js` with installed `fate-config.js` as its sole argument, `SWARMENV_FATE_BENCHMARK=FATE-H`, `SWARMENV_FATE_MODE=shared`. Live `kimi_proxy/k3` with the previous route and sandbox limits. No K3 request, token or cost ceiling. |
| Work and stop | Start once all four peers are ready. Keep the 45-minute maximum work window, 30-minute passive checkpoint and ordinary earlier termination on submission or input settlement. Setup and Core close have separate 180- and 120-second limits, and independent grading has up to 900 seconds per candidate. |

Record actual model instructions, first query and publication times, message delivery by `search` or `visit`, useful intermediate work, every claimed cross-peer adoption, independent candidate verdicts, usage and cleanup. Verify adoption by joining author and consumer identities, exact bytes delivered and a later Lean attempt or final proof using an identifiable part of that contribution. Record the work-check verdict and independent final verdict as distinct events. Capture no-submission, rejected attempts, and reads without demonstrated use. The host records evidence passively, while each peer chooses its proof path, queries, publications and citations.

## Results

Runtime `34302a58-bd1d-493c-8521-9d80cefbd5f7` worked from 11:58:26.691 to 12:43:26.701 UTC, including 10 ms of deadline settlement. Setup took 24.422 s, final cleanup approximately 0.66 s, and grading 17.621 s. The installed CLI exited 0 after 45 min 43 s wall time. All four stop receipts were complete. All four Session archives matched their manifests by size and SHA-256. The exact Runtime Docker label matched zero containers after close. Standalone rescoring reproduced all four candidate identities and verdicts.

| Observation | EXP-20261125-10, original shared prompt | EXP-20261125-13, revised shared prompt |
|---|---:|---:|
| Successful library searches | 4, all empty | 8, all empty |
| Last library search | 0:45 | 1:34 |
| First publication from work start | 37:10.060 | 17:29.586 |
| Publications | 1 from one peer | 2 from two peers |
| Searches or visits after the first publication | 0 | 0 |
| Cross-peer deliveries / demonstrated adoption | 0 / 0 | 0 / 0 |
| First submission that passed independent grading | 38:12.155 | 32:27.142 |
| Final submissions / passing proofs | 1 / 1 | 3 / 2 |
| Team Pass@4 | 1 | 1 |

The 30-minute host checkpoint recorded three active peers, one publication and one submitted candidate. At that point the task Service had returned 206 Mathlib searches and 16 rejected work checks, with one additional check-limit denial and no passing work check. By the deadline, there were 218 successful Mathlib searches, 20 rejected work checks, two passing work checks and the same check-limit denial. The K3 ledger recorded 169 requests. All 169 carried the revised library prompt at the gateway. There were 165 completed HTTP 200 requests with known usage, totaling 9,924,164 input and 344,769 output tokens. Four interrupted requests have unknown usage.

| Peer ID prefix | Observable sequence from work start | Independent result |
|---|---|---|
| `63613e7d` | Exhausted ten work checks, published a Sylow counting outline and lemma references at 17:29.586 (Service row 394), then submitted at 18:20.993 with a citation to its own outline (row 400). | Rejected by Lean |
| `1bdecfe0` | Work check passed at 30:51.615 (row 470). Published a summary of that proof at 31:55.633 (row 480), then submitted at 32:27.142 without a content reference (row 482). | Passed |
| `f29a7113` | Work check passed at 35:48.834 (row 490). Submitted at 36:34.075 without a content reference (row 492). | Passed |
| `56a82aa4` | Continued independent Mathlib queries and Lean attempts after publication. Ended at the deadline. | No submission |

The other three peers started 47 model requests and 55 task Service calls after the first publication. Every library search in the run preceded that publication. No non-author model request contained either contribution address. At 21:54, one peer's Mathlib response returned two declarations already referenced by the first publication, including `card_sylow_modEq_one`. The two other peers also received that declaration through Mathlib after the publication. All eight original queries retrieved both exact artifact bodies when replayed against a copy of the final SQLite store using the installed package. This replay exercised the retrieval path after the contributions existed. It was outside the model run.

## Analysis

The first publication moved 19 min 40 s earlier, leaving roughly 27 min 30 s of work before the cutoff. The additional time and the concrete prompt still produced zero observed cross-peer reads. The tool traces locate the break before exposure. The peers repeatedly looked up overlapping material in Mathlib while their library activity remained confined to the opening and their own publications. When the publishers wrote, both were already close to their own submission. The first contribution was a usable outline for further investigation and its author's full candidate was rejected. The second described a proof that had already passed its working Lean check. These outcomes also leave open how useful the first outline would have been to a peer who read it.

The two passing final proofs have no demonstrated peer contribution. The larger number of passing proofs in this run therefore supplies no evidence of a sharing benefit. Both observations used four K3 peers on one theorem. The paper's selected FATE-H coordination examples used eight Claude-5-Sonnet peers, and its overall FATE-H benchmark covers many problems. This result establishes where spontaneous cooperation stopped in the tested configuration. The frequency and effect of adoption in the authors' setting remain open. [ScaleMAS Appendix D](https://arxiv.org/html/2610.16120v1#A4)

## Next steps

Retain this comparison as a negative observation for spontaneous adoption and keep the separate previously verified native handoff as evidence of the Service's ability to deliver stored bytes. The authorized single shared run is complete.

## Evidence and limitations

The private experiment directory retains the actual model requests, Session archives, Service rows, immutable store, the independent regrade and the replay audit. The report records only aggregate outcomes, event identifiers and the minimum detail needed to identify redundant lookups. Engineering verification at the implementation revision included TypeScript, generated Architecture checks and the default full test suite (1,229 passed, 68 skipped, zero failures), independent install and frozen FATE-H preparation, and separate Spec and Standards reviews with zero actionable findings. [Implementation PR](https://github.com/LuNa-shi/SwarmEnv/pull/215)
