# Agent Task 生命周期与上下文续接契约

日期：2026-11-02

状态：已确认的目标设计，尚未由运行代码实现。本文补充[目标架构](architecture.md)，是 S2/S3 实现接口和回归测试的设计依据。

## 1. 核心模型

一个四 Core 运行默认拥有四个可工作的 Agent identity。Core 是可复用的物理执行容量；Agent identity 是一个 Pi 进程/Session 身份。两者不是同一个领域对象：Core 可以先后承载多个 identity，identity 也可以在同一 Core 上连续认领多个 Task。

Agent identity 在开展任何新的研究工作前都必须通过 Task Service 登记或认领一个 Task。它可以：

1. 登记一个完整、独立且足够有意义的 Task；
2. 立即自己认领并执行；
3. 将 Task 留在 `OPEN` 队列，交给其他 Agent identity 认领；
4. 完成、交接、阻塞或释放当前 Execution 后，再查看队列并认领下一项工作。

不能为了占用 Core 创建微任务、纯搬运任务、重复任务或没有独立交付物的任务。Task 提案应说明为什么这份工作值得另一个 Agent/Core 协助；服务只校验合同和引用，不在线判断数学路线价值。

初始 Mission 只登记用户目标和一个最小普通求解入口，不预设领域研究路线或固定数量的 Task。

## 2. Agent-facing 的最小接口

Agent 不直接管理 Core、lease、fencing、Pi 进程或 Workspace 路径。Task/Runtime 模块在 Agent-facing seam 上提供少量深接口：

- `task_status`：返回权威的 `open_task_count`、`claimable_task_count`、`idle_core_count`、`active_core_count`，以及带分页信息的可认领 Task；计数不能从截断列表推算。
- `task_register`：登记一个 Task。核心合同为 `goal`、`expected_output`、`acceptance_conditions` 和 `collaboration_reason`；Mission、Agent identity 和当前上下文由服务/Runtime补齐。
- `task_take`：Agent 指定 Task 后主动认领。服务内部原子完成资格检查、Execution 建立、空闲 Core 分配和工作上下文准备，返回当前 Task/Execution/Agent context。
- `execution_progress`：保存当前进度。`kind=checkpoint` 时继续当前 Execution；`kind=handoff` 时保存接续材料、fence 当前 Execution 并将未完成 Task 放回队列。
- `task_complete`：在自身合同满足后完成 Task。

工具说明必须明确给出调用顺序、适用角色、成功返回值、版本冲突、容量不足和 Task 已被其他 Agent 认领时的处理方式。兼容旧名不能恢复 Daemon 替 Agent 选择工作的语义。

## 3. Task、Execution 和 Agent Session

- **Task** 是持久化责任，必须先登记才能开展新的独立工作。
- **Execution** 是一个 Agent identity 对一个 Task 的一次限时执行授权。
- **Agent identity** 是一个可轮换的 Pi 进程/Session 身份，可以连续认领多个 Execution，但同一时刻只拥有一个有效 Execution。
- **Core** 只表示当前执行容量，不拥有 Task 责任。
- **Agent Session rotation** 是结束一个 Pi Session 并启动新的 Pi Session；它不自动创建 Task，也不代表新增并行。

一个 Execution 的时间盒是可配置的实验参数，第一阶段默认可以从约 30 分钟开始。时间盒到期而责任未完成时，Agent 必须先保存 Handoff Material，再释放执行权。换人不会重置 Task 的累计消耗、总预算或已发生的 Execution 事实。

## 4. Progress Material、Checkpoint 与 Handoff

当前实现的 checkpoint 只在 Execution 上保存引用和哈希，实际内容依赖 Workspace 文件，既不会自动形成 Material，也不能支持没有 Workspace 的研究 Task。这不满足长期 Agent 的上下文续接要求。

目标接口使用同一种进度材料格式：

```text
Progress Material
  completed_work     已完成的工作
  findings           已确认的事实、结果或失败路线
  open_questions     尚未解决的问题
  next_step          后续执行者可以直接采取的步骤
  workspace_lineage  当前 Git commit、branch/worktree 和变更摘要
```

