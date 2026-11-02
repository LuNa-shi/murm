# Task-oriented Swarm：第一阶段目标架构

状态：**设计基线草案，待本 PR 审阅合并**。本文由两篇 Notion 讨论整理，并纳入后续关于 Judge 与第一阶段范围的明确修正。它规定目标行为，不宣称当前代码已完成；差距见 [实现状态](implementation-status.md)。项目约束的权威定义在 [AGENTS.md](../AGENTS.md)。

## 1. 系统边界与基本对象

用户提供原题、初始材料、工具环境与资源上限。Agent 自主决定具体研究方向，公共服务保存工作责任与证据。Mission 为这些工作提供共同目标及最终验收范围；它不需要一个永久负责所有分工和审批的主 Agent。

Task 保存一份明确责任，Execution 记录某次执行，Material 保留成果。Core 是可复用的物理执行容量，Agent identity 是可轮换的 Pi 进程/Session 身份；四 Core 默认对应四个可工作的 Agent identity，但 Core 与 identity 不绑定为永久关系。每个 Agent identity 可以顺序认领多个 Execution，同一时刻每个 Task 只有一个有效写入者。不同路线、可独立处理的引理和明确的独立验证使用不同的普通 Task，创建者不会因此获得对方的管理权。

任务说明应使接手者理解：已有何种依据，当前问题是什么，工作范围止于哪里，什么结果可以交付。结果可以是证明、可检查的反例或有证据的路线否定。Task 完成不等于原题已解决。

创建来源、真实前置依赖和材料使用关系分别表达。需要多个引理共同成立或存在竞争路线时，可先用版本化路线说明与引用展示 AND/OR 含义，不恢复父任务审批树。

## 2. 从输入开始形成工作

默认启动登记用户目标，产生最小的普通求解入口，不预设研究路线。Agent 在开展任何新的独立工作前，必须先向 Task Service 登记一个完整 Task；它可以立即自己认领，也可以将 Task 留在 `OPEN` 队列交给其他 Agent。Task 必须有独立问题、交付物、验收条件，并说明为什么需要另一个 Agent/Core 协助；微任务、纯搬运、重复工作和空材料不应进入队列。

Agent-facing 的核心循环是 `task_status → task_register → task_take（或留在队列）→ 执行 → execution_progress → 完成/交接/阻塞 → 再次 task_status`。`task_status` 返回权威的开放任务数、可认领任务数、空闲 Core 数和分页候选；`task_take` 内部完成资格校验、Execution 建立、Core 分配和工作上下文准备。Agent 不直接管理 Core、lease、fencing、Pi 进程或 Workspace 路径。

提案先检索已有摘要和 Material，说明与现有覆盖的差异；是否有研究价值由 Agent 判断，服务仅保证合同、引用、权限、版本和资源合法。不能用精确字符串、摘要长度或任务数量冒充语义去重。完整接口与身份轮换见[Agent Task运行契约](20261102-agent-task-runtime-contract.md)。

供给不足时可以有限重新观察，但系统只能触发通用观察责任，不能填写新的数学任务。相同状态版本不重复触发，检查自己的完成不触发自身，预算耗尽或判断无可行方向时允许停止。启动数量、Execution 窗口、compaction 上限和触发阈值都是显式策略配置，不承诺始终填满 Core。

## 3. 每个执行者的局部循环

一个 Agent identity 可以顺序工作于多个 Task，但同一时刻只持有一个有效 Execution：

```text
查看权威队列和容量
  → 登记一个足够完整且需要协作的 Task
  → 自己 task_take，或将 Task 留在 OPEN 队列
  → 读取 Task、Material、Feedback 和可选 Git Workspace lineage
  → 研究、调用工具或进行局部验证
  → 在 compaction 后或阶段性完成时保存 Progress Material checkpoint
  → 继续当前研究，同时提出独立 Task 或向相关 Task 反馈
  → 完成、handoff、因真实条件阻塞，或有依据地停止
  → 释放当前 Execution 后再次查看队列
```

Agent Session 不是长期权威记忆。达到 compaction 预算或上下文压力阈值后，Runtime 在安全点要求 Handoff Material，结束当前 Pi Session，并由新的 Agent identity 从 checkpoint、Material 和 Git commit 继续。

