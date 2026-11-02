# 第一阶段设计符合性核对表

状态：初次静态核对，未修改运行代码。基线为 `75fca5aa647154a642d676c639c8770d1f7eb90a`。本表补充[架构复盘](task-centric-baseline.md)，用于确保[S1–S3](../plans/phase-1/README.md)覆盖设计偏差。用户此前列举的问题是入口，不是范围上限。

## 核对方法与范围

本次检查主调用链中的 benchmark runner、Task Service、ServicesBridge、capability profile、Context Service、Runtime、Judge Service，以及相关工具/报告约定。代码中的机制缺口与真实运行中的现象分开记录。未取得全部原始实验对话，未启动生产服务或完整测试；因此这是来源可定位的审计初稿，不是全仓库已穷尽的认证。

实施每项 Issue 时，必须继续沿入口、别名和回调搜索同类行为，并用回归场景确认。新发现的确定偏差并入相应 S 项；明确的模型取舍先批准；纯性能和语义策略问题留待后续。每一行最终应具有测试/PR证据或批准的范围说明，不能因为真实运行没有碰到就视为修复。

表中“代码确认”表示代码可直接支持所述行为，不意味着已经在真实实验复现其后果。“待复现”表示需要在固定基线上执行反例。“新约定”表示原设计曾允许该行为，现需明确迁移。

## S1：检查、反馈与最终验收

| ID | 偏差或待核对边界 | 证据与后果 | 处理与验收 |
| --- | --- | --- | --- |
| J1 | Judge失败自动创建领域修复任务；后续提交受Response门禁限制 | 代码确认：runner的judgeCandidate、createFlatFeedbackTask、onBeforeSubmitCandidate | 移除默认副作用及所有别名入口；同一Execution直接失败—修改—重检 |
| J2 | 日常Judge使用取决于Task是否具有required_check合同 | 代码确认：Bridge在modern Task且requiresJudge=false时拒绝submit_candidate/get_check_result | 工具授权与完成合同解耦；研究任务可检查局部目标，最终验收保持严格 |
| J3 | 检查执行依赖runner回调，而服务入口与提交持久化不是完整同一行为 | 代码确认：Bridge在submit_candidate后调用onSubmitCandidate；Judge.dispatch公开路径主要记录/读取结果 | 审计本地、注册服务与HTTP入口；受支持路径都实际检查并返回结构化结果，不只是保存请求 |
| J4 | 整题成功绑定特定rootTaskId | 代码确认：runner的solved判断 | 合法完整候选按原题、内容、环境验收，其他Task也可交付；局部PASS不得完成Mission |
| J5 | 并发、晚到检查与工具错误的行为必须统一 | 已有Judge输入哈希/环境校验应保留；不同入口是否都遵守需回归 | 检查结果只作用于对应版本；服务故障不自动安排研究、不记数学FAIL |

代码：[Bridge](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/agent/services-bridge.js)、[Judge](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/judge/judge-service.js)、[runner](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/benchmark/putnam-runner.js)。J3不要求重新部署微服务；首先确保当前声明支持的配置真实可用。

## S2：任务从提出到认领

| ID | 偏差或待核对边界 | 证据与后果 | 处理与验收 |
| --- | --- | --- | --- |
| T1 | 固定FLAT_RESEARCH_ROUTES和初始研究任务说明 | 代码及实验确认 | 默认仅登记用户目标与通用入口；领域分工由Agent提出，配置中也不藏同类模板 |
| T2 | 动态新增默认2、最大3，完成后不回收 | 代码及实验确认：所有非初始Task累计计数 | 权威服务控制当前在制量；总消耗另计，完成/取消后可继续提出 |
| T3 | 远程创建与本地认领、handoff/block、报告可能分裂 | #107与Bridge本地Runtime分支支持该风险，部署组合需复现 | 同一权威身份覆盖支持的全路径；未支持的组合启动即拒绝 |
| T4 | responsibility_key按Mission内字符串直接返回最早任务，包括已结束任务，未比较新payload | 代码确认：#createModernTask | 相同请求重放幂等；同键不同请求显式冲突或按新明确协议处理，不能静默吞掉新工作 |
| T5 | available_only在LIMIT后过滤，前面的阻塞任务可掩盖后面的可认领工作 | 代码确认：#listModernTasks；是否被当前选择路径调用须测试 | 资格筛选先于有效结果截断，或分页直到填足；报告截断与剩余信息，禁止虚假空队列 |
| T6 | 动态准入从最多500项列表推算总量，缺统一事务边界 | 代码确认：runner.onTaskCreate；上限移除后不能沿用这种计数 | 从权威状态原子计数/预留，重放与重启不绕过；不以列表投影作为额度真相 |
| T7 | spawned_from可省略，创建Execution身份主要在返回值；任务行仅保留可复用actor | 代码确认：#createModernTask只在可选关系写created_by_execution_id | 独立保存每项Agent提案的创建Task/Execution，不把可选来源关系作为唯一审计依据；旧数据未知不伪补 |
| T8 | 后半程缺少持续工作发现入口；当前由 Selection/Core Daemon 负责选择，bound Agent 不能直接查看权威容量并主动登记/认领；完全空队列时只有bound执行者能创建工作 | 前者见实验；后者需结合启动、Agent-facing status、主动 task_register/task_take 和 selection 能力复核 | 四 Core 对应可工作的 Agent identity；Agent 读取 open/claimable/idle-core 状态，登记足够完整且需要协作的 Task，自己认领或留队列；有预算的通用重新观察必须可停止，不让Controller代写数学任务 |

