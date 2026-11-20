# Phase 04 · 在原生 Agensh 上复测局部证明产出与主定理进展

[研究设计 Issue #157](https://github.com/LuNa-shi/SwarmEnv/issues/157) 记录需求与批准。负责人已选定 A，要求先用 PutnamBench 做短程验证，再用唯一一次 8 小时窗口观察 Q20。

## 为什么先做 A

要回答“换一个框架，同样的现象还会出现吗”，先用 **A：原生 Agensh + 数学任务包**。借用 SwarmEnv 的题目和可信判题，在外部观察 Agensh 自己的团队。**B：用 SwarmEnv 复现 Agensh 协作**适合后续回答“在我们可以干预的同一环境里，哪一项机制影响选题或接续”。如果 A 已回答现象复现问题，第一阶段即可收束。若只有 B，则排他领取、工作结束时更换会话、消息到达时点等都可能解释差异。同样，A 和 B 结果相近也不能单独验证架构等价。

历史动机选用 SwarmEnv EXP-20261117-03。Q20 的 M1 和 M3 在第 3.8 和 6.8 分钟分别得到验证并进入 main。到第 478 分钟仍为 24/100，原目标零提交。平台期内 B066 的局部输入 0.475 获 Judge PASS（85260c88-969b-4a96-9735-a443c31704c5）；B075 随后读取交接、采用保存成果，修复后在 main 0.511 接入条件性端点。精确秩与惯性条件仍待证明。这给出了**确有采用、根里程碑仍持平**的实例。原运行标记为 protocol-invalid，末端比 8h 短 118.396 秒，作为回顾性数学参照。上游论文在编程任务上测量通过率，其结果不能直接作为数学对照。[Q20 评分](../experiments/q20-score-curve.md) · [历史截面](../experiments/EXP-20261117-07-q20-baseline.md) · [B075 接续](../experiments/EXP-20261117-03-bots-b073-b108.md#b075--core-4) · [Agensh 论文](https://arxiv.org/abs/2609.26781)

## A 的实施边界

SwarmEnv 基线为 `9636fb033cf47d46bb8ce6d14ba0046303885bc6`。Agensh 固定到 Microsoft 的 `2dae4e14a653da48549fd9aa093f834841475d6c`。建议在实现 PR 以固定 gitlink 引入 `third_party/agensh`，保留 MIT 许可与来源。数学 pack 放在本项目；构建时在派生的干净树下装入 `tasks/lean-proof/`，锁定基础镜像和 overlay 内容。基准语义选该提交的 **ProgramBench 多 worker 模式**。同一 release 的 software-project pack 另有 issue 指派同步、CI main-health、同步上游和交付 PR 等行为。换用它会改变基准。实际通用入口是 team driver 的 `--pack` 与 profile；该提交的 project CLI 只接受 software-project。实现需验证 profile/镜像生成及残留的编程任务路径。[pack loader](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/agensh/pack.py) · [team driver](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/agensh/team_run.py) · [project CLI](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/agensh/project.py) · [两种 pack](https://github.com/microsoft/Agensh/tree/2dae4e14a653da48549fd9aa093f834841475d6c/tasks)

| 边界 | 数学版交付和验证 |
|---|---|
| 运行与通信 | 原 Compose、对等 worker、每 worker 的 router 和 native harness/ACP、唤醒间隔、idle、截止提醒、重试/恢复、归档与收尾。Gitea 保留 Issue/PR/分支/main，Mattermost 保留频道与 DM，board 保留 CLAIM、FACT、FAIL、PATCH_SUMMARY。CLAIM 到期和撞题协商照常。DM/peer board 可随符合条件的 MCP 工具结果在轮内到达，普通群组事件到轮间排队。记录发送、实际显示和下一动作。 |
| 提示与选择 | 团队提示、事件规则、发现→自主声明→工作→验证→PR/合并→分享→再次选择的循环逐条保留。只替换运行参考二进制、对拍输出、交付编译程序等领域语句，使其对应阅读根声明、探索局部命题、运行 Lean 检查和交付证明。比对实际渲染的启动、idle、deadline 与交付消息。禁止预设工作列表、数学优先级、计划阶段、人工分派、引入 SwarmEnv Agent prompt。允许团队自发规划和分工。 |
| 输入与工具 | prepare 只种入冻结的公开 fixture、使用说明和获准的 Lean/Mathlib。工具链、查询范围、CPU、内存、缓存初态一致；每轮从干净库/缓存策略开始。仅开放原服务、获准模型网关和本实验判题端点。Git 对象/历史、镜像依赖、可搜索源码和编译产物均检查是否暴露答案。操作者见证、往次 Agent 成果、评分标准保持隔离。 |
| 验证与交付 | worker 可对局部声明独立运行公开检查并获得诊断；每条成果绑定 Git SHA/路径/声明、实际前提、依赖闭包、checker 及环境摘要。主目标文件允许保留初始待证洞，局部声明的可信依赖须通过检查。export 固定 Gitea main 的 SHA/tree，以只读输入交给外部 final Judge，检验原目标类型、受信基础、公理闭包与 kernel。分支 CI、绿色 PR 或已关闭的 Issue 不触发数学验收。 |
| 外部观测 | 外侧记录 Git、router、board、worker、checker 事件；额外取样和语义审计离线执行，不向 Agent 推送根缺口或评分，不占用运行内 checker 槽。保存每个分支首次公开的 SHA、main 引用变更和运行中产生的回执；离线复核每个可能改变评分或完成原根的快照。历史 SHA 若最终证实已解出但当时未检查，应报告发现与验收两种时间，不能以未提交声称整段无根进展。交付可重放的 manifest、领域改动清单、脱敏证据索引和每次运行的冻结截面。 |

源码核对可见 router 串行投递 ACP turn、去重、退避重试和恢复；board 的文本/证据字段由服务接纳，数学真实性另由 Lean 建立。这些是静态核对结果，实际部署需经脚本验收。[worker/通信契约](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/prompts/agents.txt) · [router](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/mini-router/README.md) · [board](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/board-service/README.md) · [ProgramBench 工作循环](https://github.com/microsoft/Agensh/blob/2dae4e14a653da48549fd9aa093f834841475d6c/tasks/programbench/prompts/work_cycle.txt) · [SwarmEnv final verifier](../../src/judge/lean-final-tree-verifier.js)

## 正式运行以前怎样验收

1. **同脚本保真测试。** 先在固定上游代码任务跑两个 stub ACP worker，再在 Lean pack 走同一场景。脚本包含两人看见同一机会、同时 CLAIM、DM 协商、peer board 送达、普通频道消息排队、冲突后同步 main 并重检、发布 PR 合并、同一 worker 再选工作、事件重试/恢复和到期归档。对比谁在何时可见什么、是否能继续行动、是否存在新增互斥；只要求有意义的事件偏序。另保留自然结束及预算停止的快照。任何必须修改 router、board、调度或团队规则的缺口须在 Issue 重新审议。可沿用上游真实服务和 stub ACP 的 smoke 做法。[上游脚本](https://github.com/microsoft/Agensh/tree/2dae4e14a653da48549fd9aa093f834841475d6c/tests/smoke)
2. **检查器与信息边界。** 用一个独立的小型 Lean 正控演示从局部证明、第二人引用、合并到可信根验收；另测“局部通过/原根仍开”“已推分支/未合入”“已合入/无实际引用”。Q20 的私有完整见证经同一导出入口获接受，原洞、改题、额外公理和被改的基础均须拒绝；worker 视角实测答案不可见。检查中断、超时或资源失败保留诊断，不能当作对数学命题的否定。[历史 Q20 输入与正负控](../experiments/EXP-20261117-07-q20-subtree-12h.md)
3. **冻结与授权。** 提交 upstream+overlay、两端镜像 digest、工具链、harness/model/provider/reasoning、实际 prompts、工具可见性、重复/重试规则、并发与墙钟边界、机器和 checker 缓存/队列、计时/清理上限及观测程序的清单。两段均使用 Agensh 官方 Pi ACP 后端和 gpt_proxy/gpt-6.1-sol。短程 2 个 worker、最多 30 分钟；长程 4 个 worker、仅一次 8 小时。负责人指定使用并行度和时间上限，不设累计 token 上限。保留实际用量。通过无模型验收后，按 Issue 获批矩阵登记正式 EXP。[运行规范](../workflows/experiment.md)

## Q20 试验与判读

**输入和预算建议。** 使用 `flt10-subtree-v1 / flt10_q20_reducible_cofixed` 的八文件根目标，fixture Git `ebfceac37e3151e25d794faef18e0ecc85c64629`，原声明 `FLT10Bench.q20_frey_reducible_hasCofixedLine`。以原报告的公开上下文、Lean/Mathlib 和受信基础摘要为基准，重新验证 Judge lock。A 先在 PutnamBench 2025 B1 做短程验证，然后 Q20 仅启动 1 次，4 workers × 8h，至多 32 worker-hours；这不包含 checker 或模型费用。两阶段顺序运行，每次重置 Git、会话、消息、board 和访问凭证。保留短程与唯一长程的全部证据。正式 B、单 Agent 或有规划器的干预组均须另行审批。历史 SwarmEnv 数据用于观察形态；若要比较两系统性能，需要在相同题目、模型、信息边界、检查资源及预算下重新跑 SwarmEnv。[fixture 和工具链锚点](../experiments/EXP-20261117-07-q20-subtree-12h.md)

**研究时钟。** 采用 team driver 首次 wake 设置的原生研究预算起点 run_t0。预检验证时间戳可导出，同时记录根 Issue 创建、首条 kickoff DM 实际送达、全部 worker 可工作时间、setup 和收尾。保存 0/2/4/6/8h 的不可变快照及期间每个 main 变更。预检要确认原生计时可覆盖研究窗口。提前耗尽、异常或关闭须报告真实末端与删失。记录原生停止/截止、预算耗尽、人工停止和不可恢复的隔离/完整性/服务故障；一旦触及批准的资源上限即停止研究。若原生流程在解出后继续，保留原结束行为，并单列首次可信解出。结算期的补验只用于注明“事后验证某个历史 SHA”，不得回填为当时已有的通过回执。

**场景是否实际出现。** 原始输入清单和 prompt 验证无预置分解、负责人和排序。在真实研究轨迹中标注 worker 自选、至少一项因尝试/验证或同伴发现才提出的新子问题。建议把“多种可做工作、排序未明”的最低可审计样本定为来自至少两个 worker 的两个不同选题时点，每个时点实际收到至少三个仍可启动且目标不同的机会，记录有无可区分它们的明确排序、当事人的判断和证据。公开 board 中存在但该 worker 没收到的项不作其选项。团队若自发形成清晰顺序，按时段记录。未达到可见样本或日志缺失时，仍报告数学结果，并注明场景未观测到或未知。

| 指标 | 定义与判读 |
|---|---|
| 局部证明 L(t) | 首次在公开不可变提交上获得可信验证的一条新数学声明。记录类型、前提、作用域和声明级依赖，排除已有库结果的别名、重复证明、单纯探针和空洞依赖；条件性结论按实际前提标注。按数学内容跨 worker/改名去重。相同声明重复 PASS 只计一次。以通过回执和公开提交均已存在的较晚时刻入账。 |
| 采用与集成 | 为每条 helper 记录首次可用、消息实际送达、第一次被经验证的父声明直接或传递使用、首次存在于 main、是否进入固定根证明。用 Lean 声明依赖/实际调用与 SHA 验证，分别记录自用和跨 worker 采用。展示分子/分母（已采用的去重 helper / 当期可核验的去重 helper）、未知数和右删失等待。文件 import、board 声称有用、merge 均不能独自证实采用。 |
| 根进展 R(t) | 分别报告当前 main 上被 Judge 验实的 M1–M8 集合、对应分数、失效/回退、最终目标验收以及首次可信验收时间。里程碑可乱序；数学上等价的结论按同一门槛复核。替代路线若绕过量表但可信解出，记为解出。另列有证据的前提移除与替代路线中间进展，说明量表盲区；有实质根进展但量表无法判定时单列为判读不确定。 |
| 主要判据（建议） | 以 (2,4]、(4,6]、(6,8] 小时为三个预定区间。每段至少出现 1 个新的 L，从 2h 到 8h **全程**无首次达成的新根里程碑（检查期间 main 历史以避免错过先升后退），且原根未被可信验收。完整长程满足上述条件时，报告“在本次 Q20 运行观察到”。提前可信解出作反例；场景或结局不可判时报告不确定。固定门槛识别长平台期；门槛外仍展示完整轨迹。 |
| 反例和不确定 | 局部证明持续且根也推进/提早解出，是对平台模式的反例；局部证明本身未持续，说明前半个条件未出现。完全无进展的困难题、未送达、队列阻塞、截断或证据不足分别报告。观察到两条曲线分离只能支持现象复现。一个样本无法估计发生率或外推到其他题目，也不能识别去中心化的因果效应。 |

数学复核使用仅评估方可见的既有量表。两名评审可在隐去 worker/运行标签后核对条件等价、重复和存疑路线，争议暂标 unknown，保留各自依据。每次运行出一张时间曲线和一张决策证据表。表中逐项关联 worker 当时实际收到的信息、所选和可见的其他工作、后续行动、回执与对父/根的影响。覆盖所有 worker，每段抽取首次关键选择及所有跨 worker 采用和明确失败接续。记录没有发现缺口、发现后继续局部工作、已投入但数学前提未能闭合三类证据；无外显依据时保留未知。另计等待/检查和提供商故障。原始会话、证明、stdout 和私有库只进忽略的 experiments 目录，公开结果用摘要、稳定 ID 和版本。[历史评分口径](../experiments/q20-score-curve.md) · [证据规则](../../.codex/skills/experiment-analysis/SKILL.md)

## B 在 SwarmEnv 中怎样实现和验收

| Agensh 所需行为 | SwarmEnv 可用单元 | 必须验证或补齐的差异 |
|---|---|---|
| 团队目标、预算、最终验收 | Mission、Judge/CheckResult、固定提交 | 用同一原声明与外部 checker；Agensh Gitea Issue #1 映射到 Mission 目标，不创建人人领取的根 Task。 |
| 长寿命对等 worker、连续选择 | Core 提供容量；Bot、Session 标识行动者与上下文 | 当前 Bot 只有一个 Execution，结束后新 Bot/Session。原 worker 能带着会话换题；需验证会话跨 CLAIM/释放、并发容量及恢复。不能把一串新 Bot 计作同一位有连续记忆的 worker。 |
| 自发 Issue、可冲突/过期的 CLAIM | 平坦 Task 可记录公开责任；Execution 可用于观测尝试 | 额外建模建议性 CLAIM 的可见期、重叠及自行协商。强制 Take 与优先级、依赖就绪门禁会改变行动空间。保留原生 board/backlog 路径直到兼容语义验收通过。 |
| Gitea branch/PR/review/merge | Workspace revision/main 可绑定 SHA、建立证据链 | 保存和合并 revision 不包含完整 PR 讨论、通知和冲突处理。优先沿用真实 Gitea，验证并发变更、合并拒绝、更新 main、重检。 |
| Mattermost/board/ACP 投递 | Material、Context、观测日志可保留可复用内容、来源和使用证据 | Material 发布/消费缺少 DM、轮内 shim、board 未读游标、截断/unfold、TTL、事件重试。优先保留原生服务和 router；每项替换均通过 A 的事件脚本，禁止由评估器提示下一步。 |

同一输入脚本覆盖双 CLAIM、私信及频道的可见次序、同身份换题、冲突重检与 merge、断线重试、截止收尾和同一快照的 Judge 结果。比较双方可观测的状态变化、权限、事件偏序及可见上下文。达标后才可在匹配条件下对照 A/B。剩余差异明确命名为 SwarmEnv 变体；若要验证“优先级不明确导致停滞”，需另提只改变优先级信息的受控对照，不能由本实验反推。[Bot/Core/Session](../architecture/01-agent-core.md) · [Task/Take](../architecture/03-mission-task.md) · [Material 与 Judge](../architecture/04-services.md) · [Workspace](../architecture/05-workspace-continuity.md)

本阶段交付设计、工程验收定义与实验判据。实施后应补齐运行架构手册和可执行测试，正式实验按每次运行分别报告 Results、Analysis、Next steps；无论是否出现平台期，均按原判据交付。
