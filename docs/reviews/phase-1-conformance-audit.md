# 第一阶段设计符合性核对表

代码证据基线仍为`75fca5aa647154a642d676c639c8770d1f7eb90a`，未修改运行实现。本表保留原23项审计事实，处理方案按用户最新决定更新：不设任务数量上限；共享Mission允许多Execution；认领复用identity自身Core；Git保存失败可以放弃本次未保存状态。新功能覆盖另见[行为表](../validation/20261102-phase-1-behavior-acceptance.md)，不能把新目标伪称为旧运行已经发生的缺陷。

## 核对方式

本表来自runner、Task Service、Bridge、capability profile、Context、Runtime和Judge主调用链的静态核对及已有脱敏报告。没有全量原始研究内容，也没有运行生产服务；不构成全仓库已穷尽审计。代码确认只表示所述路径可被代码支持，待复现风险还需实际反例；新约定表示需要显式迁移。

实现各Issue继续查入口/别名/回调/配置/提示和测试。已确认的阶段内违例必须处理；潜在问题不能凭两小时未出现就自动关闭，也不能为了修复夹带prompt、语义去重或高级调度优化。

## S1：检查、诊断与最终验收

| ID | 原有边界与证据 | 本轮处理 |
| --- | --- | --- |
| J1 | 代码确认：runner的judgeCandidate/createFlatFeedbackTask/onBeforeSubmitCandidate在FAIL后创建修复Task并门禁重试 | 删除所有默认副作用和同类别名；当前Execution直接修改与重检 |
| J2 | 代码确认：Bridge在modern Task且requiresJudge=false时拒绝检查/读取结果 | 日常工具权限与完成合同分开；局部与最终检查范围保持明确 |
| J3 | Bridge提交后依赖onSubmitCandidate，Judge.dispatch主要记录/读取结果；不同入口完整性待回归 | 支持路径都执行检查并返回实际诊断，不只是保存请求；不要求重建部署架构 |
| J4 | 代码确认：runner以rootTaskId判断整题成功 | 任一有权限的Task/Execution可提交完整候选，仍按原题、内容和环境验收 |
| J5 | Judge已有哈希/环境校验；并发晚到结果与异常在不同入口的一致性需验证 | 保留版本安全；服务失败不记数学FAIL、不自动安排研究 |

来源：[Bridge](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/agent/services-bridge.js)、[Judge](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/judge/judge-service.js)、[runner](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/benchmark/putnam-runner.js)。对应A01–A05。

## S2：提出、主动认领与继续工作

| ID | 原有边界与证据 | 本轮处理 |
| --- | --- | --- |
| T1 | 代码/实验确认：固定FLAT_RESEARCH_ROUTES和初始任务指令 | 启动共享Mission，不预设领域方向；普通分工由Agent研究后提出 |
| T2 | 代码/实验确认：动态新增默认2、最大3，完成后累计数不下降 | 删除该限制，不替换为在制/OPEN cap，不做名额回收；handoff后责任仍未完成 |
| T3 | #107和Bridge本地Runtime分支提示远程创建/本地认领及报告分裂风险 | 支持配置共享同一权威身份，全路径验证；不支持配置启动拒绝 |
| T4 | 代码确认：responsibility_key直接返回同Mission最早Task，未比较新payload | 同请求幂等，同键不同请求报冲突，不能静默吞掉新工作 |
| T5 | 代码确认：available_only在LIMIT之后，前面阻塞Task可掩盖后续可用Task | 修正筛选/分页，返回完整性信息，禁止假空队列；不扩展索引优化 |
| T6 | 代码确认：runner.onTaskCreate从最多500项列表推算任务额度 | 删除基于数量的拒绝逻辑；权威计数仅作状态/观察，禁止从截断列表推算，不再建设额度事务 |
| T7 | 代码确认：创建Execution来源主要在返回值或可选spawned_from关系 | 独立持久化真实创建identity/Task/Execution；旧数据未知不伪补 |
| T8 | 当前Selection/CoreDaemon选择路径与后半程供给缩减；主动worker差距需结合具体路径复核 | identity自己查看/登记/认领；复用自己的Core；无普通Task继续共享Mission，删除额外中央供给planner需求 |

