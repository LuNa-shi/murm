# Issue #122 实验缺口分析：四路 Bot 为什么串行执行了一项 Task

本文复盘 `issue122-formal24`，以 [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) 采纳的 [Phase 02 设计](../phases/0002-task-material-workspace/README.md) 为对照。实现审查对象为 [PR #124](https://github.com/LuNa-shi/SwarmEnv/pull/124)。缺口和验证项引用现有合同，实施范围和验收状态以 Issue/PR 为准。

后续完整核对见 [设计与实现一致性审计](../phases/0002-task-material-workspace/09-implementation-audit.md)：覆盖全部设计章节、实际入口与兼容路径，并将 V01–V32 逐项映射到缺口和验证要求。本页保留实验观察，两者共同解释当前模型偏差。

## Setup

| 项目 | 固定记录 |
|---|---|
| 被测版本 | `7c5836fefa7124a8386150ea408068c9a6010b6b`，干净工作树。原 PR head `6117f12` 与运行版本仅差 Architecture 引用。 |
| 输入 | `putnam_2025_b1`，PutnamBench `a635813f5edf297d928f9bd5ef8324a26bdde09c`。锁定 Lean 源哈希 `80d035ae3e86493d3a09f8acc39601e6dba4e380e217c085c491e202b7ced6c7`。 |
| 环境 | OpenSandbox，镜像 `swarmenv/agent:issue122`，Pi 1.3.0，`gpt_proxy/gpt-6.1-sol`，Lean 4.33.1，Mathlib `0df444a360eaa60ab8c11dca51a86af692955474`，checker `lean/mvp-1`。镜像 digest 和上游账单未核实。 |
| 配置 | 1 项目、4 Core、`semantic`、3,600,000 ms timebox。运行器报告 3,620,758 ms。实验元数据记录 2026-11-13 16:17:03.691–17:17:25.959 UTC，时间边界包含不同的启动/记录开销。 |
| 证据边界 | `issue122-formal24` 是独立 run ID。本次为回顾性工程诊断，未找到与本运行匹配的正式预注册或对照。索引中的 EXP-20261112-07 对应另一个提交和被中止的运行。 |

## Results

**零 Task 初始化真实发生。自主分工没有发生。** 仅 Core 1 的首个 Bot 提出了唯一一份 Task，目标为完成整个 Putnam 证明。它自己成功领取。其余 Bot 没有发出 `task_create`，四路后续 38 次成功领取全部指向这同一 Task。权威 SQLite 记录的 39 个 Execution 从预留到终止没有重叠。运行结束时 Task 为 `OPEN`，没有活跃 Execution，Mission 仍未解出。

| Core | Session | 成功 take | take 工具错误 | 提案 | 本地写入 | Material 发布／消费关系 | Judge 调用／本 E 新结果 | 收尾 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 12 | 11 | 29 | 1 | 10 | 21／14 | 11／5 | 11 incomplete，最后 1 个未绑定 Session |
| 2 | 14 | 14 | 24 | 0 | 13 | 29／17 | 15／6 | 12 incomplete，1 fenced，1 expired |
| 3 | 14 | 13 | 24 | 0 | 11 | 26／17 | 11／2 | 12 incomplete，1 fenced，最后 1 个未绑定 Session |
| 4 | 2 | 1 | 37 | 0 | 1 | 2／1 | 1／0 | 1 fenced，最后 1 个未绑定 Session |
| 总计 | 42 | 39 | 114 | 1 | 35 | 78／49 | 38／13 | 35 incomplete，3 fenced，1 expired，3 未绑定 |

新 Judge 结果按其 SQLite 所属 E 计。114 个 take 错误中 113 个带 `CONFLICT`，剩余 1 个工具返回未提取到结构化错误码。平均活跃 Core 1.67 混合了已启动的模型活动与执行活动，权威 Execution 时间窗口为约 51 分钟串行占用。报表的身份循环只计到 1 次 take，Bridge/SQLite 计到 39 次，因而不能用身份循环的计数替代真实领取数。

### 从启动到收尾

- **16:17:03–16:17:29。** 创建 Mission 和公开 `0.1`，Task 为空（事件 #5）。Core 1 的第一个 Pi 启动（#31），列公开文件、查 Task 状态，然后按实际发送的 bootstrap 合同调用 `task_create`（#1000，产物 #1015–1016），紧接着 take（#1138，绑定 #1200）。它选择了 Task 类型、责任键和优先级等字段，整题 Goal、交付、完成条件和 Workspace 输入由运行器提供。Core 2–4 的首次 Session 都在 Task 创建之后启动（#1154、#1158、#1162）。
- **16:17:29–16:19:24。** 首个 Bot 阅读锁定输入，调用沙箱命令和 Mathlib 检索。提交锁定源被拒，直接写该文件也被只读守卫拒绝。写独立 `candidate.lean` 后又因禁止占位内容得到 ERROR。它发布失败 Material，登记对自己 Material 的消费，以 incomplete 收尾，E 进入 `HANDED_OFF`，随后 Session 关闭和 Runtime 释放（#5451、#5507、#5516）。
- **16:19:34–17:11。** Core 3 首个 Bot 成为首位接续者，Core 2 首个 Bot 再接续。此后三个 Core 多次换新 Session，同一 Task 在 incomplete 后重新开放，等待者继续竞争。Bot 反复读已有失败/经验、检索外心 API，写各自的本地证明文件并调用 Judge。最常见的反馈仍是全局颜色一致性没被自动化解决。也有 Bot 识别出需要排除两色共存的几何子问题，并记录 API 或下一步，但没有把观察转成一份新的局部 Task。
- **17:11–17:17。** 三次 E 被收尾围栏终止，最后一项 E 超时。Core 4 的首个 Bot 从 16:17:29 开始等同一项任务，36 次申领取失败后，到 17:14:21 才获准（#150832）。它读取 Material、查外心 API、写本地文件、收到此前的 FAIL、发布与 checkpoint，随后被 fenced。Core 2/S14 在 17:16:14 最后接手并超时（#155361）。Core 1、3、4 的最后 Session 无 E，随运行停止。42 条 Session 关闭都标记为预期停止，记录中的 81 个不同 Sandbox 启动 ID 均有停止事件。报告仍记录 `IDENTITY_LOOP_STOP_TIMEOUT`，故 Session/Sandbox 事件配对与协调器收尾状态应分别看。

### 每个 Bot 的操作轨迹

`S` 是同一 Core 下记录的 Pi Session 序号，用来指代本轮可区分的 Bot 生命周期。运行器在鉴权上使用固定 Core actor，因此没有把这个现场标识当作已实现的持久 Bot ID。下表时间是 E 绑定时间（UTC），无 E 时为 Session 启动时间。所有已绑定 Session 均领取同一 Task `5b9cb3a3`。表中的“写”是 Execution 本地写入，“检查”指 Judge 调用（含复用）。除首个提案外，每行提案数均为 0；所有绑定 E 都至少发布和消费了 Material。

#### core-1

| Bot | 时间 | E 前缀 | 关键动作与结果 | 终态 | 证据序号 |
|---|---|---|---|---|---:|
| S1 | 16:17:29 | 295432c3 | 列公开文件、读 Mission 状态，按模板提案并领取整题；两次检查均 ERROR，发布占位符拒绝证据 | incomplete | 1200 |
| S2 | 16:22:42 | 72b1a756 | 重读上一轮经验并登记两项消费，写文件、收到既有失败结果并记录下一步 | incomplete | 13903 |
| S3 | 16:25:25 | c2c5fe5c | 查外心 API，写文件、检视失败结果、发布失败与 checkpoint | incomplete | 21846 |
| S4 | 16:34:18 | acd3619f | 检索几何表示，写基线文件；产生新的 source_failure | incomplete | 44044 |
| S5 | 16:39:36 | 53ecc4da | 写自动化基线、检查并记录仍需解决的颜色一致性 | incomplete | 57590 |
| S6 | 16:42:54 | ea39061f | 读前序 Material，写基线、产生新的 source_failure | incomplete | 65212 |
| S7 | 16:57:39 | 9aa7134c | 长时间在短名单内竞争；领取后复核既有失败边界，只发布经验和收尾记录 | incomplete | 103718 |
| S8 | 16:59:32 | 144d1cf6 | 写并检查自动化方案，留下诊断和 checkpoint | incomplete | 109230 |
| S9 | 17:01:01 | b492de30 | 将混色矛盾保留为未解目标，写文件、得到 source_failure | incomplete | 113926 |
| S10 | 17:03:55 | ef5ec30f | 检索多个外心 API、写基线、返回已有失败结果 | incomplete | 121717 |
| S11 | 17:07:06 | 6bc76378 | 再次写并检查未完成方案，发布失败及交接材料 | incomplete | 131042 |
| S12 | 17:08:21 | — | 继续发现与竞争，7 次 take 返回错误；未获得执行权限 | 无 E | 134855 |

#### core-2

| Bot | 时间 | E 前缀 | 关键动作与结果 | 终态 | 证据序号 |
|---|---|---|---|---|---:|
| S1 | 16:21:06 | 4614f763 | 两次竞争失败后 take；查重复点与外心，尝试候选并获得 source_failure | incomplete | 9602 |
| S2 | 16:23:51 | 222bcf08 | 消费上一 E 的两份材料，写自动化基线；一次请求键冲突，随后取得已有 FAIL | incomplete | 17410 |
| S3 | 16:29:03 | 9e7c1230 | 阅读并消费前序经验，检索外心 API，写与检查，重复观察颜色一致性瓶颈 | incomplete | 30378 |
| S4 | 16:32:46 | 47d7c056 | 检索仿射组合 API、写自动化候选，复用先前 FAIL，留下可供接续的 API 线索 | incomplete | 39776 |
| S5 | 16:38:17 | ba5da7e5 | 消费两份材料，写和检查自动化基线，记录缺失几何步骤 | incomplete | 53855 |
| S6 | 16:40:51 | aa3f0a21 | 五次 Mathlib 检索、写文件、得到新的 source_failure | incomplete | 60806 |
| S7 | 16:44:20 | e8a22566 | 写并检查后仍缺几何证明，发布失败和经验 | incomplete | 68260 |
| S8 | 16:46:54 | 2b140325 | 四次 Mathlib 检索、写并检查，将失败目标留给后继 | incomplete | 74809 |
| S9 | 16:50:01 | b1bbe0ab | 读失败经验、写并检查，未完成几何步骤 | incomplete | 82638 |
| S10 | 16:52:40 | ac5b538d | 多次检索、写与检查，得到新的 source_failure 并 checkpoint | incomplete | 90402 |
| S11 | 16:55:59 | 0740a028 | 消费两份经验，多次查 API，写与检查，再次得到 source_failure | incomplete | 99078 |
| S12 | 17:08:25 | a8442e76 | 八次领取失败后进入 E，写文件、经历请求键冲突后取得新的 source_failure | incomplete | 135199 |
| S13 | 17:11:19 | 15b537f5 | 收尾提醒期间写与检查，得到 source_failure；尝试保存，终态 fenced | fenced | 142935 |
| S14 | 17:16:14 | d9185fd8 | 最后一次领取，读上一轮进度、查外心引理、留下两条经验；无新的写入或 Judge 调用 | expired | 155361 |

#### core-3

| Bot | 时间 | E 前缀 | 关键动作与结果 | 终态 | 证据序号 |
|---|---|---|---|---|---:|
| S1 | 16:19:34 | 261e5e67 | 首次竞争失败，随后接手首个 Bot；读取并消费其失败 Material，另写独立文件，首次得到普通 source_failure | incomplete | 5994 |
| S2 | 16:27:15 | 7a5fb0ac | 多次竞领后写自动化候选，复用失败，发布失败与交接 | incomplete | 25960 |
| S3 | 16:30:52 | 30a3d333 | 写并检查基线、查外心 API；无可验收证明 | incomplete | 34851 |
| S4 | 16:36:15 | cff82eda | 多次检索外心，基线自动化仍留全局目标；发布失败与经验 | incomplete | 48717 |
| S5 | 16:45:47 | 9385d644 | 查外心仿射跨度、等距点和仿射组合 API，记录适用范围；无候选写入或本 E 检查 | incomplete | 72355 |
| S6 | 16:48:43 | 53061e82 | 写基线并复用已有失败，消费前序两份材料 | incomplete | 79520 |
| S7 | 16:51:25 | 0ef7f7e0 | 写并检查自动化候选，记录未完成的外心证明 | incomplete | 86341 |
| S8 | 16:54:31 | ed9fb096 | 读前序材料、检索三次、写并检查，仍留下同类障碍 | incomplete | 95178 |
| S9 | 16:58:39 | c12d4514 | 读并消费两份材料；只发布经验和交接，没有写候选或检查 | incomplete | 107228 |
| S10 | 17:02:37 | 73672b5d | 检索 API、写并检查；保留失败和可复用线索 | incomplete | 118456 |
| S11 | 17:05:28 | 0a4ac855 | 直接领取、写并检查混色矛盾方向的候选，得到新的 source_failure | incomplete | 126175 |
| S12 | 17:10:08 | 1444ecc8 | 写并检查候选，仍无法排除两色共存，发布交接 | incomplete | 139844 |
| S13 | 17:13:01 | a77dc391 | 收尾提醒后读材料、查 API、写并检查，终态 fenced | fenced | 147355 |
| S14 | 17:16:02 | — | 剩余轮次再尝试领取一次，未获 E，随运行关闭 | 无 E | 154662 |

#### core-4

| Bot | 时间 | E 前缀 | 关键动作与结果 | 终态 | 证据序号 |
|---|---|---|---|---|---:|
| S1 | 17:14:21 | 17f5cc37 | 最早一批等待者，36 次竞争错误；最后三分钟才领取，读取材料、查 API、写文件，拿到与 Core 3/S1 同一个 CheckResult，发布和 checkpoint | fenced | 150832 |
| S2 | 17:16:02 | — | 再尝试领取一次，未获 E，随运行关闭 | 无 E | 154665 |

### 哪些操作形成了可接续结果

- **Task。** 唯一 Task 的 Goal 是 `Prove putnam_2025_b1`，交付要求是经验证的整题 Lean 证明。记录没有 Task 依赖、替代 Task 或局部 Task 完成。35 个 incomplete 均返回 Task `OPEN`；Agent 流未收到这 35 个 finish 返回，服务/Runtime 的持久事件能确认它们实际生效。剩余 4 个 E 是围栏结束或超时。主动运行的 Task 在任何时刻只有一个 owner。
- **Material。** 78 条由 42 条 experience 和 36 条 failure 组成，发布来源覆盖 39 个 E。相同内容哈希计数与语义重复是两个问题，多个条目重复记载“自动化留下全局颜色一致性，仍缺外心几何”。49 条持久消费中 48 条跨 E，1 条是首个 E 消费自己发布的诊断，**0 条跨 Task**。首位接续者 Core 3/S1 明确读取早先的占位符失败（#6383），登记消费（#6824），随后提交独立文件得到不同类别的诊断（#8267、#8530）。证据支持后继读了诊断并走到普通证明失败。它也曾试图修改锁定输入（#7862），所以无法把后续每个决定归功于这份材料。Core 2/S4 和 Core 3/S5 记录了外心的仿射组合及等距点 API，提供了具体线索；没有独立交付或公开文件证明有人据此完成几何构造。没有 dispute、supersede 或 unsupersede 关系。39 次 `task_link_material` 调用返回 `INVALID_CONTRACT`，已有持久发布/内部关联应通过服务表核实，不能由该调用的尝试数推断。
- **Workspace。** 35 条成功写入正式落在 E 本地 revision，23 次对锁定输入的写被只读守卫拒绝。39 个 E 都记录 `clean` 模式。Mission Workspace 的实际索引从头到尾只有 `0.1`，没有 Bot 调用 public save、apply、merge，也没有公开文件版本接续。公开 files 的确有调用，但这次没有 public read/search 调用。前任的材料可读，前任保存的文件能否在新 Bot 正常应用仍未验收。
- **Judge。** 38 次调用中，13 个新持久 CheckResult、23 次返回已有 CheckResult、2 次 request key 冲突。两个常被返回的结果分别出现 17 次与 8 次。内容去重会返回原结果身份；例如 Core 4/S1 返回 Core 3/S1 的 `07b0a15e`。13 条独立结果为 11 条 `FAIL/source_failure` 和 2 条 `ERROR`。其中 `81170cc6` 的诊断字段误写 `checker_pass`，业务 verdict 为 ERROR，证据为禁止占位内容、数学结论未评估；结果存储中的 PASS 数为 0。独立结果在 SQLite 可核对，项目汇总的 `check_count=0` 与实际调用/结果不一致。Preflight 健康、`protocol_valid=true`、`invalid=false`，和 `solved=false` 同时成立。
- **Mission。** 没有 Bot 调用 `mission_submit`。运行器在报告生成后用 operator 身份直接提交 `0.1` 与所有读出的 Material ID，再根据已有的 `run.solved` 填写提交 verdict。它没有为冻结快照执行一轮独立验收。最终 submission 记录为 failed，main 回到未冻结。
- **资源。** 权威日志可对齐的 42 个 Session 中有 39 个返回了 Pi session stats，成本字段均为 0。字段不等同于代理账单，未绑定阶段还有统计缺口，实际金额未知。Runtime 原始日志有 70 条 `runtime.sandbox_sync_error/SERVICE_UNAVAILABLE`，覆盖 Core 1–3，运行报告还保留协调器停止超时。没有把 HTTP 502、session_failure 等给定计数的零值外推为全路径健康。

## Analysis

### 预期的自主分工与本轮实际执行

[Task 设计 §4](../phases/0002-task-material-workspace/03-task.md) 和 [四 Bot 验收 C0–C2](../phases/0002-task-material-workspace/07-validation-and-research.md) 要求四个 Bot 从同一 Mission 看见空任务池，在有界检索后自主提出**有不同交付边界的责任**，或领取可推进的已有 Task。各自提出并领取自己的责任是一条应该能自然发生的路径。设计同时允许接续已有 Task、竞争失败后改选、无工作时退出，创建者身份不独占 Task，也没有每个 Bot 必须造一项 Task 的配额。局部可验证负结果可以是事前合同允许的合格交付。

实际行为由三个相互加强的决定产生：

1. **启动资格与可领队列绑定。** `allowEmptyDiscovery: core.index === 1` 只放行一路空队列启动，`bootstrapUsed` 只给一次空队列机会。其他 Core 在空队列直接 idle，因此它们无法在共同起点阅读和提出工作。即使空队列快照真实，也只为一个 Bot 提供了从空状态开始的机会。 [运行器](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/src/benchmark/putnam-runner.js#L2625) · [身份循环](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/src/runtime/identity-task-loop.js#L292)
2. **一次特许启动发给 Bot 整题合同，后续只下达领取指令。** 首个 Session 的真实 RPC 消息要求按指定 Goal、交付、完成条件和 Workspace 对象创建，并立即 take。发送路径还可追加精确建 Task 的 follow-up 或重启未绑定 Session 后重发。其余实际发送的 discovery 轮次要求从当前短名单恰好 take 一项；通用 SOP 表示允许独立提案，工具序列却把提案排在 take、工作和检查之后。附带材料和工作状态的通用指导没有解除这个矛盾。工具注册的 `task_create` 可用，因此现有证据将零提案归因到机会、提示和任务形状的组合，不能归因到物理上永久禁用该工具。 [发送逻辑](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/src/benchmark/putnam-runner.js#L650) · [提示词](https://github.com/LuNa-shi/SwarmEnv/blob/7c5836fefa7124a8386150ea408068c9a6010b6b/src/agent/agent-prompt.js#L180)
3. **整题没有可完成的中间责任，失败后回到同一个池口。** 第一份 Task 既要求整题证明和 CheckResult，又要求采用别的 Task 的 Material；在只有这一 Task 的轨迹中，后者根本无法满足。运行器把第一条动态责任登记为 `rootTaskId`，继承旧主任务的报表和汇总中心。Task Service 的并行额度 1 正确拒绝重叠执行。拿不到这一项的 Session 接到同类短名单提示并再次竞争。写了一份失败候选的 Bot 可选择 incomplete，系统活动重新变为一项可领责任，而空余 Bot 没有正常退出或转换为其他有边界工作的实际路径。由此形成“单任务开放 → 竞领 → 重复诊断 → incomplete → 单任务开放”。猜测模型如果收到不同提示会如何行动，需要后续独立证据。 [任务出生与报表标识](https://github.com/LuNa-shi/SwarmEnv/blob/dc011003fa0354a881b7a3ba9ba901fe36cbcac9/src/benchmark/putnam-runner.js#L2279) · [完成条件校验](../../src/task/task-service.js#L2815)

因此本轮可以评估排他领取和失败记录，却不能评估四路自主分工的质量。四路 Session 活跃与单 Task 串行运行可以同时成立。仅调整 Workspace 原子性、把同一 bootstrap 无差别发给四路，或强制四个 Bot 都提交一项工作，均不足以实现批准的选工模型。修复边界应包含启动资格、各阶段真实发送内容、有界重新选工与正常退出、局部 Task 交付条件及持久状态。

### 旧模型清理审计

| 层面 | 已核对的现状 | 缺口与影响 |
|---|---|---|
| CLI / API 入口 | 旧 runner 模型选择、共享 Mission Task、旧 fixture 路径和部分树操作已从正常入口删除或不再注册。此运行没有共享同 Task 的 E，也没有跨 E 私有 resume。 | 仅凭入口名变化不能判断下面的逻辑已经退役。通用 Runtime 仍有 reusable Session、同 E recovery、低层 Workspace 等兼容代码，Scheduler 仍可独立调用。需要逐入口确认历史读取、仍供现有调用者使用的兼容，以及正常生产运行，分别记录保留理由或移除路径。 [Architecture 已知边界](../architecture/09-known-boundaries.md) |
| 运行器策略 | 零 Task 事件代替了初始化器预造 root。 | Core 1 专用 bootstrap 的实际指令预制整题；第一份动态 Task 仍成为 `rootTaskId`，`root-only` 仍是 treatment，分析和报告保留 root/child。仓储的 `creation_kind=ROOT` 可仅是存储类别，但 runner 对第一条 Task 的特判实际进入产品行为和证据投影。 |
| Bot 身份与生命周期 | 同一 Session 能从阅读转为 E，实际 39 个绑定各有对应 Session。所有已观察 Session 均关闭。 | 实际 actor 为 `agent:core-N`，跨 Session 重复。持久权威 store 缺少独立 Bot 生命周期对象与跨阶段费用。没有 `bot exit` 入参/操作。固定 Core actor 及 prepare/active/closing/release 顺序需要独立故障验证。架构兼容 Session 不能作为新 Bot 的身份模型。 |
| Prompt / skills / 工具 | 实际是 Pi 命名业务工具；初始 discovery 消息和后续 bound 操作可从 RPC 核实。 | OpenSandbox 启动为 `--no-builtin-tools --no-skills --no-prompt-templates --no-context-files`，本轮没有仓库追加系统 prompt 的 launch 参数，也没有加载 Phase 02 四份 research skill 的证据。代码里同时有新版 SOP、复用 Core 身份的旧指令、短名单领取序列和 bootstrap 合同。批准的“四基础工具 + Bash CLI + 可追溯按需 skills”尚未成为这条运行路径。模板生成/组合的 hash 不能证明实际发送。 [Prompt 设计](../phases/0002-task-material-workspace/06-prompts-and-skills.md) · [Adapter](../../src/agent/opensandbox-agent-adapter.js#L211) |
| Task / 状态 | 普通 Task 本轮额度为 1，`task_finish` 的四种 outcome 有源码入口，blocked 等未被本轮自然触发。 | schema 和内部读路径保有 root/parent、等待/重做/配额/历史结构及不同终结状态词汇。需要验证已批准的依赖修复、无 owner cancel、状态重算、关停前不放回队列。部分历史结构表在本轮为 0 行，不能将仍存在的表认定为发生过。 [Task Service](../../src/task/task-service.js#L1772) · [Schema](../../src/storage/schema.js#L228) |
| Material | 成功记录正文与来源及同 Task 跨 E 消费。`swarm material` 已有映射。 | `swarm context` 别名与实际发送的 `swarmenv_context_*` 仍是可见接口，保留 link/role 和消费要求，且发布提示仍要求另行 attach。底层有纠错操作，不等于规范 CLI/API 及完整替代合同已验收。需区分明确的历史读兼容与今天向 Bot 提供的入口。 [CLI](../../src/cli/swarm-cli.js) · [Context](../../src/context/context-service.js#L465) |
| Workspace | 有真正的 Mission Workspace `0.1` 和另一个 E 本地 Workspace。没有独立 Candidate 对象被本轮 Bot 创建，检查对象来自路径。 | 当前工具允许 Bot 写 E 本地文件，产生本地版本。批准设计要求普通文件经一致 save 公开，公开 revision 可读/apply，整版 merge 后更新 main。从普通工具返回的本地 revision 到公共仓库没有经过这条闭环。遗留 checker、fixture、report 的 candidate 字样需按真实对象、历史字段、普通文件称呼区分。 |
| 验收与观测 | 真实工具、服务和 Runtime 日志都存在。 | Report 仍由 root/child、候选、scheduler 兼容字段组织，自动报告将 39 个 `-fresh-1` Workspace 目录引用投影为额外 E，显示 78 个 Execution。与权威 E ID 经明确 assign 事件对齐后为 39 个。Judge 聚合漏数、误写诊断码、旧指标与 Mission 接受快捷路径共同削弱比较结论。 |

### 其他已确认的实现缺口

这些是既有批准合同的具体偏差。部分来自代码审查与本地复现，不能算成本轮 Agent 自然触发过的事件。详见 [PR #124 审查](https://github.com/LuNa-shi/SwarmEnv/pull/124#issuecomment-6873555099)。

| 设计场景 | 现状证据 | 需要验证的修复结果 |
|---|---|---|
| V02–V08、V12–V13、V18、V19、V24–V25 | 本轮验证了部分工具权限和输入文件只读，观察到一次次 Session 结束及释放。独立 Bot 身份、重复 take 恢复、潜在迟到授权、prepared 到 active/grant 的顺序、驱逐后访问以及退出/补位预算没有完整证据。停止协调器仍报超时。 | 真实 Sandbox 中验证读写边界和撤权顺序。无 E 退出不造 E；take 冲突不消耗不可恢复额度；失联重试返回持久结果。有效 finish 后只允许已经受理的长操作按原合同完成。 |
| V09–V11、V15、V26 | Material 发布和消费已见，独立 Task 关联、附件失败补偿和纠错闭环未观测。源码有纠错关系和部分 CAS。 | 使用两项独立 Task 对账生产来源、可读内容、实际复用动作与正文不可变；核对 dispute、完整 supersede、默认隐藏、历史读取及误替代撤销。保存失败时同样记录真实终态。 |
| V14、V16–V17、V21–V22、V29、V31–V32 | 并发 save 复现两个成功响应共用 revision 并覆盖内容。merge 缺少最终 CAS，检查的是来源树、时机早于合成最终树。apply 只物化文件，缺 dirty 检查和同 E 三方整合。注册/API 层公开 save、merge 的 snake_case 参数没有映射到实现使用的 camelCase，apply CLI 缺入口。 | 绑定有效 E 与受控目录。公开 save 对真实字节一致捕获，稳定 ID 可恢复；对未保存文件保护，apply 保留真实 parents。最终树检查、授权、freeze、main CAS 在同一提交边界对账，并覆盖重启、并发和历史保留。 |
| V23、V30 | 唯一运行 Task 的合同很宽，未记录局部新前置、探索责任或合理的跨 Task 完成。现有 `blocked` handler 和依赖环校验只是源码证据。 | 有界检索并输出选工理由与未读范围。局部 Task 自己取舍完成结果，负结果有真实可复现交付；发现前置时能用受控依赖阻塞，关闭后按最新条件重算，不靠反复 incomplete。 |
| V20 | 实际启动、短名单和部分执行消息有 RPC 可查。正常运行缺规范 CLI 和按需 skill，兼容文本仍进入实际 Prompt。 | 用固定镜像和真实入口核对逐阶段实际消息、schema、help、授权、skill 读入和身份绑定。文档、生成清单及工具枚举一致；保留项明确标为兼容。 |
| V27–V28 | Agent submit 的参数映射缺失，运行器绕过入口并用既有 solved 写 verdict。快照只记录 Material ID，缺完整输入身份与再次检查；同请求重试和迟到完成需补。 | 从规范入口固定 explicit Material 集、main、checker/env 及验收配置；冻结与 merge 共用排序边界。相同请求恢复结果，错误/超时仅解冻自身，迟到结果不能影响新提交。 |
| 报表 / 流程 | 执行计数、Judge 计数、成本、实验注册和证据 ID 投影有偏差。早期若干 PR 内报告含个人绝对路径。 | 用持久 Bot/E/Task/CheckResult 对账报表，区分新检查、复用和请求失败，去除误归类。发布资料仅含脱敏信息；历史运行以正确 commit 和实际状态标注。 |

## Next steps

下轮实验之前，依照批准设计的 E1/E2、C0–C7 先完成有界验证。以下次序来自本轮失败的因果链和各步骤的依赖，不要求重新定义基准、模型或研究问题。

1. **先证明系统创造了真正的分工机会。** 在零 Task 时启动四个不同 Bot，各自拿到同一 Mission、公开初始输入和有界发现权限。由受控测试走通同时有至少两项不同交付的 Task 分别被创建并由创建者领取，以及同一 Task 仅一人成功、输家重新选工或正常退出。验证未绑定阶段的阅读和成本都跟随真实 Bot。然后核对实际发送内容，确认未写入预制整题或固定编号特权。受控场景只证路径，真实 Bot 最终是否选择主动提案由 E3 观察。
2. **用同一条 CLI / Sandbox 路径完成局部交付和接续。** 让一个 Bot finish、一个因真实前置 blocked、一个在原 E 保存/apply 并处理冲突、一个读前人的公开内容。用明确的 Task/Execution/Bot/Workspace revision 和 Material provenance 证明动作。对齐 Phase 02 的对象、术语、工具、权限、退役和可观察边界；同步 Architecture 及生成参考。
3. **在便宜的故障场景里把持久副作用对账。** 按上表补 concurrency、响应丢失、重启、迟到 grant/merge/验收、收尾和文件历史用例。保留同一个固定 head 的报告、测试输出、provider/镜像身份和证据入口。以记录上的独立结果判定覆盖，避免只数成功 tool、事件或发布条目。
4. **再核对下一次正式运行的入场条件。** 由 Issue 明确同意的实验预算、固定版本和对照，先用短的受控轨迹确认 provider、checker、权限、选工和清理。新的正式运行独立注册，观察每个 Bot 的候选任务、实际提案、领取/失败、选工/退出理由、并行的不同 Task、后续维护以及被实际采用的文件和材料。以真实轨迹比较目标与行为，单样本保留案例边界。

## Evidence and limitations

- 本地权威记录为 `experiments/issue122-formal24/state/projects/putnam_2025_b1/project.sqlite` 的 `tasks`、`task_creation_provenance`、`executions`、`materials`、`material_consumptions`、`check_results` 和 `checker_preflights`。Workspace main 取 `state/projects/putnam_2025_b1/mission-workspace/` 内的 Workspace 索引。
- 事件序号引用 `<external>/observability.sqlite#observation_events.sequence`，过滤 `experiment_id=f8698a39-4288-4cd5-8b2e-526dafb2a2b1`。完整工具请求/返回索引写在被 Git 忽略的实验目录 `analysis/bot-operation-ledger.md`。以明确 Session ID + assign 事件建立 E 对应关系，未按同一 Core 或临近时间自动拼接任意未标识记录。保留三条无 E Session 与 35 个无 Agent finish 返回的持久操作。
- 原生成报告 `analysis/experiment-analysis.md` 仍可用作定位辅助。上面已说明自动 E 计数及 Judge 诊断/聚合冲突的取证办法。运行配置和结果另见 `metadata/experiment.json`、`reports/issue122-formal24/aggregate-report.json` 及对应项目报告。原始对话、候选源码、数据库及私有路径只存本地。
- 四路单题运行提供自然行为观察与工程诊断。没有配对实验，费用未核实，运行后对证据开展分析不能补回预注册；没有把缺失观测记成已验证。
