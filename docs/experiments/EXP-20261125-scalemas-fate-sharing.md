# EXP-20261125-13 — ScaleMAS FATE-H sharing instructions

## Setup

The owner scoped this follow-up to one shared-library run in [Issue #202](https://github.com/LuNa-shi/SwarmEnv/issues/202). Compare it with the original shared-library observation [EXP-20261125-10](EXP-20261125-scalemas-fate-hard.md). The follow-up asks whether concrete guidance on when to read and write leads to reusable intermediate contributions and observable use by a different peer. The paired observations are descriptive. Both are single runs and the model endpoint has no fixed upstream seed.

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