这些循环异步进行。Agent A 发布引理后可以继续研究；B 无须等 A 完成即可使用；B 的新发现也可以在 A 尚未结束时返回。

新增 Task 表达并行分工；反馈改变正在进行的工作；handoff 接续同一责任。不得用定时轮换 Execution 代替并行研究。

## 4. Judge 的检查循环与最终完成

Judge 是工具可调用的外部能力。Agent 可以将当前文件或内容提交检查，获得结果并继续修改。工具内部可以保存不可变输入快照、来源与 CheckResult；不要求 Agent 手工创建检查 Task、发布多份 Material 或完成消费者验收仪式。

```text
Execution E：编写 V1 → check(V1) → FAIL 与诊断
             → 修改为 V2 → check(V2) → 返回新结果
```

失败不自动创建 follow-up Task，不触发强制 handoff，也不阻止下一次合法检查。服务故障单独报告；限流、超时和预算属于资源保护，不得伪装成研究路线门禁。长检查可以采用异步请求和可恢复结果获取；检查任务的排队对象是工具请求，不是新的领域 Task。

每份结果绑定检查目标、实际内容哈希、环境/检查器版本和生产来源。并发请求或晚到结果不能覆盖较新版本的状态。局部编译与引理检查保留各自范围，不能计成整题候选 PASS。

完整原题候选可以由任何符合权限和合同的 Task 提交。最终验收读取原题与指定版本的有效检查依据，不依赖固定 root Task ID。检查通过后仍可继续研究；将一次交付声明为完成时，Task/验收边界核对所引用的证据。不得为证明系统成功而修改 fixture、题目或 checker。

## 5. Material、交付和知识修正

Material 保存具体结论、适用条件、证据来源和版本。一份成果可以支持自己的下一次 Execution，也可以被多个其他任务使用。内容不因接收者不同而重复复制。

发布、读取、使用和有效性分开记录。各接收者可以分别接受、质疑或请求补充同一结果；生产者完成自己的责任不等于所有接收者已经接受。现有 `CLOSED` 语义的迁移在 S3 中显式处理，禁止静默改写历史记录。

错误或过时结论保留原版本，以新的反例/修正关联到它。通知实际使用者或订阅者，不要求所有 Agent 阅读全部历史。第一阶段只提供可操作的引用与反馈路径，不建设全局共识算法、语义向量检索或自动材料价值评分。

## 6. 运行中的任务调整

反馈以 Task 为持久收件对象，当前 Execution 仅是投递位置。研究消息跨执行保留，截止时间提醒随对应执行失效。传输完成、明确处理和后续行为不是同一个事实。

普通补充信息有序排队；影响当前假设的纠正应在约定安全点进入执行。执行者核对证据后，可以修改自己的方法、验证质疑或说明不适用。若交付范围发生实质变化，第一阶段优先显式结束/取消原责任并关联后续 Task；不要求先实现任意在线合同编辑。

同伴有权提出证据和建议，无权据此任意取消他人研究。当前责任方和显式授权的运行规则执行变更。取消或预算撤销生效时，Runtime 撤销执行权；晚到写入和过期提交不得进入有效状态。

没有当前执行者时，待处理反馈留在 Task，下一次接手先读取。若服务/进程失败，恢复必须保留这些信息，而非依赖已消失的 Session。

## 7. 接续、时间窗口与资源

Task 的累计投入跨 Execution 保存。Execution 时间盒限制单次运行，第一阶段可从约 30 分钟开始，实际值必须登记并同步计算提醒提前量。一个 Agent identity 可以认领和释放多个 Execution；identity 的 compaction 次数另行累计，达到上限后应保存 Handoff Material 并轮换 Pi Session。新 identity 可以使用任意可用 Core 接续同一 Task，必须明确记录 identity、Session generation、Execution 前驱和轮换原因。

模型与工具的小范围重试不产生新的研究责任。旧 Session 已终止后重新启动研究时，应明确新的 identity 和执行尝试及其前驱，避免多个独立 Session 被展示为同一次连续研究。

