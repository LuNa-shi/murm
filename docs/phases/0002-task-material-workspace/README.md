# 阶段 02：Task–Material–Workspace 协作模型与 Bot 协议

> 设计与批准入口：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · 讨论来源：[Issue #120](https://github.com/LuNa-shi/SwarmEnv/issues/120) · 前置执行基础：[Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119)。对应文档 PR 由 #122 链接。
>
> 状态：完整设计稿，供逐章审核。方案 A 与核心方向已经获得用户总体接受；具体字段、权限提供方配置、合入政策、prompt/skill 文本、实施切片及实验假设仍按本稿审核。**没有完成运行实现或真实集成验收。**
>
> 当前代码核对基线：[`008ecdb9ab64adcd8135042ff2160ec1db704952`](https://github.com/LuNa-shi/SwarmEnv/tree/008ecdb9ab64adcd8135042ff2160ec1db704952)，即已合并 PR #116 后的 main。当前实现的完整说明继续由 [architecture](../../architecture/INDEX.md) 负责。

## 1. 本阶段要解决什么

项目有两个目标。首先，建立清晰、可复用的 Agent Swarm 环境和策略：将可插拔外部 Services 与计算单元分离，以 Task 组织工作，以 Material 保存有来源的中间产物，并管理任务、成果和项目工作空间之间的关系。其次，验证这个环境能否支持有用的自主工作：Bot 能提出和选择值得做的任务、形成并行分工、准确使用已有知识、修正错误、接续前人的工作并推进共同目标。

本阶段把后一组行为变成可审核、可实现、可观察的合同。一个 Bot 有 Bash、私有目录和很多工具，不代表多个 Bot 自由行动后就会协作得更好。设计必须同时说明系统保证什么、Bot 被要求做什么，以及如何检验实际效果。

**Workspace 是核心对象；main 是 Workspace 内的共享主分支。** 每段 Execution 在 sandbox 内的私有工作副本执行。Task 提供责任与独占执行，Material 提供内容与来源，Workspace 提供可持续累积的项目版本。三者各有职责，不能以其中一个的成功计数冒充整体进展。

## 2. 阅读顺序与完整内容

| 顺序 | 文档 | 负责人不读源码也应该能回答的问题 |
|---|---|---|
| 01 | [核心模型与运行生命周期](01-model-and-runtime.md) | 对象是什么？四 Bot 如何启动？take 真正改变什么？权限何时生效？release 和故障怎样收尾？ |
| 02 | [Task 与 Material 策略](02-task-material-policies.md) | 怎样提出和选择 Task？成果怎样绑定？知识如何检索、复用、接续和纠错？ |
| 03 | [Workspace 与成果整合](03-workspace-and-integration.md) | Workspace/main/私有副本如何初始化和管理？何时提出候选？谁有权合入？旧基准、冲突和错误怎样处理？ |
| 04 | [完整 prompt 与 Bot skills](04-prompts-and-skills.md) | 初始规范全文是什么？动态字段从哪里来？take 后收到什么？四份 skills 如何指导工作？实际输入如何完整留证？ |
| 05 | [验证、相关工作与研究假设](05-validation-and-research.md) | 工程上怎样验收？哪些做法已有先例？什么证据才支持协作、接续或纠错收益？ |
| 06 | [架构迁移与文档交付](06-architecture-migration.md) | 相对当前代码需要改什么？先后关系是什么？每步如何验证，并更新完整 architecture？ |

建议先审核 01 的概念与生命周期，再审 02–03 的行为和权限，接着用 04 检查这些规则能否被 Bot 理解，最后审 05–06 的证据与实施路径。每章都是完整流程说明，源码引用只供事实核对，不承担替代解释的职责。

## 3. 已确认方向与具体提案

### 已确认方向

| 决定 | 本阶段的含义 |
|---|---|
| Mission 与 Task 分开 | 全体 Bot 看到同一 Mission；Mission 不被 take；删除 Mission Task 特例与隐藏占位任务 |
| Task 是分工单元 | 同 Task 同时一个执行者；Task Service 提供全部状态；不同 Task 承担并行责任 |
| 先查已有工作 | Bot 提案前检查任务与材料；第一版依赖 prompt 处理语义去重，不宣称原子认领能消除不同 Task ID 的重复 |
| Workspace 为核心对象 | Mission 与 Workspace 一对一；Workspace 是 sandbox 外的本地 Git Repository；main 是其 Git branch，Execution 使用独立本地 clone |
| 采用方案 A | 新 Pi/sandbox 先阅读，take 绑定唯一 E 并开放限定写权限；release 结束本 Bot，后继全新启动 |
| 接续通过明确发布的内容 | 公开 Material 和 Workspace 中已保存的 Candidate/main commit 可用；旧私有会话、未导出的工作目录和审计存档不继承 |
| 服务与计算分离 | 外部服务持久接纳工作；CLI 是客户端，服务与 OS 执行授权 |
| 精简概念 | Core 就是槽位；Bot 表示独立单元；不再把进度、handoff、检查返回值或反馈扩大成必需核心对象 |
| Git 作为 v1 基础可接受 | 使用熟悉的版本与副本管理，研究创新不靠采用 Git 或改名来宣称 |
| 完整设计与实现手册分工 | 本目录供目标设计审稿；代码变更时同步更新 architecture，阶段结束核对最终实现 |

“总体接受”不等于以下所有接口和阈值都已批准。本稿给出默认建议，使下一轮能讨论具体取舍，而不是面对空白待办。

### 本稿具体建议，待逐项审阅

| 提案 | v1 建议及理由 | 审阅时关注 |
|---|---|---|
| Bot 身份边界 | 一个新 Pi 对应新 Bot ID，最多一个 E；Core 保持 | 接续成本是否可接受；不悄悄恢复跨 E 私有对话 |
| 生命周期表示 | Task ready/running/blocked/done/cancelled；E 内部分准备、active、closing、closed | 中间态、并发和失败能否解释；没有伪释放 |
| 权限实现 | 固定私有卷、可信身份管理项目目录权限；协调和贡献身份分离 | provider 管理接口不能被绕过；真实 sandbox 必须验证 |
| Workspace 部署 | 逻辑 Workspace 模块与 Task 同一协调事务域；内容由 Context 外部 API 保管 | 使 main 更新与 E 撤权有确定顺序，避免新增必需微服务 |
| main 接纳 | Bot 自主判断是否保存 Candidate/是否整合；Candidate 是 Workspace Git commit/文件变更，不是 Material；简单情况当前 Bot 直接 integrate，复杂时建独立 Task | 最小门槛为有效 E、expected revision/base commit、Candidate 完整和来源、明确指定的检查通过 |
| Material 模型 | 内容/生产来源不可变，用途放 Task 关系；新增质疑和修正，不覆盖原文 | 纠错如何被消费者看见；元数据是否足够且不过重 |
| Task 规格修订 | Bot 可提出和 take Task；当前执行者可修订自己的 Task 并保留版本历史，不能改他人运行中 Task | 自主纠偏是否被限制过多；第一版先避免越权改别人责任 |
| 初始规范与 skills | 关键规则始终注入，四份通用 skills 按需读取；领域工具另有 help | 能否理解、何时加载、上下文成本、真实行为证据 |
| 研究假设 | 对自主分工、Material 接续纠错、持续整合、skills 各有可反驳比较 | 不把工程机制正确当收益；模型、基准和预算另行批准 |

## 4. 最小第一版的边界

第一版可以从一个 Mission、一个 Workspace、一条 main、四个 Core 和一组独立服务开始。没有 Task 时由 Bot 阅读和提案；每 Bot 只执行一个 Task。可用成果显式发布，main 由 Bot 决定是否推进；需要时通过普通 Task 在私有副本整合，再调用 Workspace 工具更新。

这足以覆盖一条完整闭环：**发现需要做的工作 → 排他执行 → 形成公开局部成果 → 新 Bot 理解并使用 → 集成到共同版本 → 验证 Mission 进展。** 失败、修正和未完成退出是这条闭环的常规部分。

暂不要求多 Workspace 合并、复杂调度器、永久经理、长期 Bot 私有记忆、自研 sandbox 平台、自动语义合并器、必选向量数据库、自动知识判真、所有服务结果自动转 Material，或每个运行时候选都开真实 GitHub PR。未来扩展应针对实测瓶颈提出，而不是先把所有机制一次塞入第一版。

这里的“提 PR”需要区分：我们开发 SwarmEnv 时用 GitHub Issue/PR 进行工程审阅；运行中的 Bot 则可以把 Workspace Candidate 作为可审查的 Git 变更，并由 Bot 自主决定是否调用 integrate。后者不要求开放 GitHub 凭据给研究 Bot。

## 5. 从一次具体运行看累积

CSV 例子从 Workspace main 初始 commit `c0` / revision `0.1` 开始。B1–B4 读同一 Mission 和工作列表后，可能分别选择过滤、统计、JSON、验证资料四个普通 Task。B1 发布研究说明 Material M1，并保存代码 Candidate C1。若整合简单，B1 可以在当前 Execution 内直接 integrate；若需要跨 Task 协调，则新 B5 领取独立整合 Task。成功后 main 从 revision `0.1` 推进到 `0.2`。Candidate 保存和 Material 发布都不自动更新 main；Bot 可以在当前 Task 内直接 integrate，复杂时另建整合 Task。

B2 未完成统计，但发布了有反例和部分补丁的 M2，并可保存 Candidate C2。新 B6 从当前 main revision 和公开 M2/C2 接续原 Task；它看不到 B2 的私有会话。B3 的 JSON candidate 若仍基于 commit `c0`，后续整合必须保留当前 main 中已有的过滤成果并重验，再推进下一个 Workspace revision。B4 的验证资料可供其他工作使用，但它的存在不等于 Mission 已通过验收。

这个例子在 [01](01-model-and-runtime.md) 给出完整生命周期，在 [03](03-workspace-and-integration.md) 给出版本轨迹，在 [05](05-validation-and-research.md) 给出故障和四路验收情景。脚本安排出这条轨迹，只能证明工程接口可用；真实 Bot 是否自主形成这种分工，仍需单独评估。

## 6. 创新主张如何约束

本阶段采用的 Git 分支、隔离副本、合并测试、任务分解和可检索技能都有相关工作。尤其 [CAID](https://proceedings.colm.cc/paper_files/paper/2026/hash/3b5c10bf5d70533e955cba9fba491bf4-Abstract-Conference.html) 已将异步 Agent、隔离 Git worktree 与集中整合结合；[STORM](https://arxiv.org/html/2605.20563v1) 还研究了共享工作面的写时状态一致性。因此，本稿不会把“main + worktree + PR”作为新颖性声明。

值得研究的具体问题是：在有限生命周期、干净执行上下文和可插拔服务条件下，Task 工作选择、Material 可纠错知识接续、Workspace 持续累积能否共同把计算资源转成更多可靠进展。可能得到负结果：元数据维护太贵、Bot 不读材料、错误传播更快、main 成为瓶颈，或过早整合限制探索。所有这些都必须进入评估。

[05](05-validation-and-research.md) 给出五项相关工作、四个待验证假设、公平基线与消融、质量/成本/接续/纠错指标。它不构成穷尽文献检索，也不以其他论文的效果数字代替 SwarmEnv 的结果。

## 7. 用户要求的覆盖表

下列编号对应 [Issue #122 的 User Stories](https://github.com/LuNa-shi/SwarmEnv/issues/122)，用于审阅覆盖，不是完成状态清单。

| 要求 | 主要说明 |
|---|---|
| US01 项目两项目标 | 本总览 §1；[PROJECT](../../PROJECT.md) |
| US02 核心对象与术语 | [01 对象与关系](01-model-and-runtime.md) |
| US03 零 Task、四 Bot 启动 | [01 启动和具体轨迹](01-model-and-runtime.md) |
| US04 Task 边界/交付/依赖 | [02 Task 最小合同](02-task-material-policies.md) |
| US05 提案前查已有工作 | [02 提案策略](02-task-material-policies.md)；[04 稳定规范](04-prompts-and-skills.md) |
| US06 选择有价值工作 | [02 选工依据](02-task-material-policies.md)；[05 H1](05-validation-and-research.md) |
| US07 同 Task 排他认领 | [01 take 顺序与失败](01-model-and-runtime.md) |
| US08 take 的实际效果 | [01 输入、激活、权限与返回](01-model-and-runtime.md) |
| US09 只读范围/服务授权 | [01 权限与受理边界](01-model-and-runtime.md) |
| US10 成果来源与持久性 | [02 Material 发布](02-task-material-policies.md) |
| US11 准确检索/阅读/使用 | [02 检索流程](02-task-material-policies.md)；[05 有效复用指标](05-validation-and-research.md) |
| US12 新 Bot 接续 | [02 接续包](02-task-material-policies.md)；[03 新工作副本](03-workspace-and-integration.md) |
| US13 纠错与影响追踪 | [02 质疑/修正](02-task-material-policies.md)；[03 主线修复](03-workspace-and-integration.md) |
| US14 Workspace 初始化与 Task/E 关系 | [03 对象、初始化与副本](03-workspace-and-integration.md) |
| US15 候选/整合/合入条件 | [03 Candidate 管理与 main 整合](03-workspace-and-integration.md) |
| US16 并发 main 与版本失败 | [03 条件更新和故障表](03-workspace-and-integration.md) |
| US17 局部完成/发布/合入/验收 | [02 四种事实](02-task-material-policies.md) |
| US18 完整 prompt/skills | [04 全文、动态示例、消息和记录](04-prompts-and-skills.md) |
| US19 release/预算/故障/费用 | [01 收尾和观测](01-model-and-runtime.md)；[04 close-execution](04-prompts-and-skills.md) |
| US20 可行性与验证缺口 | [01 固定 provider 源码门槛](01-model-and-runtime.md)；[05 工程矩阵](05-validation-and-research.md) |
| US21 相关工作与研究比较 | [05 相关工作、假设与对照](05-validation-and-research.md) |
| US22 architecture 全覆盖与阶段更新 | [06 迁移和交付合同](06-architecture-migration.md)；[架构维护要求](../../architecture/INDEX.md) |

## 8. 审核和阶段交付

本次 Issue + 文档 PR 的交付是完整、内部一致、可逐项质问的方案及其验证计划。源码/官方接口核对和文档检查只建立设计证据；当前工作环境无 Docker，没有真实 sandbox 或付费 Bot 实验。本稿不把这些尚缺的验证隐藏在“已完成”状态中。

优先审阅的具体决策是：Workspace 模块与 Task 的一致性边界、main 接纳政策、Material 修正与使用关系、Task 规格变更权限，以及初始 prompt/skills 是否清晰且负担可接受。数值预算、阈值、模型和研究样本由相应实现/实验 Issue 明确批准；合成示例里的数字不是运行授权。

审核通过时，由 Issue 记录接受的文档 commit 及保留问题。后续实现按 [06](06-architecture-migration.md) 的垂直切片推进，代码与完整 architecture 一起审；最终按实际合并版本核对。文档 PR 合并本身不自动关闭 #119、#120 或本阶段实现验收，也不授权付费实验。
