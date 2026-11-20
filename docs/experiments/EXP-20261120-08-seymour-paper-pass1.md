# EXP-20261120-08 · Single solver with the Seymour manuscript

## Setup

The owner requested one independent solver attempt under the same task background and model as the four-Core paper run, with unlimited context compactions. The comparison is the accepted SwarmEnv run linked below. [Seymour benchmark Issue #153](https://github.com/LuNa-shi/SwarmEnv/issues/153) · [Four-Core comparison](EXP-20261120-07-seymour-paper.md)

| Fixed condition | Value |
|---|---|
| Implementation | Runtime dfe8d8fae3dc26c66a8e8f761e7656fb6421d659, the same worktree and compiled worker image as the comparison. The branch at c9ef108 adds experiment documentation. |
| Method | Native runPassK, K=1. One preassigned whole-proof Task, one Core, one solver Bot and one private Execution. No replacement sample. Standard solver prompt file SHA-256 33ea49d9c46fc7402dac07ec040aed24da56dd4d92cb3b7e8fe7d1cdae0c445d. |
| Compaction | Pi auto-compaction enabled. Solver Runtime records a null cap and continues the same Bot and Execution after successful compaction. Transport and time limits remain. |
| Model | gpt_proxy/gpt-6.2-sol via Pi 1.3.0, worker image 2ef3e022730622de197788860d5fc05b983f71ca13102d5ec0072bf7d1387dcc. |
| Fresh solver inputs | Original Seymour challenge fa4a37831405b3fe7f6a88a2dce8918982195ee1757e05e4623055822d36ca98 and the paper PDF/text from manifest 7154d525431d105a19735bdacf3f0e34344df0c591dba8168deae1c3c9c6e74a. The solver receives no prior project state or benchmark solution. |
| Checking | Same openai-math-v1 deployment lock ade992f23fa8a66ae888b746f77cbe5cf8959b01a34c5ad3e58404fa5522111d. Lean 4.34.1, Mathlib d13f23b, 600 s per ordinary/final check, 8 GiB, 200% CPU, one Lake job. Same sandbox policy and CLI/checker waits. |
| Time | Four-hour group window after readiness. Record time to trusted on-time acceptance relative to the common group start. Setup, cleanup and idle observation after early acceptance are separate. The four-Core time to trusted acceptance is 3,534.716 seconds. |
| Evidence | Preserve actual startup inputs, project report, immutable submissions and Judge receipts, single identity, model receipts and compaction records. Record the outcome and any protocol failure separately. An unsolved attempt is censored at its actual observation boundary. |
| Launcher | The private launch harness invokes the same paper selector and model/sandbox settings as the four-Core run and dispatches the selected problem to the repository Pass@K implementation. Harness SHA-256 f1b9fad6f6d5ca065f40f305712949fff8f85149f19b9c8219e59aba48fea3f2. |

## Results

**Running.** The study was registered at 0ef00a8 before model calls. Group research start was 10:05:03.881 UTC and the deadline is 14:05:03.881 UTC on November 20, 2026. Both initial Workspaces had identical content hash efac96d5c35b2b050b21fab6f04cf3de1e0a7f8defd9758a3ff40270c58b85af and exactly three files. The single Bot activated Execution c795c8a7 on Core 1. RPC recorded automatic compaction enabled at 10:05:08.027 and the tool result at 10:05:20.571 contained the paper text. A read-only observer samples every ten minutes and records the final attempt report when it becomes available.

Offline validation passed all four Pass@K tests, the paper materialization test, the same-identity solver compaction regression and all three built-image contract checks. The formal runner uses the same checker lock that accepted the four-Core proof.
