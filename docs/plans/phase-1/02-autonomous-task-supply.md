# S2｜从自主提案到持续执行形成完整分工

状态：Issue草案，未发布。依赖：S1作为验收前置。规范：P1–P3、P6–P7、P10–P11。负责[核对表](../../reviews/phase-1-conformance-audit.md)T1–T8及新增同类偏差。目标接口见[Agent Task运行契约](../../20261102-agent-task-runtime-contract.md)。

## 交付行为

四个 Core 默认对应四个可工作的 Agent identity。每个 Agent 在开展新的独立工作前必须向 Task Service 登记 Task；登记后可以自己认领，也可以留在 `OPEN` 队列交给其他 Agent。一个 Agent identity 可以顺序认领和释放多个 Execution，但同一时刻只持有一个有效 Execution。Agent 应能看见权威的开放任务数、可认领任务数和空闲 Core 数，并主动选择是否提出或认领工作。

Task 必须有独立问题、交付边界、预期结果、验收条件和协作理由。任务不能是微任务、纯搬运、改名重复或空材料。系统鼓励 Agent 在发现真正需要并行协助的工作时尽早登记，而不是为了保持单个长任务运行而独立耗尽时间。

## 为什么是一个 Issue

移除初始模板不能独自交付自主分工：准入、重放、任务列表、主动认领和 Runtime 资源分配可能继续阻止工作。统一服务身份也不能只修 `task_register`，后续 `task_take`、handoff/block、Workspace lineage 和报告必须仍指向同一对象。上述内容按完整路径验收，不另拆基础设施小票。

## 必须完成的修复

默认移除固定研究方向及任务级解题提示，保留最小普通求解入口和明确的通用工具说明。Agent-facing 工具应形成小而深的循环：

```text
task_status → task_register → task_take（或留在队列）
  → Execution 工作 → execution_progress → complete/handoff/block
  → 再次 task_status
```

`task_status` 返回权威的 `open_task_count`、`claimable_task_count`、`idle_core_count`、`active_core_count` 和分页候选；不能从截断列表推算数量。`task_register` 只要求目标、交付物、验收条件和协作理由；服务默认填充其余调度字段。`task_take` 原子完成资格检查、Execution 建立、空闲 Core 分配和工作上下文准备；Agent 不直接管理 Core、lease、fencing 或 Workspace 路径。没有任务时可以进行有预算、可停止的通用重新观察，但系统不得代写数学任务。

用权威服务上的在制上限和总资源控制替换累计新增2/3限制；完成/取消/交接释放名额，消耗不返还。请求重放保持幂等，同键不同内容不能静默复用旧任务。修正 available-only 筛选与截断次序，保留完整提案来源和 Agent identity/Execution provenance。所有支持配置的 Task Service、Registry、Bridge、SDK、Runtime、报告和 Agent capability profile 必须使用同一身份和 Task 语义。

每个 Execution 的时间盒是可登记的实验参数，第一阶段可从约 30 分钟开始。Agent identity 可以在多个 Execution 间复用；compaction 次数在 identity 上累计。达到 identity 的 compaction 上限并出现高上下文压力时，Runtime 必须要求 Progress/Handoff Material，结束当前 Pi Session，由新 identity 接续。需要文件工作的 Execution 使用 Git worktree 和 commit lineage；不支持 Git 的部署组合在启动前拒绝。

## 两小时真实验收

S1 clean合并实现与S2处理实现做匹配对照；保持题目、模型、工具环境、4 Core与预算一致，启动/准入是明确允许的处理差异。

不再把固定 Task 数量、固定后半程分钟数或固定 50% 改善率作为硬门槛。实验前应根据直接父实现记录基线，并登记目标区间或方向性目标，至少观察：

- **有效 Task 率**：非重复、非微任务、实际进入 Execution 并产生可审阅成果的 Task 比例；
- **有效并行率**：不同有效 Task 的 Execution 实际研究区间重叠情况；
- **有效 Core 利用率**：有效研究执行时间占可用 Core 时间的比例；
- **机会调整后的空闲率**：存在合格可认领工作时仍未执行的 Core 时间。

只有在有效 Task 质量和独立性成立时，Core 利用率才算正向信号。没有足够可拆分工作时，低利用率不能单独判失败；为了提高利用率创建微任务则属于失败。目标区间必须事前登记，不能向 Agent 暴露为数量指令，也不能看完结果后修改。

对照与处理均报告原始容量、Task 提案、认领、Execution 重叠、有效成果、总成本和未观测项。供给停滞只在存在具体、可独立执行的合格工作证据而系统没有及时准入或执行时记录；单纯 Core 空闲不等于供给停滞。

## 回归与关闭条件

测试完整 `task_status → task_register → task_take → Execution` 路径、完成/交接释放额度后继续工作、并发准入、同请求重放和同键不同请求、阻塞记录挤在列表前部、来源与 Agent identity/Execution 身份保留、远程一致或启动拒绝，以及供给检查无自激发。补充测试 Execution 时间盒、identity compaction 预算、compaction 后 checkpoint follow-up、handoff 后新 identity 接续和 Git commit/worktree lineage。

T1–T8与新增同类偏差完成核对，匹配运行显示有效 Task、真实独立执行和机会调整后的并行改善，才能关闭。实际提案不足时要诊断，不以删掉模板或提高 Core 占用率宣布自主形成成功。新算法、prompt 搜索、语义去重、中心 LLM 审批和固定 N–2N 任务下限均不做。
