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

The study was registered at 0ef00a8 before model calls. Group research start was 10:05:03.881 UTC and the deadline is 14:05:03.881 UTC on November 20, 2026. Both initial Workspaces had identical content hash efac96d5c35b2b050b21fab6f04cf3de1e0a7f8defd9758a3ff40270c58b85af and exactly three files. The single Bot activated Execution c795c8a7 on Core 1. RPC recorded automatic compaction enabled at 10:05:08.027 and the tool result at 10:05:20.571 contained the paper text. A read-only observer samples every ten minutes and records the final attempt report when it becomes available.

Offline validation passed all four Pass@K tests, the paper materialization test, the same-identity solver compaction regression and all three built-image contract checks. The formal runner uses the same checker lock that accepted the four-Core proof.

### Time to trusted acceptance

**The single solver proved the configured Seymour theorem in 1 h 08 min 52.480 s.** Submission `final-submit-052` fixed public main 0.52 at Git `36675dcb1ba385902fbcea26411fdb7c990587aa`. The original final-tree Judge returned PASS at 11:13:56.361 UTC with receipt `treecheck:600702c8-e26f-4a4b-88ea-b7b579370d64`. The attempt report records solved=true, protocol_valid=true and no invalid reasons. One Bot, one Session and one successful Execution served the complete Task. Automatic compaction was enabled and zero completed compactions were observed. The same registered rule awards the single solver and the four-Core solution a final score of 1.00.

| Measurement | Pass@1, one Core | Four-Core SwarmEnv |
|---|---:|---:|
| Research start to final PASS | 1 h 08 min 52.480 s | 58 min 54.716 s |
| Final submissions | 1 | 3 |
| Initial setup, outside research time | 116.413 s | 119.814 s |
| Model attempts with terminal usage | 141 of 142 | 967 of 977 |
| Observed input tokens | 9,292,130 | 41,070,107 |
| Observed output tokens | 68,962 | 290,840 |

At the four-Core acceptance time measured on the single solver's clock, 11:03:58.597 UTC, the latest public candidate was 0.46, shared main remained the initial 0.1 and the Mission had zero submissions. The first project compilation PASS at 10:42:10.884 UTC concerned revision 0.34, whose original root still contained its proof hole. At 11:10:45.648 the checker passed the proof on candidate 0.51 (check 1b7a2034). Main 0.52 retained the identical file-content hash. Submission began at 11:11:45.415 and trusted acceptance followed 130.946 s later. The accepted tree contains one Lean source file plus the initial PDF and text.

The runner closed the successful attempt at 11:13:56.958 with no cleanup errors. Its single Bot closed, the Execution succeeded, the Task finished and the research container exited. The native group aggregator keeps the registered four-hour observation window until 14:05:03.881 UTC. These acceptance and attempt-validity results come from the settled per-attempt report and the frozen Mission submission. The remaining group observation period is idle. The reported model volumes cover trusted receipts only. The single solver had one interrupted transport and the four-Core run had ten. Neither recorded monetary cost.

## Analysis

The four-Core run reached trusted acceptance **9 min 57.764 s earlier**, using 14.47% less elapsed research time relative to the single solver. The wall-clock speedup was 1.169×. The single solver used fewer observed tokens. Both had exactly the same starting file contents, provider/model, image and checker deployment. The independent solver used the standard solver prompt, private trajectory and restricted tools. The team used the Swarm prompt, public intermediate results and coordination tools. This is one observation per condition. Actual compaction count was zero in the independent attempt, so the experiment supplies no empirical comparison between compaction policies.

## Next steps

The requested time comparison is complete. Both evidence chains end in on-time trusted root acceptance. No additional sample was started.
