# 阶段 02：Task、Material、Workspace 与 Bot Runtime 设计

> 设计与决策入口：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · 原始讨论：[Issue #120](https://github.com/LuNa-shi/SwarmEnv/issues/120) · 前置 Sandbox 阶段：[Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119) · 文档审阅：[PR #123](https://github.com/LuNa-shi/SwarmEnv/pull/123)。
>
> 状态：目标设计文档，按模块逐份审核；不代表代码已经实现或真实 sandbox 已验收。当前实现手册仍以 [docs/architecture](../../architecture/INDEX.md) 为准。

## 1. 项目目的

本项目有两个目标：

1. 建立清晰、可复用的 Agent Swarm 运行环境与运行策略：以 Services 为核心将外部能力与计算单元分离；以 Task 组织工作；以 Material 保存有来源、可检索和纠错的研究内容；以 Workspace 管理项目文件、版本和共同主线。
2. 验证系统能否支持自主研究协作：Bot 能发现、提出和选择工作，形成并行分工，复用并纠正已有成果，跨 Execution 接续，并逐步推进 Mission。

核心对象的分工：

| 对象 | 核心职责 |
|---|---|
| Mission | 所有 Bot 共享的整体目标和验收范围 |
| Task | 局部工作责任、排他执行、依赖和完成条件 |
| Material | 可持久读取、引用、复用和纠错的研究内容 |
| Workspace | 与 Mission 一对一绑定的本地 Git Repository |
| main | Workspace 中持续更新的共享 Git branch |
| Candidate | 从 Execution clone 导入 Workspace 的 Git 变更，不等于 Material |
| Core | 可复用的计算槽位 |
| Bot | 逻辑自主工作单元；与 Pi Session/Execution 的精确 ID 关系需在 Runtime 设计中明确 |
| Execution | 一次 Task 的排他执行及其权限、输入和运行记录 |
| Sandbox | 每个 Bot 生命周期的独立、临时第三方隔离环境；take 前只读，take 后在同一环境切换权限，release 后销毁 |

整体关系只在本 Overview 说明。各模块文档只负责自己的对象和接口，不重复介绍整套系统。

## 2. 设计文档地图

| 顺序 | 文档 | 只回答哪些问题 |
|---|---|---|
| 01 | [Core Runtime：Mission、Core、Bot 与 Execution](01-model-and-runtime.md) | Runtime 如何调度 Core、Bot 和 Execution？take/release 如何与服务状态协调？ |
| 02 | [Sandbox 与 Execution Runtime](02-sandbox-runtime.md) | 每个 E 的 sandbox 如何创建、挂载、授权、运行、销毁和回收？Pi/Bash/子进程如何隔离？ |
| 03 | [Task：任务合同、分工与执行责任](03-task.md) | Task 最小合同、list/detail、Dependencies、提出/选择、修订、完成和取消规则是什么？ |
| 04 | [Material：研究内容、Evidence、检索与纠错](04-material.md) | 什么值得发布？来源如何绑定？Evidence 如何表达？怎样搜索、复用、质疑和 supersede？ |
| 05 | [Workspace：Git Repository、Candidate 与 main 整合](05-workspace.md) | 本地 Git 如何管理？每个 E 如何得到 clone？Candidate 如何保存、discard 和 integrate？ |
| 06 | [完整 Prompt 与 Bot Skills](06-prompts-and-skills.md) | 初始规范全文、动态启动消息、CLI、skills 和实际发送记录是什么？ |
| 07 | [验证、相关工作与研究假设](07-validation-and-research.md) | 工程机制如何验收？研究收益如何对照和衡量？ |
| 08 | [架构迁移与实施切片](08-architecture-migration.md) | 当前代码需要怎样迁移？依赖、实施顺序和 architecture 更新要求是什么？ |

## 3. 文档职责与避免重复

- **Overview** 只讲目标、对象关系、文档入口和跨模块总览，不复制模块的字段表、状态机或 CLI 细节。
- **Runtime** 负责 Mission/Core/Bot/Execution 的调度与生命周期；**Sandbox** 负责容器、文件系统、凭据、网络、进程和 provider。
- **Task** 负责工作责任和依赖；**Material** 负责研究内容、来源、Evidence 与纠错；**Workspace** 负责 Git 文件版本、Candidate 和 main。
- **Prompt/Skills** 只把已经审核的模块合同转成 Agent 指令和 CLI 使用方法，不重新定义业务规则。
- **Validation** 定义可观察的验收和研究对照；**Migration** 连接目标设计与现有源码。
- 跨模块流程在所属模块说明“本模块负责的部分”，并链接到权威模块；不在每份文档重复一套全局流程。

## 4. 已确认的关键决定

### Mission / Task
- Mission 是所有 Bot 可见的最大共同目标；没有 Mission Task。
- Task 是分工、进度确认和计算分配的基本单元；同一 Task 同时最多一个执行者。
- Task Dependencies 是必有但可空的 Task ID 列表；v1 不引入复杂依赖语言。
- 当前执行者可以修订自己的 Task，必须记录修订原因和历史；不能修改其他 Bot 正在执行的 Task。
- Task list 展示摘要，detail 展示完整合同。

### Material
- Material 保存独立可读取的研究内容和来源，不与 Git commit/main 混为一谈。
- 发布时由服务根据当前可信 Execution 自动绑定生产来源。
- Evidence 第一版是 Agent 在正文中撰写的自然语言说明，不建独立 Evidence 对象或全局可信度分数。
- 有意义的实际使用才记录，不追踪每次打开/下载。
- disputed 保留并警示；superseded 从默认列表/搜索隐藏，但保留历史和精确 ID 查询。

### Workspace
- Mission 与 Workspace 一对一；两个 ID 不同。
- Workspace 是 sandbox 外的本地 Git Repository；main 是 Git branch。
- 每次 main 更新产生 commit 并递增 Workspace revision；第一版不创建 Git tag。
- 每个 Execution 使用独立 local clone；不共享可写 .git。
- Candidate 长期保留；Mission 完成不删除 Workspace/Candidate；Candidate 由 Bot 显式 discard，v1 不自动清理。
- Bot 可以直接 integrate；复杂跨 Task 整合时再创建普通 Task。
- 最小整合门槛：有效 E、expected revision/base commit 正确、Candidate 完整且来源可追溯、明确指定的检查通过。

### Sandbox / Services
- 每个 Bot 生命周期使用独立、临时的第三方 sandbox，包含 Pi、NuRouter、扩展、Bash 和所有子进程。
- Bot 启动时获得干净 sandbox/Pi Session 和只读项目目录；take 在同一 sandbox/Pi 中绑定 E 并切换权限，release 后销毁；后继 Bot 使用新环境，只通过 Material 和 Workspace 公开内容接续。
- Task、Context、Judge 和领域服务在 sandbox 外独立部署，通过 API/CLI 通信。
- 不做进程级恢复，不向 Bot 暴露 provider 管理凭据、Docker socket 或服务数据库。
- 普通 CLI/API 调用由服务在处理时验证身份和当前 Execution；不引入通用 pending/permit/acceptance 协议。

## 5. 当前待明确的问题

以下问题不能通过模块间重复叙述来掩盖，需在相应文档审核时单独决定：

1. **Take 前只读 sandbox 与 take 后 Execution 的边界已澄清。** Bot 启动时已经运行在自己的 sandbox/Pi Session 中，项目目录和贡献型服务权限只读；take 不新建 sandbox/Pi，而是在当前环境建立 E 绑定并切换权限；release 后销毁。详见 [02](02-sandbox-runtime.md) 和 [06](06-prompts-and-skills.md)。
2. **Bot ID 与 Core 的关系。** 当前建议每个 Bot sandbox 生命周期对应一个新的 Bot ID；Core 是可复用槽位，不是 Bot 身份。release 后 Core 启动新的 Bot ID。请确认这一点是否符合你对 Bot 作为独立单元的定义。
3. **Workspace 模块部署位置与 Git/元数据一致性。** 当前建议与 Task Service 同协调进程，但需实现对账；Git ref 更新和 revision 元数据不是天然同一文件系统事务。
4. **私有审计卷保留策略。** #119 允许 sandbox 外留存私有卷用于审计，但后继 E 不可读取；保留期限、加密和清理策略需在 Sandbox 文档/实现阶段明确。
5. **Candidate 长期保留的磁盘成本。** v1 不自动 TTL/GC，先测量实际增长，再决定后续运维策略。

## 6. 审核与维护方式

每份核心模块文档完整审核后，再进入下一份。审核结论先记录在 #122，并更新对应文档及下游 Prompt、Validation、Migration。若某个后续阶段改变了对象、权限或运行语义，必须同步更新相关模块文档和 [Architecture](../../architecture/INDEX.md)。

当前设计与当前实现严格区分：文档中的未来 CLI、状态、Workspace main、Candidate、Sandbox 行为均是目标合同，不能因文档合并就声称实现完成。每个实施阶段完成后，需以实际代码和运行证据更新 Architecture；本目录保留设计决策和目标边界。
