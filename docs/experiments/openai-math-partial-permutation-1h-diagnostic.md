# OpenAI Math PartialPermutation one-hour diagnostic

Status: COMPLETE diagnostic run

Implementation PR: [#147](https://github.com/LuNa-shi/SwarmEnv/pull/147)

Implementation commit: `7617767a945e263f3fa412255e1a570ccdbfb98c`

This record covers the single-project engineering validation requested before longer parallel observations. It tests lifecycle, model routing, independent Judge admission, Lean feedback recording, and cleanup. It is not a theorem-solving comparison.

## Setup

| Item | Fixed value |
|---|---|
| Problem | `oai_partial_permutation` |
| Target | `OAI.PartialPermutation.complementaryCosets_finite` |
| Fixture source hash | `b4a79c0885d12cac3b96953267880e30366e7a0d99b29aadd05e45b00805431f` |
| Lean / Mathlib | Lean `4.34.1`, Mathlib `d13f23b723b8a846827a245b89c10fc7d3f11612` |
| Checker | `openai-math-v1`, artifact-lock SHA `b924202ac1d702ee1d465a07a8a3ae1cb5e108568bbe86d7853200c9f20ea009` |
| Provider / model | `gpt_proxy` / `gpt-6.2-sol` |
| Agent image | `swarmenv-agent:openai-math-gpt62-b4a02f5` |
| Project layout | one serial project, four Cores |
| Timebox | 3,600,000 ms for the project and each Bot |
| Local run directory | `experiments/openai-math-round-1795097983941/` |

The run used the embedded fixture in this repository. The trusted checker lock contains host-local pinned Lean and Mathlib artifacts, so the lock is recorded as an input while its private absolute paths remain outside version control.

## Results

- The process reached the natural deadline. `stop_signal=null`, `deadline_reached=true`, and cleanup completed without errors.
- The report elapsed time was `3,492,359 ms` after setup. Four of four Cores took work. The run recorded 19 proposed Tasks, 59 Workspace writes, 57 Materials, and 54 checker requests.
- `protocol_valid=true`, `made_progress=true`, and `solved=false`. No Mission submission or trusted acceptance was recorded.
- All 98 Bot records ended in `CLOSED`. The final project state had no active Bot or Execution. The raw run directory contained no remaining benchmark process or Agent container after completion.
- The model-budget ledger recorded 1,256 completed model attempts. Every completed upstream attempt returned HTTP 200. Two closeout attempts were marked `transport_interrupted` while final cleanup was closing the sessions.
- The Judge database recorded 54 checks. The breakdown was one `PASS`, 28 `source_failure` results, 22 `module_verification_failed` infrastructure results, and three request-level failures. The source failures include Lean diagnostics such as an unsolved goal and `aesop failed, made no progress`. The module verification failures concern auxiliary files edited during the run and are retained as infrastructure feedback. They do not establish that the theorem is false.

## Analysis

The run demonstrates that the repaired single-project path stays alive for the intended one-hour observation, routes real traffic through `gpt-6.2-sol`, records checker feedback, and performs complete cleanup. The lifecycle failure seen in the earlier interrupted two-project run did not recur in this natural-deadline run.

The theorem was not proved. The observed mathematical bottleneck is candidate construction and repair. The Judge evidence also shows auxiliary module edits that fail independent verification, so later analysis must keep candidate failures separate from checker or environment failures.

The report is protocol-valid, but it is not evidence for long-run parallel throughput. The checker lock was regenerated against the current host library tree after an earlier artifact fingerprint drift. Reproducing the run on another host requires the same pinned checker artifacts or a separately verified lock.

## Next steps

The planned next observation is four of the simplest reviewed problems, arranged as two groups of two projects, with a four-hour timebox per group. Before each group, an independent review should check the selected fixture, model and image, checker lock, project parallelism, four-Core contract, stop rules, and cleanup path. Each group should retain separate per-project reports and Judge databases so mathematical progress and engineering failures remain distinguishable.
