# r12 协作问题分类与修复范围

来源：`issue-113-2h-20261104-r12-finalization`（运行提交 `b494af4`，本地证据在忽略的 `experiments/` 下）。本文只依据 state 库、Runtime/Agent/Service 日志与当前代码，不改变设计规范。

## 分类方法

按"先排除系统责任，再归因 Agent"的顺序判定，前一类未排除时不得归入后一类。

| 类别 | 判定 | 证据要求 |
|---|---|---|
| 一：实现问题 | 规范（AGENTS、运行契约、验收表）有明确规定，代码未照做；结果与模型无关 | 违反的条款、代码位置、可失败的确定性测试 |
| 二：设计不足 | 实现完全符合规范，理想 Agent 仍无法表达或验收所需协作 | 脚本化理想 Agent 被卡住的位置与缺失的 Task/Service 能力 |
| 三：Agent 行为 | 正确路径存在、决策点信息可见、代价合理，Agent 仍选错 | 决策点的可见上下文与错误选择；重复出现 |

## 运行轨迹摘要

- 12:09–12:45：10 个 Execution、2 个 Agent 创建的 Task、6 次 Judge 检查（均 source_failure）。
- 12:45–14:09（84 分钟，约 70% 时长）：无 Execution，4 个 Core 空闲，`operations` 只有 1984 次无效果的 `reconcile_task`。
- 原因链：根 Task（共享 Mission）被最后一个分支以 `dependency:` 置 BLOCKED → 依赖 Task `e563fbf6` 又以 `external:swarmenv_workspace_get` BLOCKED → 该能力实际存在于目录（`runtime.workspace_get`），但 external block 只能显式 reopen。

## 问题清单

### 第一类（本次修复）

| ID | 问题 | 违反条款 | 代码位置 | 验收 |
|---|---|---|---|---|
| R1 | 共享 Mission Task 因最后一个分支的 block 被置 BLOCKED，之后不可认领 | 契约 §1、§3："没有执行者时为OPEN，只要Mission未结束就仍可认领"；P3、P6 | `task-service.js` `#blockTask` 共享分支、`#reconcileTask` | B04、B07 |
| R2 | 共享 Mission 记录的依赖令 `listTasks`/`listClaimableTasks`/`claim`/readiness 全部拒绝该 Task | 同上；契约 §1"全Mission只因成功、预算/时间、授权停止或环境故障收束" | `#dependencyBlockers` 调用点 | B04、B06 |
| R3 | 以 external capability 阻塞时不核对能力目录，已存在的能力被接受为外部阻塞 | P10"受支持部署端到端一致"；P11 工具说明一致性 | `services-bridge.js` task_block 路径 | B06 |
| R4 | 全员空闲时 runner/报告不呈现该状态 | P11"如实表达"；B04 反例"空转轮询" | `putnam-runner.js` 报告投影 | B04 |
| R6 | 共享 Mission 身份按 `created_at, task_id` 判定，同毫秒内创建时取决于随机 UUID，判定不确定 | P10"权威状态一致" | `#isSharedMissionTask` | B04 |
| R7 | `task_status` 的 `counts.claimable` 与 `claimable_tasks` 对共享 Mission 不一致 | P10"筛选、分页和计数如实表达" | `task_status` 计数 SQL、`#listModernTasks` | B06 |
| R8 | flat 模式同时暴露 `swarmenv_task_task_block`/`swarmenv_runtime_task_block` 与两个 complete 工具；Runtime 版 block 的 schema 缺少必需的 `handoff_material_id`（r12 core-1 连续 3 次 `INVALID_CONTRACT`） | P10、P11 工具说明一致性 | `putnam-runner.js` runtimeCapabilities、`runtime-capabilities.js` | B06 |
| R9 | `task_block` 工具说明写"stop as BLOCKED"，与共享 Mission 语义不符 | 契约 §1、§3 | `service-catalog.js`、`runtime-capabilities.js` | B04 |

修复状态（分支 `claude/r12-collaboration-fixes`）：

