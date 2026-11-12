# 06. 架构迁移、实施切片与文档交付

> 设计附件：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)。本文是待审的迁移方案，**不是已经实现的 Architecture，也不构成 runtime 实施或付费运行授权**。
> 当前实现对照固定为 `008ecdb9ab64adcd8135042ff2160ec1db704952`。前置阶段是 [#119](https://github.com/LuNa-shi/SwarmEnv/issues/119) / [阶段 01](../0001-sandbox-services-cli.md)；它尚未完成。Judge 职责修复关联 [#117](https://github.com/LuNa-shi/SwarmEnv/issues/117)。截至 2026-11-12，[PR #118](https://github.com/LuNa-shi/SwarmEnv/pull/118) 仍 open、未 merged，不能把 legacy 删除当作现状。

本章把 [01 运行模型](01-model-and-runtime.md)、[02 Task 与 Material](02-task-material-policies.md)、[03 Workspace](03-workspace-and-integration.md)、[04 prompt 与 skills](04-prompts-and-skills.md) 和 [05 验证](05-validation-and-research.md) 连接到当前实现。它回答改动落在哪里、哪些能力必须一起交付、怎样迁移已有数据、何时可以停用旧接口，以及每个实施 PR 怎样交付可独立阅读的完整架构说明。

## 阅读目录

1. [事实、设计与批准的边界](#1-事实设计与批准的边界)
2. [目标职责与必要接口](#2-目标职责与必要接口)
3. [现状到目标的关键差距](#3-现状到目标的关键差距)
4. [全部代码分组到架构章节的映射](#4-全部代码分组到架构章节的映射)
5. [纵向切片、依赖与回退](#5-纵向切片依赖与回退)
6. [Schema、数据与运行版本的迁移](#6-schema数据与运行版本的迁移)
7. [旧命令、私有恢复与兼容路径退役](#7-旧命令私有恢复与兼容路径退役)
8. [观测、实际 prompt 与版本绑定](#8-观测实际-prompt-与版本绑定)
9. [每个实施-pr-与阶段结束的架构交付](#9-每个实施-pr-与阶段结束的架构交付)
10. [批准前需要明确的事项](#10-批准前需要明确的事项)

## 1. 事实、设计与批准的边界

### 1.1 三种记录各自说明什么

| 记录 | 本次怎样使用 | 不能推断什么 |
|---|---|---|
| 固定 main `008ecdb9…` 的源码、schema 和现有测试 | 核对现在存在的入口、状态、依赖和兼容路径 | 测试文件存在不表示本次运行过，也不表示真实隔离成立 |
| [Architecture](../../architecture/INDEX.md) 及 [source-map.json](../../architecture/source-map.json) | 当前已记录的实现手册和覆盖清单；清单内仍声明 runtime baseline `02adbb43d39e0b23befb7f2ffc4b19ffb386a36d` | 不能仅将 baseline 字符串改成目标版本，就宣称完成了源码与语义复核 |
| 本阶段六章设计与批准 Issue | 说明建议实现的完整目标及迁移合同；由 Issue 指明采纳的文档 revision | 文档审核通过不证明代码已实现、真实 Bot 已表现良好或预算已获准 |

本次文档 PR 可以调整阶段目录规则、链接和相应文档检查；这与后续改变 Swarm 运行行为是不同工作。它不将未来 `swarm` 命令、Workspace 主线或新状态写成当前 API。

进展、阻塞、实施 PR、已执行检查和批准决定记录在 #122 或经批准的后续 Issue/PR。本文的切片表是依赖设计，不是待勾选的第二套状态账本；不创建阶段 `STATUS.md`、`CONTEXT.md` 或历史重定向目录。

### 1.2 与已有工作的衔接

**#119 先交付基础运行能力。** 完整 Pi/NuRouter/四基础工具及子进程在第三方 sandbox 中运行；业务服务独立持久化；统一 CLI 能访问服务；终态授权、请求幂等、长期操作和资源回收可验证。新 Execution 的干净环境和显式 Material 接续也属于该前置方向。阶段 02 在此之上定义零 Task 启动、有限 Bot、同一 Pi 的先读后写、独占 take/release、Task 策略及 Workspace main。不能把这些新增业务规则反向塞进 #119 的验收。

**#117 修复 Judge 的真实服务边界。** 需要 Judge 的本阶段验收必须使用可独立受理、保存输入、查询结果的 Judge 路径。若 #117 尚未完成，可以先做不需要 Judge 的机制切片；不能用 runner 回调模拟已完成的独立服务验收。Judge 不因此成为所有 Task 的强制裁判，也不负责替 Workspace 决定研究价值。

**#118 以实际合并结果为准。** 若它先落地，实施者应在新的固定基线上核对删除范围、保留 API 和 schema，再调整迁移清单。若未落地，本阶段切片必须处理真实存在的 legacy 路径，不能删掉说明而留下可执行入口。设计不把“某 PR 已打开”作为依赖满足证据。

## 2. 目标职责与必要接口

### 2.1 组件保持少量明确的权威事实

| 组件 | 目标权威事实与调用边界 | 对现有职责的迁移 |
|---|---|---|
| 启动器 / Mission 配置 | 目标、最终验收、允许服务、预算、停止条件、输入版本 | 从 benchmark 初始化第一条共享 Task，改为初始化 Mission 与 Workspace main 初始 commit / revision `0.1`；Task 可以为空 |
| Task Service | Task 合同、依赖、当前 owner、E 生命周期、协调权限、贡献受理与撤权顺序 | 删除“第一条 Task 特殊共享”规则；一个 Task 只能有一个当前 E，一个 Bot 最多绑定一个 E |
| Workspace 逻辑模块 | Workspace 身份、main 指针、公开版本、E 输入绑定、合入幂等与条件更新 | 建议部署在 Task Service 的同一协调进程和事务域；这是独立逻辑职责，不要求新增微服务 |
| Context Service | Material 正文/附件、不可变内容身份和来源、检索、使用及纠错关系 | 实际内容由 Context 持有；Workspace、Task、Judge 通过 API 读取，不能跨服务直接打开它的数据库 |
| Runtime | Core 容量、新 Bot/Pi/sandbox、物化输入、目录权限、绑定、预算监督、停止与对账 | 从可反复换任务的宿主 Session 监督转为有限 Bot；跨 E 不恢复私有会话或工作副本 |
| Judge / 领域服务 | 自己受理操作的输入、幂等记录、执行结果、费用与取消合同 | 移除 Task→runner→Judge 的隐式业务接力；服务能在 Bot 退出后完成已接纳操作 |
| Pi 四基础工具与 `swarm` CLI | 文件操作、help、参数、传输、请求 ID、结果呈现 | 业务动作经 Bash CLI 调服务；授权由服务和 Runtime 执行，CLI 不是安全边界 |
| Observation / UI / 分析 | 对权威记录的有版本投影、运行证据、解释清楚的成本与结果 | 不用投影反向授予权限、重写 main 或宣布 Mission 达成；保留未知和不完整证据 |

一个服务操作已经同步完成，不代表旧 Bot 继续有效。普通 CLI/API 请求在服务处理时验证当前 Execution，直接执行并返回；release 后旧 Execution 的新写请求被拒绝。若某项服务确实需要跨 sandbox 生命周期继续运行，由该服务单独定义异步接口。Workspace main 更新在 Workspace 本地操作中核对 E、candidate 和 expected revision；不建立当前 Execution 有效性校验协议。

### 2.2 新增或重建的接口面

以下是需要实现的**语义合同**。除各章用于审核的 CLI 示例外，不在设计中预先冻结内部类名、文件名或全部字段拼写。

| 接口面 | 必须可表达的操作和结果 | 必须同时具备的失败路径 |
|---|---|---|
| Mission / Workspace 初始化 | 受控输入发布、Mission 创建、Workspace v0 建立、稳定请求查询；不需要 E | 内容成功而初始化未完成可对账；不伪造 Task/Execution 来源 |
| 协调与选工 | 全状态 Task 查询、分页、提案、依赖、受限规格修订、take 及 take 请求查询 | 重复提案请求、旧规格、竞争失败、同 Bot 双重 take、无工作等待 |
| E 贡献与 release | 当前绑定、范围/预算、当前 Execution 绑定、范围/预算、普通写请求身份校验、完成或未完成 release | 迟到 grant、失联、重复 release、旧 E 请求、清理未确认、已接纳外部操作 |
| Material | 发布实际正文/附件、按 ID 读、搜索、Task 关联、使用记录、质疑/更正与消费者查询 | 内容/关联部分完成、缺附件、截断、同 request ID 改载荷、跨 Mission 越权 |
| Workspace | 读公开版本、导出候选、`advance` 条件更新、按 request ID 查结果 | 旧 main、错误输入摘要、过期检查、内容不可达、响应丢失、撤权后的请求 |
| Runtime / provider 控制 | 新环境、固定项目卷物化、可信权限开放、全进程停止、资源隔离、重启对账 | 部分创建、开放失败、关闭中迟到动作、provider 不可达、未确认清理 |
| 发送与观测 | 实际模型消息、工具输出、skill 读取、版本、成本、生命周期事件 | 组合但未发送、发送结果未知、输出截断、缺记录、观测落后于权威状态 |

Bot 对外使用 **`swarm material`** 处理 Material；`Context Service` 继续是实现组件名。[#119](https://github.com/LuNa-shi/SwarmEnv/issues/119) 中的 `swarm context` 属于待审旧提案，并非必须保留的既有正式命令。本阶段明确迁移为 `swarm material`，须同步初始 prompt、skills、help、示例、测试和 API 映射。若 #119 实施时已实际交付 `swarm context`，按第 7 节提供显式退役策略；不能让两套名称在新 prompt 中混用。

## 3. 现状到目标的关键差距

| 当前源码事实 | 目标及其迁移含义 | 关键实现与说明 |
|---|---|---|
| runner 创建 Mission 后先创建共享 Task；Task Service 按 Mission 第一条记录判定共享身份，允许多个 E | Mission 不可 take；空 Task 列表是合法启动状态；排他规则适用于全部 Task，不能仅把 `parallel_quota` 改成 1 | [runner](../../../src/benchmark/putnam-runner.js)、[Task Service](../../../src/task/task-service.js)、[现有 03](../../architecture/03-mission-task.md) |
| CLI / runner 默认仍有 `legacy`；Root/Child、parent review、结构依赖和多种终态仍可执行 | 新模型没有父任务管理树；旧配置、SDK、fixtures 和报表须一起迁移或明确保留只读解释 | [启动器](../../../scripts/run-putnambench-benchmark.mjs)、[Task 类型](../../../src/task/task-types.js)、[现有 07](../../architecture/07-run-configuration.md) |
| Core 的 Pi Session 可跨 Task 使用，register-and-take 可切换责任；rotation/recovery 往往保留 E | 新 Bot 可先阅读，成功 take 后只执行这一 E；release 后新 Bot/Pi/sandbox 补位。Runtime 重启对账不等于给后继恢复研究上下文 | [Runtime](../../../src/runtime/runtime.js)、[身份循环](../../../src/runtime/identity-task-loop.js)、[现有 02](../../architecture/02-execution.md) |
| `workspace_mode` 默认 `resume`，可选前任 E 的私有 revision；Runtime/WorkspaceManager 会克隆或恢复旧目录 | 所有新 E 仅从公开 main 和显式 Material 建副本；删除默认/显式 private resume 入口、旧私有对象回退和自动会话继承 | [WorkspaceManager](../../../src/runtime/workspace-manager.js)、[现有 05](../../architecture/05-workspace-continuity.md) |
| 现有 Workspace 是执行目录、manifest、revision 与本地 Git；其本地 `main` 不是项目共享权威 | 增加跨 E 持续存在的 Workspace 身份和 main 版本；所有公开版本都能由 Workspace 本地 Git Repository 的 commit 物化，不以宿主目录或私有 commit 代替 | [Workspace contract](../../../src/runtime/workspace-contract.js)、[03 设计](03-workspace-and-integration.md) |
| Context 的 Material 有全局 `role`；Task 的 `#linkMaterial` 要求它与每条关联 role 相同，并要求非空生产 Task/E | 同一 M 可是 T1 产物、T2 输入、T3 纠错依据；用途属于关联，生产来源不可改；受控初始输入允许无生产 Task/E | [Context](../../../src/context/context-service.js)、[Context schema](../../../src/storage/context-schema.js)、[Task schema](../../../src/storage/schema.js) |
| `judge.submit_candidate` 仍先经过 Task Service 与 runner 回调；检查和完成路径有不同门槛 | Judge 独立受理，明确输入、版本、返回结果；Task 完成、main 接纳和 Mission 验收各自按批准合同核对，不共享一个含糊的 PASS | [Judge](../../../src/judge/judge-service.js)、[现有 04](../../architecture/04-services.md)、[#117](https://github.com/LuNa-shi/SwarmEnv/issues/117) |
| Pi extension 注册大量 named tools；Bridge/Registry 仍有本地控制面和同步 router；远程 URL 不代表权威状态全部独立 | 承接 #119 的四基础工具与 CLI；身份来源、当前绑定、远程许可和服务持久性必须覆盖绕开 CLI 的直接请求 | [Bridge](../../../src/agent/services-bridge.js)、[extension](../../../src/agent/swarmenv-extension.mjs)、[router](../../../src/sdk/service-router.js) |
| 普通 `task_take` 使用 `sendInitialPrompt:false`；可记录未发送的完整组合快照，返回的 claim 还可能是激活前状态 | 初始规范确实发送；take 的结果在 active 与本地授权完成后返回实际绑定；记录发送事实，不以模板 hash 代替实际消息 | [prompt](../../../src/agent/agent-prompt.js)、[Pi adapter](../../../src/agent/pi-adapter.js)、[现有 08](../../architecture/08-prompts.md) |
| shell 写文件未必进入 manifest；Sandbox 前台退出码、后台期限和 runner preflight 顺序有已记录边界 | 候选导出读真实字节；命令结果及清理证据真实；先完成 #119 的真实集成，再验证本阶段先读后写，不能沿用这些缺口作验收替身 | [SandboxManager](../../../src/runtime/sandbox-manager.js)、[现有 09](../../architecture/09-known-boundaries.md) |
| report 使用 `child_task_count`、`scheduler`、活动型 `made_progress`；部分列表有截断；观察服务不具备统一认证/脱敏保证 | 新投影区分 Mission/Task/E/Material/main，阅读期成本不遗漏；历史字段有版本解释，UI 不越过私有数据边界 | [parallelism](../../../src/benchmark/parallelism.js)、[Observation Store](../../../src/observability/observation-store.js)、[现有 06](../../architecture/06-observability-experiments.md) |

这些改动不能靠更换名词完成。例如，给旧 Workspace 加 `workspace_id` 而保留前任私有 clone，或把共享 Mission Task 改名为“bootstrap Task”，都没有满足目标合同。

## 4. 全部代码分组到架构章节的映射

当前 [source-map.json](../../architecture/source-map.json) 收录 **91 项、13 个类别**。下表覆盖全部类别；具体 91 项仍以清单为准，不在阶段文档复制一份易过时的逐文件列表。表中的章节是实施后必须解释相应行为的位置，不能只加一个源码链接。

| source-map 类别 / 当前项数 | 本阶段涉及的完整职责 | 实施 PR 必须核对的 Architecture 章节 |
|---|---|---|
| `launch and composition` / 13 | 入口、配置与依赖锁定；零 Task bootstrap；服务拓扑；Core/Bot 创建；预算与停止；SDK exports；脚本及 real-Agent/fixture 入口 | [00 全流程](../../architecture/00-overview.md)、[07 启动](../../architecture/07-run-configuration.md)，并联动 01、02、03、05、06 |
| `Agent and prompts` / 6 | Pi 启动与路由；四工具；CLI/skills 可见性；身份绑定；初始消息和后续消息实际发送；版本 manifest；旧 Bridge/extension 退出 | [01 Agent](../../architecture/01-agent-core.md)、[08 Prompts](../../architecture/08-prompts.md)、[10 API](../../architecture/10-service-api-reference.md) |
| `Execution and control` / 5 | Core 复用而 Bot 不跨 E 复用；preparing/active/closing/closed；排他预留、grant、撤权、全进程停止、对账、等待和计时；Controller/Scheduler 留存边界 | [02 执行](../../architecture/02-execution.md)、[05 Workspace](../../architecture/05-workspace-continuity.md)、08、10 |
| `Mission and Task` / 2 | 无共享特例；Task 全状态/依赖/修订/提案；独占认领；局部完成与 Mission 验收；Material 关联与权限 | [03 Task](../../architecture/03-mission-task.md)、10、[11 Storage](../../architecture/11-storage-reference.md) |
| `Workspace and Sandbox` / 3 | provider 生命周期；只读到可写；公开快照物化；独立 Git；导出真实内容；main 接纳；干净后继；审计/回收隔离 | 05、[09 边界](../../architecture/09-known-boundaries.md)，并补 02、04、07、10、11 的新职责映射 |
| `services and contracts` / 18 | Context 内容/关系；Judge/领域运算；服务认证与普通 Service 请求中的 Execution 有效性/权限校验；幂等、错误、schema 验证；HTTP/本地适配；Registry/Catalog/help；测试 double 的非生产性质 | [04 Services](../../architecture/04-services.md)、10、11，联动 03、08、09 |
| `durable storage` / 3 | 新版本 schema、Task/E 独占与请求记录、Workspace 本地 Git Repository/main branch/revision、Material 关联、各 Service 自己的同步返回值；确需长操作时的服务专属异步状态、历史兼容及迁移约束 | 11、03、04，增加 02、05、06 所需关系说明 |
| `provider deployment and instructions` / 7 | 服务镜像、启动参数、持久卷、网络/凭据；Mathlib 与其他服务完整说明；挂载/发送的技能和 help 版本 | 04、07、08、10；引入 sandbox 镜像或新技能时扩展清单 |
| `observation and analysis` / 9 | 事件/投影/HTTP/SSE、离线导入与分析、Workspace 可见性、pre-E 成本、操作尾部费用、版本与未知值 | [06 观测](../../architecture/06-observability-experiments.md)、07，联动 08、11 |
| `dashboard and build` / 14 | Mission/Task/Bot/E/Material/Workspace 页面、状态解释、分页/实时对账、错误/权限呈现、构建入口和维护源 | 06、07；UI 所依赖的新 API 同步 10 |
| `generated served asset` / 3 | 观察服务实际发送的构建产物与维护源一致；不能只改 React 源而发布旧 UI | 06、07；[12 Coverage](../../architecture/12-code-coverage.md) 记录生成边界 |
| `controlled verification data` / 4 | 锁定 fixture 输入、有效/无效候选与 checker 身份；明确脚本验收和真实自主研究的区别 | 04、07、09；验证结果仍记录 Issue/PR 或版本绑定的实验报告 |
| `documentation tooling` / 4 | prompt/API/storage 生成、source fingerprints、映射完整性、链接与漂移检查；新增运行时输入的扫描规则 | 08、10、11、12、[INDEX](../../architecture/INDEX.md) 的更新规则 |

91 是当前清单大小，不是未来上限。新增 CLI、Workspace 协调模块、provider adapter、schema/migration、runtime skill 文件、启动配置或 UI 入口时，必须登记其实际路径和章责；删除文件时移除映射并说明旧行为如何终止。尤其不能因技能文件放在 `docs/` 或 `.codex/`，就沿用当前“开发文档默认不属于 runtime”的排除规则：**凡会被研究 Bot 挂载、读取或拼入消息的仓库文件都属于运行时输入，必须显式覆盖。**

测试和 `test-support/` 继续作为验证入口；原始运行记录不进入 runtime inventory。它们的排除不允许把生产 fixture、运行配置、打包脚本或实际服务说明从清单漏掉。外部 Pi/provider 内部实现不在 91 项之内，应记录依赖版本和边界，不能声称仓库手册解释了不可观察的外部上下文。

## 5. 纵向切片、依赖与回退

以下是建议实施顺序，尚未自动创建或批准 tickets。可以在一个 Issue 下使用多个 PR，也可以由负责人批准依赖图后拆分 Issue。每个切片都要形成一条可通过公开入口观察的闭环，并随代码更新架构、prompt 和观测；不能把“所有后端先写完，最后才补文档/实际发送/清理”作为切片策略。

### P0：#119 的可运行基础

**入口到出口：** 用真实固定版本 provider 启动一个完整 Bot，四基础工具操作同一私有工作面，CLI 调独立服务，持久发布内容；中断 CLI/重启服务/结束 sandbox 后查询已受理操作和材料，再以全新环境读取已发布输入。原私有目录不成为下一 E 的输入。

**依赖与验收：** 按 #119 已批准范围验收独立服务、身份/网络/卷、幂等、全进程停止及持久性。本阶段不把 Task 选工、方案 A 权限转换或 main 更新附加成它的隐藏成功条件。源码和 mock 是准备证据；Docker 后端必须有真实运行证据。当前文档环境无 Docker，P0 未在本次执行。

**回退：** 保留版本固定的旧部署供旧数据只读检查；新基础不通过时不启用 #122 新模式，不以宿主 Agent 或私有 resume 作为本阶段最终验收兜底。

### S1：从零 Task 到一段安全结束的贡献

**依赖：** P0，以及 #122 对 v1 生命周期、权限和数据版本边界的明确批准。

**闭环：** 创建 Mission、Workspace main 初始 commit/revision `0.1`；独立知识输入另存为 Material，Task 表为空；启动一个只读 Bot，展示并记录真实初始 prompt；Bot 读取/提出 Task、take 后保留同一 Pi，写自己的副本、发布最小有效 Material，再按完成或未完成 release。清理完成后用新 Bot 读取该 Material。补充双 Bot 竞争同 Task 和同 Bot 双重 take 的故障安排。

**必须一起交付：** 新 schema 的隔离运行边界、Task/E/Bot 排他、准备与关闭请求持久化、可信权限开放、普通 Service 写请求校验/撤权、无 E 成本、停止对账、实际 take 返回和最小 UI 事实。Material 单次发布自动绑定来源，只需足够完成此闭环，不提前宣称检索/纠错策略已完善。

**验收出口：** [05](05-validation-and-research.md) 的 V01–V08、V09–V13 中相关发布/授权路径，以及 V18、V20；通过真实 E2 的目录、直接服务旁路、迟到 grant、响应丢失、CLI 被杀和清理后拒写验证。E1 通过但 E2 未完成时，记录实现与未验证边界，不将新模式设为正式默认。

**回退：** 新 Mission 使用显式的新模式和独立版本状态；停止接受新 Bot，关闭/隔离已有 E，保留已受理服务操作、材料和费用。可以退回旧发布包处理旧模式数据，不能让旧二进制直接写新 schema。

### S2：跨 Bot 的材料接续、复用与纠错

**依赖：** S1；初始输入例外、Material 不可变来源和 Task 关系用途的合同已审阅。

**闭环：** B1 在 T1 发布部分成果后未完成退出；删除其研究可达环境。B2 从 Workspace 当前 main revision 和公开 Material/candidate 接续 T1；另一 Task 将同一材料作为输入；后续 Bot 发布反例/修正，读取者能发现关系并核对版本。任务提案先查询所有状态，真实依赖决定可领性。

**必须一起交付：** 去除 Material 全局 role 与关联 role 相等的限制；生产来源不变；有效分页/截断标记、实际内容读取、计划输入与实际消费区分、发布/关联中间态对账、修正及消费者可发现性。已有 completion/notification/help 对 role 的假设同步修改。

**验收出口：** V09–V15、V18、V20，并验证不能读旧私有卷、Pi 会话或未发布 Git 对象；成功发布的真实内容在原 sandbox 销毁后可物化。若一次崩溃没有留下材料，结果如实为无法接续，不由 Runtime 补造共享知识。

**回退：** 暂停新增关系/发布，保留不可变内容和关系日志；坏的检索投影可重建，不能删除原材料来掩盖错误。旧 API 如暂保留，只能按已声明版本解释历史记录，不能重新施加旧全局 role 约束破坏新关系。

### S3：普通 Task 使用 Workspace candidate 推进共同 main

**依赖：** S2；Workspace 事务边界、合入政策已批准；使用 Judge 的工作量还依赖 #117 的实际服务闭环。

**闭环：** 两个局部 Task 各自产生可读成果；新 Bot 认领普通整合 Task，在自己的副本合入和检查，保存完整 Workspace candidate，请求 main 条件更新；另一个基于相同旧 main 的候选冲突并重新整合。下一 Bot 实际取得新 main 内容。

**必须一起交付：** Task 服务内 Workspace 模块、公开版本及来源链、内容导出与安全校验、检查/candidate commit/政策绑定、CAS 与请求重放、错误 main 的补偿修正、UI 的候选/已接纳区别。Context 仍持有内容，不把“同进程部署”扩成直接读其他服务数据库。

**验收出口：** V16–V18，并复验相关 V09、V10、V13；Workspace candidate commit 可导入并物化，两个相同 expected Workspace revision 的 integrate 请求最多一项成功，修改候选后旧 PASS 不可复用，超时可查询原结果。Task done、Workspace integrate、Mission accepted 三类记录互不替代。

**回退：** 停止新 advance；保留已经发布的候选及已接纳版本。内容回退通过新修正候选推进一个后继版本，保留误入版本和检查证据；不得倒写 main 历史或把“回滚程序版本”当作撤销已发生服务副作用。

### S4：四个 Bot 的有限自主协作与受控评估

**依赖：** S1–S3；[04](04-prompts-and-skills.md) 全文、skills 内容和运行参数已固定；真实模型/provider/预算得到适用授权。

**闭环：** 四个 Core 从同一 Mission 自主读、提案、选工、竞争、执行、发布、整合和退出，由新 Bot 补位；至少包含未完成接续、材料纠错、main 冲突、全部任务暂不可领、阅读期和执行期预算结束。Bot 不被固定分配为四种角色。

**必须一起交付：** 完整按需 skills、空闲与事件唤醒、compaction 可观察信号及有限收尾额度、并发成本总账、所有实际发送路径、完整 UI/报告字段。前面切片已有的初始 prompt 和观测不得推迟到此才添加。

**验收出口：** 05 的 C0–C5 轨迹、V19–V20 和相应 E3 行为证据；脚本可验证机制，但不能替代自主行为。E4 质量/效率研究按预先批准的对照、重复次数和总预算执行，失败与未知值也进入报告；单次演示不声明协作收益。

**回退：** 可停止新 Bot、收窄到已验证的并发量或关闭某个未经验证策略，但改变正式研究条件必须在 Issue 留下批准和新版本。不能更改已发生实验的标签或省略 pre-E、整合和失败成本。

### S5：默认入口切换与旧路径退役

**依赖：** 前面机制和真实集成验收成立；数据迁移/还原演练完成；#118 实际合并范围重新核对；所有仍可执行兼容路径已有完整说明。

**闭环：** 从批准的普通启动入口启动新 Mission，完整完成一次目标工作；再以旧配置、旧命令、旧数据库和旧报表进行显式兼容/拒绝检查。操作者能看懂迁移结果、缺项和回退边界，不会因默认参数不同进入另一个任务模型。

**验收出口：** 不再创建共享 Mission Task；不再经隐式 fallback 私有恢复；新模式不暴露旧结构任务/同 Bot 换任务/named business tools；正常 CLI/help/SDK/镜像/配置/fixtures 使用一致合同。最终代码、Architecture、生成引用和证据共同复核；实施完成与研究收益结论分别记录。

**回退：** 发布前保留已验证的上一版本包、独立旧状态备份和版本化配置。回退先停止新写入并对账，不能把新格式状态交给旧 writer，也不默认丢弃已公开成果。若数据无法安全降级，只回退启动新任务的程序，历史新格式保持只读，按已批准的导出方案迁移。

## 6. Schema、数据与运行版本的迁移

### 6.1 必须显式版本化的状态

当前 schema 通过构造器补列和共享 SQLite 表承载多种模型；本阶段改变对象归属与生命周期，不适合只增加几列后沿用所有旧解释。建议对新 Mission 固定 schema/contract 版本，新旧运行写入域隔离；具体迁移 SQL 在获准实施时评审。

| 数据域 | 新合同最少需要记录 | 一致性与迁移约束 |
|---|---|---|
| Mission / Bot / Core | Mission 预算与验收版本；Bot/Core/sandbox 身份；阅读期起止和费用；有 E 时的绑定 | E 可以为空；没有 E 的模型或工具费用不得丢弃或归入假 Task |
| Task / E | Workspace、规格/状态版本、当前 E、Bot 唯一绑定、preparing/active/closing/closed、结束意图、关闭证据 | 独占检查必须在事务/约束中成立；未安全停止不能清掉 owner；历史 attempt 不变成活跃 owner |
| 请求 / 授权 | request ID、操作/输入摘要、Mission/Bot/E、生命周期版本、通用受理许可、结果或未知状态 | take、release、普通 Service 请求中的 Execution 有效性/权限校验和 main 更新与重复/迟到请求可对账；同 ID 换载荷拒绝 |
| Workspace / Git main branch | Workspace ID、Mission ID、main branch、Workspace revision、对应 Git commit、candidate、来源 Task/E 和检查引用 | Workspace Service 管理本地 Git refs；integrate 按 expected revision 条件更新；Material 不存 Git 快照 |
| Material / 关系 | 内容、摘要、媒体/附件清单、不可变生产来源、Evidence 自述、实际使用、disputed/superseded 与派生关系 | Material 不保存 Git main 快照；生产者与消费者分开，初始化输入可无生产 Task/E |
| 服务操作 | 具体长操作确需异步时由对应 Service 定义的输入、执行状态、费用、结果与取消合同 | Bot 结束后仍可查询；没有“总事务”自动撤销所有服务副作用 |
| 观测 / 报告 | schema/事件版本；生命周期、内容版本、发送证据和成本投影 | 权威数据可重建投影；历史缺失保持 unknown，不补成零 |

### 6.2 默认迁移方案：旧运行只读，新 Mission 显式起点

第一版优先从新的 Mission/Workspace 开始，不承诺把所有历史活跃研究无损热升级。实施 PR 应给出可重复的迁移与恢复命令、只读预览和结果报告，正式执行范围由批准 Issue 决定。

1. **停止旧 writer 并核对实际资源。** 停止新 take；结束或隔离已有执行，确认 Pi/子进程及旧凭据不能再贡献。已经受理的外部作业按合同完成/取消并计费。只有数据库写着终态不足以证明可以迁移。
2. **建立一致备份。** 记录 Task/Context/Judge 各自 schema 版本、数据库备份、Material 内容清单/摘要、公开输入、运行 manifest 和仍未结束操作。跨服务备份要标明协调边界；不可只复制一个 SQLite 文件就宣布可恢复全部内容。
3. **只读检查与分类。** 检查来源/附件缺失、重复活跃 owner、旧 role 依赖、无法解释的 Task 状态、指向私有目录的内容引用。迁移预览列出接受、拒绝、需要人工决定的记录及原因。
4. **初始化新 Workspace。** 负责人明确选择可公开、可物化的项目输入或历史 Material；验证实际内容，建立 v0。不能自动选择“最新 E 目录”或“最后一个 Git commit”，也不能把审计归档默认为共享资料。
5. **按需导入责任。** 真正需要继续的局部 Task 以明确合同、依赖和输入进入新 Mission，保留原系统标识与导入来源。旧共享 Mission Task 的目标可以帮助建立 Mission，但不再作为可认领占位任务。历史 E 保留为历史，新的执行从新 Bot、新 E 开始。
6. **启动兼容性检查并开放写入。** 新程序拒绝不支持的 schema/contract 版本；旧程序不得写入新状态。观察导入与 UI 先校验版本。核对新环境实际输入和可见性后才开放运行。

导入不修饰历史。旧材料没有可取回附件时标为内容不完整；旧记录只有“读取/消费”时不能推断实际有效使用；缺 Bot ID、prompt 实际发送或费用时不凭邻近事件补造确定事实。

### 6.3 状态与 role 不是机械替换

| 旧信息 | 导入原则 |
|---|---|
| `OPEN` | 无 owner 且新依赖合同满足才可映射 `ready`；否则解释阻塞 |
| `RUNNING` / `WAITING` / 活跃旧 E | 先完成停止/隔离，不把私有会话 resume 成新 active E；保留旧历史和结束原因 |
| `BLOCKED` | 重新解释实际前提；旧 parent-review、服务健康或结构阻塞不能一律变成“等某 Task done” |
| `DONE` / `SATISFIED` / `CLOSED` | 依据原合同区分局部达成、接收方关闭和结构状态；不能一律等同新 Task done，更不能等同 Mission accepted |
| `CANCELED` / `CANCELLED` / `FAILED` / `REJECTED` | 保留原终态语义；确实撤回的责任才映射 cancelled。单次失败不自动取消未来责任 |
| `materials.role` 与 `task_material_links.role` | 保留历史原值作导入元数据；新关联表达该 Task 的用途，不能用全局 role 阻止下游输入/纠错复用 |
| `source_task` / `source_execution` | 已有生产来源不可因复用而改写；受控初始资料允许为空，并另记上传者/输入来源；缺失历史来源保持不明 |
| `workspace_ref`、checkpoint、private Git commit | 只作为受限历史证据；只有经过显式发布、内容核对与可见性检查的 Material 才能成为新研究输入 |

取消 role 相等校验只是第一步。还要审查 Task completion 对 `material.role` 的匹配、handoff 必须专门 role 的限制、定向 response 通知、Context 搜索、SDK schema、UI 筛选和生成 help。否则表面允许跨 Task link，完成检查仍会按旧全局角色拒绝合法结果。新关系必须保留权限和来源校验，不能用“用途自由”放开修改他人生产事实。

## 7. 旧命令、私有恢复与兼容路径退役

### 7.1 应移除或明确替代的路径

| 旧路径 / 假设 | 目标处理 | 删除时必须连带核对 |
|---|---|---|
| 第一条 Task 为共享 Mission Task；并行 claim 特例 | 移除创建顺序判型及共享 claim/block/completion 分支 | runner 初始化、任务列表/可领性、预算、Mission 完成、报表与测试 |
| Root/Child、required children/branch groups、parent review 和结构等待 | 按 #118 实际范围退役；需要的依赖改成明确 Task 依赖 | CLI 默认、通用 SDK、catalog、fixture、rework/wake、旧状态投影 |
| `task_register(take:true)` 同 Session 换 Task | 提案与 take 分离；已经绑定的 Bot 不再 take 第二项 | Bridge 回调、Runtime detach、checkpoint、prompt 示例、并发请求 |
| `workspace_mode=resume`、source E/path/revision、waiting/rework 私有恢复 | 新模式拒绝 private resume；仅允许明确公开 main/Material 输入 | claim 默认、clone/restore 分支、缺快照时 live-file fallback、旧 workspace 指针复用 |
| rotation/recovery 自动继承私有上下文 | 新 Bot 只读公开资料；同一活跃 E 的 Runtime 重启仅做状态/进程对账 | Pi session 目录、工具历史、checkpoint 提示、recovery prompt、隐藏文件/卷及 Git objects |
| `execution_progress` 的隐式 checkpoint/发布/handoff 组合 | 改为显式 Material 发布和 release 合同；必要内部审计 checkpoint 不变成共享知识 | 完成门槛、自动提醒、进度统计、旧 tools/help/SDK；不新增 Progress 核心对象 |
| named business tools、业务 Workspace/Sandbox tool 代理 | 承接 #119，Bot 使用四工具与 CLI；可信 Runtime/provider 控制面不暴露给 Bot | extension、profile、Bridge、registry、启动参数和旧别名入口 |
| `swarm context` 旧提议或已交付入口 | 新标准为 `swarm material`；仅在实际已交付且需要兼容时设有版本/期限的同义转发 | 参数、结果、错误、request ID 语义必须相同；help 明示退役，最终删除并给出迁移错误 |
| Task→runner→Judge 私有提交回调 | 由 #117/获准实施提供直接独立 Judge 服务合同 | Task candidate 状态、输入/fixture 绑定、检查返回和后续完成；不能仅改工具名称 |
| 旧 report `child_task_count` / `scheduler` 与 Task 概念混用 | 新格式明确 Task/Bot/E；历史 importer 按版本解释 | 分析脚本、UI、公开 exports、例子和既有实验报告；不改写历史结果 |

这里的“移除”是目标清单，不能预先声称对应文件已删除。某文件可能继续承担其他职责，例如 Registry 仍可提供服务发现，Runtime 仍需 fencing，WorkspaceManager 仍可物化公开快照；应删除不符合合同的行为和入口，而非为了目录整齐机械删整文件。

### 7.2 在真正移除之前必须继续写清的兼容行为

实施分支若仍能调用下列路径，Architecture 就必须解释它们的入口、默认值、实际授权、状态变化、错误和限制：legacy CLI 默认；Root/Child 及 parent acceptance/rework/wait；共享 Mission Task；独立导出的 Scheduler；generic SDK/catalog 与 normal Agent profile 的差异；script/real-Agent fixture；私有 resume/recovery；named tool Bridge；本地同步 router 和跨库依赖；候选提交 callback；旧配置及 report/importer 字段。

短期兼容必须满足三点：**入口能辨认版本、旧 writer 不接触新状态、新模式没有自动 fallback。** CLI 别名只能转发同一授权语义，不能借旧命令获得 private resume 或免 E 发布。只读历史解析器可以比运行时写接口保留更久，但要在 source-map 和架构中标明用途。删除旧写接口前应确认正常 CLI、公开 exports、服务 manifests、构建产物、部署配置和 fixtures 都已迁移；仅让模型不再看到它，不等于它不可调用。

## 8. 观测、实际 prompt 与版本绑定

### 8.1 UI 和记录必须显示的新事实

| 视图 / 数据流 | 本阶段必须表达的内容 | 不允许的混淆 |
|---|---|---|
| Mission 首页 | 目标与验收、Workspace 本地 Git Repository/main branch/revision、全部 Task 状态、总体预算与停止原因 | 不用一条隐藏 Mission Task 充当项目；无可领工作不等于达成目标 |
| Core / Bot / E 时间线 | Core 可复用；Bot 阅读期；E preparing/active/closing/closed；后继 Bot；实际停止/隔离证据 | 准备/清理期间的 Task 仍占有；收到 release 不等于 sandbox 已停止 |
| Material | 实际内容、生产 Task/E 或输入来源、各 Task 的用途、读取/消费版本、质疑与更正 | 全局 role 不代表所有用途；发布数、读数、consume 自报不代表知识正确或有收益 |
| Workspace | main 版本/候选/来源/检查，CAS 成功与冲突，下一 E 的实际基线 | 本地 Git commit 或已上传候选不表示 main 前进；main 已接纳不证明全部主张 |
| 服务请求 | pending、已受理、结果未知、成功/失败/取消，许可与撤权顺序，旧 E 尾部操作 | 请求超时不自动失败；Bot 结束不自动撤销已接纳工作或费用 |
| 成本 / 研究报告 | 阅读、提案、检索、skills、执行、整合、等待、重试、失败及外部操作总成本 | 不漏计无 E 费用；区分单 Core 与总资源；同一服务费用不能在请求和 Task 汇总重复相加 |
| Prompt / skill 证据 | 具体发送事件、消息类型/顺序、内容身份、版本、输出截断与缺记录 | “已挂载”“已组合”“已发送”“已读取”是不同事实；任何一项都不证明 Bot 遵从 |

Observation Store 和 UI 是投影。事件丢失或落后时，应能从权威服务重新读取并标注不完整，而不是从旧 UI 状态触发认领或合入。API、分页、SSE 重连和报告导入都要随版本迁移；不能只改标签。维护源和实际 served assets 一起构建并复核。

现有 observer 的直接 Task/Context/Workspace/report 路由不具备普遍的认证与脱敏保证。新部署必须按实际身份区分研究可读内容和操作者审计；私有卷、对话、凭据和原始 tool 输出不能经 UI、搜索或下载接口回流给后继。将页面称为“只读”或对几个字段做截断都不能证明这条边界成立。

### 8.2 全部仓库控制 prompt 的文档范围

[04](04-prompts-and-skills.md) 是拟议文本及策略合同；实施后的 [Architecture 08](../../architecture/08-prompts.md) 必须写实际安装和发送的版本。完整覆盖至少包括：

- 稳定 system addendum、零 Task 的初始 user 消息、Mission/Workspace/预算动态字段、目录与装配顺序；字段缺失与默认值也要解释。
- 未绑定阅读、提案与 take 的指令；实际 take 返回；普通执行继续、等待/唤醒、预算和 compaction 收尾、release 拒绝、故障/重启通知及仍存在的 legacy 路径。
- 四基础工具的仓库配置、CLI help/schema/错误文本、服务说明，以及通过 Bash/read 返回给模型的材料、任务、检查结果、通知和 lifecycle rejection。
- 所有 runtime skills 的**完整正文**、目录、适用条件、版本/hash、安装来源、读取方式；缺失或版本不一致的行为。目录出现某 skill 不代表它的正文已进入模型上下文。
- 工具结果的截断、格式化、重试/超时提示，以及 Pi/provider 产生的 compaction/内部上下文边界。仓库无法提供的外部文本必须标明未知，不能从模板反推。

生成器应覆盖新增消息 producer/sender、技能资源和 CLI help，而不只导出 `agent-prompt.js` 的常量。安全的合成动态示例帮助读者理解最终装配；它必须标为示例，不能当成真实运行 transcript。

### 8.3 实际发送记录的最低合同

每条仓库控制消息应能关联 run、Mission、Bot、Core、Session、可空 E、消息序号、类型、生成源、模板/skill 版本、动态输入版本、最终内容摘要和发送结果。实现应区分“组合完成”“尝试发送”“适配器确认接收/写出”“发送失败或结果未知”，并说明具体确认点；单个 `runtime.initial_prompt_composed` 事件不够。

tool result 也属于模型输入。必须记录 **实际返回边界** 的内容身份及截断信息，不能只保存服务原始响应的 hash。Bash/read 加载 skill 时，应关联实际读到的文件版本、范围和返回给 Pi 的输出；可用目录、文件打开事件和整篇 skill 已发送不可互相代替。无需为证明记录完整而强制每个 Bot 全量加载全部 skills。

原始消息、必要动态内容和工具输出留在受控、忽略提交的运行证据中；公开 Issue/PR/实验报告只含脱敏投影、版本、摘要和可审查的结论。不要把凭据放进 prompt，也不要把完整私有会话提交到架构文档。记录目标是可核对外部输入和输出，不要求公开私有思维过程。仅有 hash 而缺少可授权取回的原内容时，应诚实标为不能完整重建。

### 8.4 同一次运行应绑定哪些版本

运行 manifest 至少固定：实现 commit 和 dirty 状态、所采纳设计/批准记录、schema/协议版本、CLI/help、prompt/composition、skills 内容、服务 manifest、provider/镜像 digest、Pi/NuRouter 与领域工具链、Mission 验收/合入政策、预算及 compaction 配置。每个 E 另固定 Task 规格、实际 main 基准、输入 Material 内容身份、授权生命周期版本。

take 前后 main 改变时，返回实际物化版本并记录需要重读的变化；执行中不后台替换副本。检查记录必须绑定候选内容、输入、checker/环境及适用政策，不能把某个旧 PASS 用在新快照。若部署升级改变这些合同，应选择新运行/新 E 或有明确协议的受控切换；不能在活跃 E 中静默替换 skills、checker 或 service schema。

历史实验保留原版本和缺口。更新 Architecture 或导入新版 UI 不会让旧运行自动拥有“干净接续”“完整 prompt 追踪”或新的验收结论。

## 9. 每个实施 PR 与阶段结束的架构交付

### 9.1 同一个 PR 必须同时交付什么

每个影响 runtime 的 PR 都要让负责人**不读源码也能理解实际执行**。对受影响的完整流程，Architecture 至少说明入口与调用者、输入/defaults、权限与版本 guard、调用/事件顺序、持久与内存状态写入、输出、失败/重试/超时、清理和观察证据。新增正常路径而遗漏原失败路径，不算完成说明。

PR 需要完成以下工作，而不是留下“以后补架构”的任务：

1. 对照 source-map 标出全部受影响代码组与章节，添加/删除实际文件映射；确认 runtime skills、配置、部署、UI 和构建输入没有漏项。
2. 更新解释性章节，保留该树中仍可执行的兼容行为；把已解决的边界从 09 中按实际代码重写，把未解决问题明确留住。
3. 更新所有仓库控制 prompt/skills 正文、装配条件、动态值来源和真实 sender；对应 API/help/schema 与 storage 解释一致。
4. 运行 `npm run docs:generate`，审阅完整 prompt、API、storage、source fingerprint 差异；再运行 `npm run docs:check` 与 `git diff --check`。代码 PR 按影响与既定要求执行相关测试及可用的 `npm test`；不能用生成成功代替行为验证。
5. 在 PR 说明代码组→架构章节、实际运行的检查、未运行原因和剩余边界；将本切片验收和有意义的诊断结果链接到 Issue。没有真实 Docker/provider 条件时明确记录未验证，不写“安全隔离已通过”。

`docs:check` 是覆盖、漂移和链接门槛，不检验叙述是否完整，也不判断模型是否正确理解指令。source-map 有 91/未来 N 个条目只说明文件已归类，不能代替对各分支的语义审阅。若 PR 声称没有架构影响，应给出具体理由；修改发送条件、错误格式、默认配置或生成 served asset 通常仍有架构影响。

### 9.2 阶段结束需要一次完整对账

阶段结束不能只汇总各 PR 的绿色检查。应固定最终 merged commit，重新走通从启动、零 Task 阅读、提案/take、产出/使用、main 更新、release、清理补位到 Mission 停止的整条流程，并核对异常、预算和直接服务旁路。

| 对账对象 | 阶段完成时要能回答的问题 |
|---|---|
| Architecture 00–07 | 目标职责是否已经对应真实入口、默认值和部署？一条普通运行及失败路径是否无需读源码就能理解？ |
| 08 与完整 prompt/skills 引用 | 每种实际输入从何处生成、何时发送、被什么条件省略？模板、快照和真实发送是否明确分开？ |
| 09 Known boundaries | 剩余缺口是否真实、可见并与 Issue 决定一致？已解决项是否有对应版本证据？ |
| 10–12、source-map、生成器 | 全部代码/API/storage/运行时资源是否纳入？生成产物、正文和文件指纹是否一致？ |
| 数据与兼容 | 新/旧 writer 是否隔离？旧命令、私有 resume、legacy/SDK/fixture 默认实际还剩什么？迁移及恢复是否演练？ |
| 安全与集成 | 真 Docker/provider 的目录/身份/服务拒写、全进程停止、管理面隔离、私有数据可见性是否有证据？ |
| 行为与研究 | E1/E2/E3/E4 各自达到哪层？任务机制成立、Bot 遵循策略、质量/成本收益是否分开陈述？ |
| Issue 与授权 | 最终行为、接受的限制、实验条件和费用是否在已批准范围？关闭依据是否链接真实代码与证据？ |

之后再在 Issue 记录阶段完成与剩余工作。文档里的目标不能因为阶段到期自动变成“已实现”；未达门槛的条目仍是缺口，不借新 ADR、状态文件或重新命名来消除。

## 10. 批准前需要明确的事项

用户已确定的方向不需要重新采访：Mission 共享而不可 take；Task 独占；Workspace 是核心对象且包含 main；同一 Pi 先读后写；跨 E 通过公开 Material 接续；初始 prompt 与按需 skills 都要完整设计。下面是负责人可以在 #122 对整份设计 revision 一并审阅的 v1 方案与实际未知项。

| 审阅项 | 本稿建议 / 当前边界 | 需要什么才能进入实施或验收 |
|---|---|---|
| 生命周期与接口 | 采用 01 的预留→物化→active→开放权限、普通 Service 请求中的 Execution 有效性/权限校验与 closing 后停止；以当前上下文中的 CLI 拼写为设计候选 | 明确采纳文档 revision 和实施范围；若字段/接口调整改变行为，回到 Issue 决定 |
| Workspace 部署 | 首版位于 Task Service 协调进程/事务域；Context 独立持有内容 | 实施中确认事务与 API 边界，不擅自扩成新微服务平台 |
| provider 和权限 | OpenSandbox Docker 是 #119 的候选；非 root、受保护父目录、管理面隔离和可靠全进程停止必须验证 | 固定实际版本/镜像/配置的 E2；当前没有 Docker、尚未运行，不承诺现成 API 已满足全部要求 |
| Task/Material 关系 | 用途放关联，保留生产来源；不新增 Progress/CheckResult/Feedback 核心对象 | schema/API/completion/通知/UI 一致变更，输入初始化例外受控 |
| 合入与 Mission 验收 | 每 Mission 固定政策；自动接纳仅在批准政策内；需要人工审批的项目保留对应门槛 | 选定工作量和可信检查输入/版本；未定义政策时不能按“没有失败”放行 |
| compaction / 收尾预算 | 阈值和次数配置化，使用适配器实际可观察信号；示例 3 次/80% 不是固定规则 | 确认信号可用性、预留收尾额度和硬停止行为，再绑定运行配置 |
| 历史数据 | 默认旧运行只读、新 Mission 显式输入；额外导入需预览与来源报告 | 明确需保留/导入的数据范围；不自动公开、删除或恢复私有研究状态 |
| 真实模型和研究 | 按 05 分层验证；新机制不预设策略必然有效 | 获得对应 provider/model、时间、重复次数和总预算授权；完整设计审核本身不授予这些资源 |
| 后续工程工作 | 先完成基础，再按纵向切片实现，状态在 Issue/PR | 负责人可同时批准明确的实施切片；若只批准本次设计，则不能推定已授权 runtime 改动、合并或付费实验 |

未知项不阻止本次把完整设计写清；它们决定后续切片的入口和证据门槛。实现期间若出现合同冲突，应在原 Issue 记录可核对的差距、建议和成本影响，由负责人决定是否改变目标，而不是让兼容方便或一次运行结果悄悄重写研究方向。