自愿交接保存已做工作、有效成果、开放问题、下一步和 Git Workspace commit 引用。Checkpoint 是当前 Execution 内的可重复进度材料；Handoff 是最后一个接续材料，会 fence 旧 Execution 并释放 Core。强制超时可能没有完整交接材料；系统如实记录缺失和最后持久化状态，不能伪造成功 handoff。Workspace 不再从空目录默认开始，需要文件工作的 Execution 从明确的输入或上一次 Handoff commit 创建独立 Git worktree。

资源区分总消耗上限、Task 累计账目、当前 Execution 授权与在制数量。完成/取消释放在制名额，已经消耗的成本不归零。创建与完成在同一权威服务上实现一致的准入，不能仅依赖 runner 的内存计数。可观测不到的 token 项标记未知；第一阶段可先可靠限制时间和调用授权，不声称实现未经验证的精确费用预留。

长期责任不等于持续占用 Core。缺少真实前置结果时记录 blocker；无值得继续的方向时结束或取消责任并保留结论；不要虚构依赖或无限续跑来保持 RUNNING。高级续期和抢占策略不在本阶段。

## 8. 一致性、完成与收束

目标架构不再让 Core Daemon 替 Agent 做语义选择。Runtime 仍可作为物理进程和 Core 生命周期管理器，但 Agent 必须能直接读取队列/容量、登记 Task 并主动认领；旧 Selection Agent/Daemon 回路属于待移除的实现路径。

Agent 工具、认领、Runtime 和报告使用同一 Task 权威状态。不支持的部署组合在启动前失败。已认领工作应能完成、交接、阻塞或取消，并在物理清理结束后释放 Core。旧执行权与新执行权不能重叠。

队列为空时仍需检查运行中工作、在途工具结果和待处理反馈。有资源且存在新的观察依据时，可进行一次有限重新观察；没有可执行方向则记录当前停止原因。原题 PASS、预算耗尽、外部不可用和当前搜索停滞分别报告。

成功或预算终止后不再接纳普通新工作，收束资源保存真实已有成果。清理产生的终态必须带原因，不能把实验结束时的取消都解释成研究失败。

## 9. 组件职责与第一阶段实施

| 边界 | 必须保证 | 不应承担 |
| --- | --- | --- |
| Task/资源服务 | 责任、版本、准入、有效认领及累计使用一致 | 判断数学路线的价值、预设研究分工 |
| Runtime | Session/Workspace 启停、反馈投递、恢复、fencing | 把每次失败变成另一项研究任务 |
| Context | 保存成果、来源与使用/修正引用 | 用读取率或发布数量宣布团队共识 |
| Judge | 对指定版本返回检查结果与诊断 | 生成 follow-up、强制消费 Response 后才重试 |
| Agent | 提案、研究、使用结果、解释反馈并调整工作 | 绕过资源授权或降低原题验收标准 |
| Benchmark/报告 | 锁定输入、预算、结果与观测证据 | 为通过指标偷偷改变提示或协作路径 |

上述是逻辑职责，不要求新增六个部署服务。Runtime 内部可以保留物理 Core/进程监督，但不得继续让 Daemon 或独立 Selection Session 替 Agent 做语义选择；替代实现须遵守相同的任务和权限约定。

本阶段由 [三个完整 Issue](plans/phase-1/README.md) 完成：S1 检查迭代，S2 自主持续分工，S3 反馈与接续。先取得行为正确的真实运行，再研究更优 prompting、任务价值与大规模调度。

## 来源与决策边界

来源是 Notion 的《目标架构》及《架构复盘》，以及本轮用户关于 Judge、禁止领域硬编码、第一阶段范围和两小时验收的修正。未经决定的方案保留为提议：通用重新观察入口的具体触发、单次窗口时长、队列容量和紧急反馈上限。它们在各 Issue 启动前冻结，不能由 coding agent 在实现过程中擅自改变。

原始页面：[目标架构](https://app.notion.com/p/40b4e07aa023819e9c19f077205f8cd5)、[架构复盘](https://app.notion.com/p/40b4e07aa023818f97ade56d43c32c8f)。已确认的四 Core/Agent identity、Progress Material、compaction 轮换和 Git Workspace 细节见[Agent Task运行契约](20261102-agent-task-runtime-contract.md)。本文是为仓库重组的规范草稿，不是逐字导出；私人写作语料未迁入仓库。