`checkpoint` 和 `handoff` 共享上述内容格式，但生命周期语义不同：

- **Checkpoint Material**：可在同一 Execution 内反复保存；自动链接到当前 Task 和 Execution，Execution 继续运行。
- **Handoff Material**：是最后一个接续检查点；必须保留 Workspace 状态和下一步，之后 Runtime 撤销旧 Execution 的写入资格并释放 Core，Task 回到可认领状态。

`execution_progress` 由 Runtime/Context 内部完成 Material 创建、来源记录、Task 链接、Execution 指针更新和内容哈希。Agent 不需要分别调用“发布材料、链接 Task、保存 checkpoint、提交 Workspace”四个低层接口。

## 5. Compaction 与 identity 轮换

Transcript 不是长期权威记忆。Runtime 应将 Pi compaction 视为需要重新保存进度的信号，而不是无限依赖模型摘要：

```text
compaction_end
  → 等待当前 Agent turn settled
  → Runtime 排队一个 follow-up
  → Agent 调用 execution_progress(kind=checkpoint)
  → 继续当前工作，或按 identity 预算执行 handoff
```

Runtime 不得在当前 Agent turn 尚未结束时并发发送 follow-up。Checkpoint follow-up 必须明确要求 Agent 记录已完成工作、关键发现、开放问题、下一步和当前 Workspace lineage。

每个 Agent identity 有独立的 compaction 预算。累计次数达到配置上限后，identity 不再继续长期积累上下文；若最近一次 compaction 前的 token window 使用率达到配置阈值（第一阶段可从 80% 开始），Runtime 要求 Agent 产生 Handoff Material 并结束该 identity 的 Pi Session。

新的 Agent identity 可以在任意可用 Core 上认领该 Task。若 Task 未完成，它读取 Handoff Material 和 Git commit 后继续；这是真实的 identity handoff，不得记录为自然并行或简单 Session retry。Task、Execution、Agent identity、compaction 次数和轮换原因都必须进入观测记录。

## 6. Git Workspace lineage

Workspace 不再使用“每次从空目录启动”的默认语义。Workspace 的持久状态由 Git commit/ref 和 Runtime 元数据共同表达：

1. Runtime 为需要文件工作的 Execution 创建独立 Git worktree；
2. worktree 从 Task 指定的输入 commit 或上一次有效 Handoff commit 建立；
3. Agent 在当前 worktree 中修改文件；
4. Checkpoint 可以保存当前 commit，Handoff 必须产生可恢复的 commit 或明确记录无法提交的原因；
5. 新 Execution 从精确的 commit 创建新的 worktree，不直接接管旧目录；
6. 一个 Task 同时只有一个有效写入者，禁止多个 Execution 共享可变 worktree；
7. 不自动修改项目主分支，跨 Task 合并通过版本化 Material 和明确的集成操作表达。

Workspace Manager 应实现 Git worktree/commit Adapter。第一阶段不保留非 Git fallback；不满足 Git 工作区要求的部署组合必须在启动前拒绝。`.swarm` 运行元数据和 checkpoint Material 不得把原始 Agent transcript 或凭据提交到项目仓库。

## 7. 实现归属

- S2：Agent identity 的主动发现、Task 登记、状态查看、主动 `task_take`、容量原子性、Execution 时间盒和 Core 利用率观测。
- S3：Progress Material、compaction follow-up、identity handoff、Git Workspace lineage、恢复和多接收者反馈。
- `CoreDaemon` 的旧选择回路只保留为历史实现证据，不作为目标架构；Runtime 仍负责物理 Core、Pi 进程、lease、fencing 和 Workspace 生命周期。

本设计不要求 Agent 知道 Git 命令、数据库字段或 Runtime 内部状态机。工具 schema、提示说明、Bridge、SDK、Task Service、Runtime、Workspace Manager、报告和测试必须共同实现同一接口语义。