代码：[TaskService](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/task/task-service.js)、[runner](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/benchmark/putnam-runner.js)、[Bridge](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/agent/services-bridge.js)、[现存#107](https://github.com/LuNa-shi/SwarmEnv/issues/107)。T5是返回语义正确性问题；不包含大规模索引优化。主动 Agent、Progress Material、compaction 轮换和 Git Workspace 的目标接口见[Agent Task运行契约](../20261102-agent-task-runtime-contract.md)。

## S3：成果、更新和接续

| ID | 偏差或待核对边界 | 证据与后果 | 处理与验收 |
| --- | --- | --- | --- |
| F1 | delivered即不再进入pending，缺独立处理状态 | 代码确认：markNotificationDelivered/listPendingNotifications；Runtime在prompt返回后标投递 | 已投递未处理研究反馈可跨Execution继续处理，记录决定及后续动作 |
| F2 | 旧Execution终止后，pending查询可将其未投递截止提醒带给新Execution | 代码确认：查询按旧Execution终态放行，未区分notification_type；真实误投待复现 | 截止提醒随执行失效，研究反馈可重定向，两者分别测试 |
| F3 | 活跃投递失败只在所读路径记录日志，重试/重启效果待验证 | Runtime.#deliverNotification；不能仅据catch断言所有路径均丢消息 | 沿重试、重放、重启验证持久投递；无重复语义动作，失败可见 |
| F4 | 只有材料到达提示，缺同伴请求调整、处理决定及授权取消的完整协议 | 现代Task操作表与Runtime通知路径确认 | 当前执行内响应；权限、变更版本和取消后旧写入一致 |
| F5 | Material全局role必须与link.role一致，且同一Task新Execution引用旧产物时仍走生产者身份检查 | 代码确认：#linkMaterial；实际被阻断的复用途径需回归 | 内容来源保持不可变，引用用途可不同；接手者引用旧材料不冒充生产者、不强迫复制 |
| F6 | 生产Task一旦CLOSED，后续接收者close直接返回，未更新其接受记录 | 代码确认：#closeTask；属于旧约定需迁移 | 每个接收关系独立记录结果，不以全局CLOSED代表所有消费者 |
| F7 | timebox约束每次Execution，Task总投入和多次接续身份不清晰 | Runtime计时、claim的attempt_no默认1、recover复用ID及报告确认 | 统一Task内连续执行和累计资源；历史Session/ID按原事实解释 |
| F8 | 短窗口提醒可只提前约1毫秒 | Runtime.#executionTimingPayload确认 | 提前量随窗口合法计算；区分有效handoff与到期强制清理 |
| F9 | depends_on仅以DONE/CLOSED判满足；前置任务取消后缺替代/放弃处理的明确约定 | #modernDependencySatisfied确认，活性后果待场景验证 | 通知依赖方并给出明确修改/取消选择，不把取消当成功；无永久无解释阻塞 |
| F10 | 材料计数、自用检查点及Execution窗口标签掩盖真实研究连续性 | 固定实验报告及#107确认 | Task主线组织；接续、跨任务使用和反馈变化有实质证据，缺失标unknown |

代码：[TaskService](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/task/task-service.js)、[Runtime](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/runtime/runtime.js)、[Context](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/context/context-service.js)、[真实报告](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/docs/experiments/exp-20261031-putnam_2025_b1-flat-dynamic-2h-fc15f2e-r1/analysis/experiment-analysis.md)。

## 已有能力与暂不优化的内容

不要把所有旧代码都当作错误。当前capability profile已有legacy surface过滤；Task创建已有同Mission检查、依赖环检查；Judge已有输入/环境校验；handoff已有来源检查与fencing；未投递研究消息在旧Execution结束后已有转投条件。修复应保留这些保障并补缺口。[capability profile](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/agent/capability-profile.js)

摘要全文匹配是否足够好、全量扫描性能、最优分工粒度、30分钟是否最优、材料价值评分与自动争议判断均不在本阶段深入优化。先修返回错误、身份错配、协议缺失和确定违例。必要的通用工具指引更新属于接口一致性，不授权开展prompt搜索。

## 每个Issue合并前的审计结果

逐行标记已修复、未复现、保留且给出规范依据，或经批准延期；同时链接具体回归与真实实验中的相关证据。已确认且在本阶段范围内的原则违例不得仅以指标达标为由关闭。真实实验验证整条行为改善，不要求所有罕见竞态在同一次两小时运行中自然发生，竞态仍需可重复的回归挑战。