| ID | 修复 | 回归测试 |
|---|---|---|
| R1 | 共享 Mission 的 block 只结束本 Execution，Task 按存活执行者刷新为 OPEN/RUNNING；`reconcile_task` 修复旧版本遗留的 BLOCKED | `test/shared-mission-block.test.js`（四项） |
| R2 | 新增 `#gatingDependencyBlockers`，共享 Mission 在列表、认领、readiness、reopen、reconcile 中不受依赖门控；依赖仍作为结构记录 | 同上 |
| R3 | `task_block` 在释放 Runtime 前核对能力目录，可调用能力返回 `INVALID_CONTRACT`（`capability_block_admission`），Execution 保持绑定 | `test/services-bridge.test.js` |
| R4 | `CoreParallelismTracker` 输出 `mission_stall_ms`、`mission_stall_ratio`、`mission_stall_intervals`，进入 report.json | `test/parallelism.test.js` |
| R6 | 改为 `ORDER BY created_at, rowid` | `test/task-admission-runtime.test.js`（修复前单独运行 6 次失败 2 次，修复后 12 次 0 失败） |
| R7 | 计数与列表对共享 Mission 采用同一可认领判定 | `test/shared-mission-block.test.js` |
| R8 | flat 模式不再注入 Runtime 的 task_block/task_complete 别名，每个动作只有一个工具 | `test/putnam-runner.test.js`（flat Judge 用例断言工具名唯一）、`test/agent-prompt.test.js` |
| R9 | 两处工具说明改为"普通 Task 变为 BLOCKED；共享 Mission 保持可认领" | 全量测试 |
| A4 | 新增 `taskLoopGuide(profile)`：按当前 profile 的真实工具名列出 查看→认领→工作→检查→共享→保存→结束→下一轮 八步及步间调用，注入 runner 的认领/续轮 prompt 与 `composeAgentPrompt`；不含数量与策略 | `test/agent-prompt.test.js`（所有提到的工具名都必须已注册） |
| A1–A3 | `agent-prompt.js` 补充 block/Judge/能力目录语义（PROMPT_VERSION 4，SYSTEM_PROMPT_VERSION 2）；flat runner 的依赖说明同步 | `test/agent-prompt.test.js`（含无数量指令断言） |

两项旧测试原本断言"Mission 首个 Task 被 block 后为 BLOCKED"，即旧的错误行为；已改为先建共享 Mission，再对普通 Task 断言 BLOCKED。

R5（通知 `delivery_attempts=0`）在 r12 之后已由 `a909a34` 修复（settled 超时改为在 turn 边界重试），本次只确认回归测试存在，不重复修改。

### 第三类（在现有范式内修复：删除误导指令、提供真实接口说明）

| ID | 现象 | 系统侧可修部分 | 不做 |
|---|---|---|---|
| A1 | Agent 以存在的能力名义 block | R3 拒绝后返回可调用能力列表与"直接调用"提示 | 不增加新工具 |
| A2 | 2.5–19 分钟即 handoff，未用满时间盒 | prompt/runner 指令把"real external dependency → task.block 释放 Core"写成默认出口；补充"共享 Mission 上 block 只结束本分支，Mission 仍可认领；创建子任务后可继续研究 Mission" | 不写数量指令，不要求最少运行时长 |
| A4 | prompt 只用 `task.block`、`submit_candidate` 等操作名，Agent 实际看到的是 `swarmenv_*` 工具名，且没有"每一步调用哪个工具"的循环说明；r12 中 submit 后大多直接 handoff | 按 profile 生成任务循环说明（见修复表 A4） | 不规定步骤次数 |
| A3 | 检查少（约 49 次搜索对应 1 次检查） | 工具说明与 prompt 已允许同 Execution 反复检查；补充"候选有实质修改即可提交检查，FAIL 不需要 handoff" | 不设检查次数目标；Judge 延迟待统计后再定是否归第二类 |

### 第二类（只登记，不在本阶段修改规范）

| ID | 假设 | 验证方法 |
|---|---|---|
| D1 | Judge 只认原题命题，子任务交付无法独立验收，削弱分工动机 | 理想 Agent 场景：拆出引理 Task → 交付 → 接收方复核 |
| D2 | `normal_flow` 要求 block 带类型化依赖，使"发现子问题"被表达为"我被阻塞" | 理想 Agent 场景：创建子任务后自己继续 Mission |

## 验收

每个第一类条目对应一个修复前失败、修复后通过的回归测试；第三类条目以 prompt/工具说明的快照测试与理由记录。修复后运行 `npm test` 与 `git diff --check`。真实两小时复验需另行授权。
