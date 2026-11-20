# EXP-20261120-02 · SeymourSecondNeighborhood, one project and four Cores

## Setup

The owner requested a four-hour, single-project run after correcting the turn lifecycle defect observed in the first pair. Only the first configured entry is in scope. [Issue #153](https://github.com/LuNa-shi/SwarmEnv/issues/153) · [Interrupted pair](EXP-20261120-01-openai-math-first-pair.md)

| Input | Value |
|---|---|
| Host runtime | `4c2f19312ea4f3680ee0b1d5c9bec6a026aa8246` |
| Fixture and target | `oai_seymour_second_neighborhood`, `OAI.SeymourSecondNeighborhood.exists_goodVertex`, source `fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98` |
| Lean and Mathlib | 4.34.1, `d13f23b723b8a846827a245b89c10fc7d3f11612` |
| Checker | `openai-math-v1`, lock `f0a85f1886c8fc546dfb925a9133908e1e69ff96c8bd4ddd80d303c4adadf891`, 600 s per ordinary or final check, 8 GiB, 200% CPU, one Lake job. Full private target control passed in 55.580 s. |
| Model and image | `gpt_proxy/gpt-6.2-sol`, `swarmenv-agent:openai-math-wait-b56d030`, image ID `d09c08f6859cb5ee0d75ae2c370fed47eefab4a9ece217e9ffb446ee00e0d7cf` |
| Initial state | Fresh public Workspace with the pinned challenge, no previous project state or reference proof. Each Core receives the ordinary SwarmEnv discovery prompt. The project report records actual prompt and service schema hashes. |
| Launch | `scripts/run-openai-math-round.mjs`, this problem alone, project parallelism 1, four Cores, project and Bot limits 14,400,000 ms. No other model experiment runs concurrently. |
| Stop conditions | Trusted Mission acceptance, the four-hour deadline, operator request or a reproducible engineering failure that compromises the four-Core observation. Preserve partial evidence if stopped. |
| Evidence | Private `experiments/EXP-20261120-02/` holds launch metadata, project report, raw events, SQLite stores and immutable Workspace revisions. A read-only observer records project state on a minute cadence. |

Observe per-Core discovery dispatch and Task takes, how replacements recover from expiry or handoff, and the chain from checked lemmas to incorporation into the main proof. Classify source failures, infrastructure errors, interrupted model receipts and final Mission submissions separately.

## Results

Registered before launch.