来源：[TaskService](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/task/task-service.js)、[runner](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/benchmark/putnam-runner.js)、[Bridge](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/agent/services-bridge.js)、[#107](https://github.com/LuNa-shi/SwarmEnv/issues/107)。

共享Mission多Execution、分支工作面/执行权、同identity切换、最小Progress和Git接续是最新目标的增量，不能只删模板/配额便宣布完成。逐项验证B01–B10。独立普通Task保持单执行，共享Mission不再套用这条限制。

## S3：反馈与研究连续性

| ID | 原有边界与证据 | 本轮处理 |
| --- | --- | --- |
| F1 | 代码确认：delivered后不再进入pending，缺独立处理状态 | 已投递未处理消息继续接续；共享Mission各受影响Execution分别记录 |
| F2 | 代码确认：pending按旧Execution终态转投，未区分截止提醒；真实误投待复现 | 截止提醒随执行失效，研究反馈继续有效 |
| F3 | 所读Runtime投递失败路径只记录日志，完整重试/重启效果待验证 | 实测重放/重启，消息不静默丢失也不重复执行语义动作 |
| F4 | 现代Task缺同伴调整请求、处理决定及授权取消完整路径 | 运行中响应并记录动作；只撤销被授权的Execution，不终止整个共享Mission |
| F5 | 代码确认：Material全局role与link绑定；同Task继任引用仍可能走生产者检查 | 保持生产来源不变，允许引用旧成果和不同用途，不强迫复制 |
| F6 | 代码确认：生产Task CLOSED后，其他接收者直接返回而未写接受记录 | 每个交付/接收者分别确认，迁移旧状态含义 |
| F7 | 代码/报告：每Execution重算时间，attempt默认1，恢复Session与Execution含义混合 | S2统一基本身份/累计消耗；S3增加compaction计数与identity轮换，不把多Session伪作单次持续研究 |
| F8 | 代码确认：短窗口提醒可能只提前约1毫秒 | S2基本时间盒先修，S3沿用；保存失败允许停止并记录丢失，禁止伪报成功handoff |
| F9 | 代码确认：前置仅DONE/CLOSED满足，取消后活性待场景验证 | 取消不等于成功；通知依赖方调整/结束责任，可回到Mission，避免永久无解释阻塞 |
| F10 | 报告/#107：聚合材料数与笼统窗口标签掩盖真实接续 | 各Issue从Task/Execution/identity/Material/commit展现事实；Mission并行与独立分工分开 |

来源：[TaskService](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/task/task-service.js)、[Runtime](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/runtime/runtime.js)、[Context](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/src/context/context-service.js)、[历史报告](https://github.com/LuNa-shi/SwarmEnv/blob/75fca5aa647154a642d676c639c8770d1f7eb90a/docs/experiments/exp-20261031-putnam_2025_b1-flat-dynamic-2h-fc15f2e-r1/analysis/experiment-analysis.md)。

compaction最多三次、第三次后下一轮80%交接、第四次禁止及失败保存有界放弃为新契约，按C03–C06验证，不把旧代码未实现直接写成已发生事故。S2的基本Git/主动handoff是S3前置；不把S3作为S2的隐藏关闭条件。

## 保留的保障与范围外内容

已有legacy工具过滤、同Mission检查、依赖环检查、Judge哈希/环境校验、handoff来源与执行权保护仍保留。共享Mission放开并发要将隔离细化到Execution，而非删除fencing。旧未投递消息已有转投基础，应补处理语义而非重复搭建消息系统。

不深入优化全文检索、扫描性能、任务价值、分工粒度、窗口长短、重复劳动算法、材料排序与争议裁决。运行状态错误和真实语义偏差必须修，工具帮助同步不是prompt搜索授权。

## 每项关闭前

每行给出已修复、未复现、符合新规范保留或批准延期，并链接回归/PR/真实事件。原23项记录与新行为表一起覆盖当前目标；新增同类问题继续归属。单次两小时未出现竞态不是已修复证明，某个指标变好也不能覆盖未完成的必需实现。
