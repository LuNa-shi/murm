# Issue 30：显式 claim 修复后的真实 targeted rerun

## 运行范围

在 PR #32 的 commit `405c81975495b983a611381cfde93d667c75e4be` 上重新运行此前暴露调度问题的两个题目：

- `putnam_2024_b4`
- `putnam_2025_b4`

两题都使用 4 个可复用 Core、单项目并行、10 分钟 timebox、`openai/gpt-6-luna`，PutnamBench commit、Lean toolchain 和 Mathlib 版本与原实验保持一致。实验报告分别位于本地的 `reports/issue-30-targeted-20261022/`；原始 Agent transcript 和 proof contents 没有导出。

## 验收结果

本次验收关注 Task list、显式 `claim`、Execution handoff、普通 Tool Error 和清理生命周期，不把十分钟内是否解出数学题当作调度修复的 hard gate。

| 项目 | `protocol_valid` | 强进展 | `claim_conflict_count` | `ready_work_ms` | `ready_unassigned_ms` | 结果 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 2024 B4 | true | 1 child、1 child claim、1 root claim、Workspace/Material/candidate 活动 | 2 | 92,723 | 72,690 | 调度链路通过；题目未解出 |
| 2025 B4 | true | 2 child claim、1 candidate、2 wait、Root/Child 协作 | 2 | 220,614 | 190,489 | 调度链路通过；Judge FAIL，题目未解出 |

两题的冲突都没有再形成旧实验中的重复 claim 风暴。2024 B4 的两次冲突是多个 Core 在启动阶段同时选择 Root；之后 Root 和 Child 各自只成功 claim 一次。2025 B4 的两次冲突分别是启动阶段争抢 Root，以及一个 Core 根据旧列表快照选择已经被另一个 Core claim 的 Child；冲突后它重新选择另一个 Child 并成功 claim。原始 bridge 日志显示没有继续重复尝试同一个已占用 Child。

这验证了本 PR 修复的具体行为：一个返工或新建 Task 在未被领取时会出现在 `list_tasks(available_only=true)`；显式 claim 成功并且 Execution 租约有效后，它不会继续作为可领取 Task 返回；两个 Worker 使用旧列表同时竞争时，失败方收到普通 `CONFLICT` feedback，而不会使实验 invalid。

两题最终都 `invalid=false`，没有 protocol error，也没有发现 Task 处于 `RUNNING` 而唯一 Execution 停在 `CREATED` 的旧交接状态。实验结束时的未完成 Execution 被正常清理为 `FAILED`，未发现 benchmark runner 或 Agent/NuRouter 子进程残留；本地持续存在的 Observability daemon 是报告查询服务，不属于实验 Worker。

## 尚未解决的问题

真实运行仍然没有在十分钟内得到 PASS。2024 B4 产生了研究和候选尝试但没有形成可检查证明；2025 B4 产生了 Child、候选和 Judge FAIL，Root 最后仍在等待未完成的 Child。这个结果说明 Agent 协作链路在工作，但还不能证明协作已经缩短到 PASS 的时间。

`ready_unassigned_ms` 仍然偏高，尤其是 2025 B4 占可用工作时间的大部分。这部分已经不再主要表现为“已占用任务被错误地反复列出”，而是 Core 进行 discovery、长 Agent turn、等待父子任务依赖和题目路线探索时，没有及时形成下一次有效 claim。它应作为后续 Issue 处理，重点观察 discovery turn 时长、任务从出现到成功 claim 的延迟、旧列表快照造成的单次竞争，以及等待结束后的 Core 唤醒。

`eligible_window_ms` 两题仍为 0，原因是同时存在的独立可运行子任务不足以填满四个 Core；它是工作供给诊断，不是本 PR 的失败条件。两题也都没有证明 Swarm 相对 root-only Agent 的 time-to-pass 优势，后续需要单独的配对 baseline。
