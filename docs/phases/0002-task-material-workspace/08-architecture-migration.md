# 08. 架构迁移、实施切片与文档交付

> 设计附件：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)。本文连接已确认的目标合同与实施迁移，**不是已经实现的 Architecture，也不构成 runtime 实施或付费运行授权**。
> 历史迁移起点（不是最新 main 的缺口清单）：下文“当前/现状”均指本设计审核时的固定代码；最新运行实现见 [Architecture](../../architecture/INDEX.md)。对照固定为当时 main [`1d9be9f8146a57ba50d769615045c21a03c215bd`](https://github.com/LuNa-shi/SwarmEnv/commit/1d9be9f8146a57ba50d769615045c21a03c215bd)，替代原设计对照 `008ecdb9ab64adcd8135042ff2160ec1db704952`。该版本已包含 [#119](https://github.com/LuNa-shi/SwarmEnv/issues/119) / [阶段 01](../0001-sandbox-services-cli.md) 的 OpenSandbox、独立服务部署与 CLI 切片，flat-only 入口清理，以及 [#117](https://github.com/LuNa-shi/SwarmEnv/issues/117) / [ADR 0019](../../adr/0019-direct-judge-workspace-submission.md) 的 direct Judge 提交。现状按此代码树与对应手册核对，不以 Issue 是否关闭或 [PR #118](https://github.com/LuNa-shi/SwarmEnv/pull/118) 是否合并推断；这些前置实现也不等于本阶段目标和真实环境验收已完成。

本章把 [01 Core Runtime](01-model-and-runtime.md)、[02 Sandbox](02-sandbox-runtime.md)、[03 Task](03-task.md)、[04 Material](04-material.md)、[05 Workspace](05-workspace.md)、[06 Prompt/Skills](06-prompts-and-skills.md) 和 [07 Validation](07-validation-and-research.md) 连接到当前实现。它回答改动落在哪里、哪些能力必须一起交付、怎样迁移已有数据、何时可以停用旧接口，以及每个实施 PR 怎样交付可独立阅读的完整架构说明。

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
10. [已确认合同与实施门槛](#10-已确认合同与实施门槛)

## 1. 事实、设计与批准的边界

### 1.1 三种记录各自说明什么

| 记录 | 本次怎样使用 | 不能推断什么 |
|---|---|---|
| 固定 main `1d9be9f8…` 的源码、schema 和现有测试 | 核对现在存在的入口、状态、依赖和兼容路径；原 `008ecdb9…` 仅作历史差异对照 | 测试文件存在不表示本次运行过，也不表示真实隔离成立 |
| [Architecture](../../architecture/INDEX.md) 及 [source-map.json](../../architecture/source-map.json) | 实现手册、覆盖清单及后来落地的更新；清单的 runtime baseline 同步为 `1d9be9f8146a57ba50d769615045c21a03c215bd`，包含当前 101 项映射；PR #116 仍是原始手册的历史出处 | baseline 只固定本轮对照代码树；源文件指纹、受影响流程的语义复核和实际运行验收是不同证据，不能仅改字符串或重新生成就宣称全分支验证 |
| 本阶段模块化设计文档与批准 Issue | 说明建议实现的完整目标及迁移合同；由 Issue 指明采纳的文档 revision | 文档审核通过不证明代码已实现、真实 Bot 已表现良好或预算已获准 |

本次文档 PR 可以调整阶段目录规则、链接和相应文档检查；这与后续改变 Swarm 运行行为是不同工作。它不将未来 `swarm` 命令、Workspace 主线或新状态写成当前 API。

进展、阻塞、实施 PR、已执行检查和批准决定记录在 #122 或经批准的后续 Issue/PR。本文的切片表是依赖设计，不是待勾选的第二套状态账本；不创建阶段 `STATUS.md`、`CONTEXT.md` 或历史重定向目录。

### 1.2 与已有工作的衔接

**#119 已交付接入切片，完整生命周期仍按其批准合同验收。** 当前基线已有 OpenSandbox provider / worker、按 E 准备干净目录、文件同步、独立服务部署和 `swarm` CLI。最新 #119 的目标范围还包括每 Bot 新 sandbox/Pi、take 前只读、take 后准备独立 E 工作目录并授权、一个 Bot 最多一个 Task、finish/超时后停止全部进程并销毁环境；现有接入不能自动证明这些合同全部成立。阶段 02 定义 Task、Material、Workspace 与最终 Mission 提交的业务合同，#119 负责对应 Provider/Runtime/CLI 能力；新增业务策略不能作为其无关接入能力的隐藏门槛。零 Task 提案、动态依赖、版本保存/合入等完整协作在本阶段切片验收。

**#117 的 direct Judge 路径已进入当前基线。** Bridge 从当前 Execution Workspace 读取文件并附来源证明，经 Registry 直接调用 Judge；Task Service 和 runner 已不是提交处理器，PASS 与 Task 完成分开。后续直接复用这一职责边界，补齐本阶段公开 revision、最终合成树与 Mission 提交快照的绑定，并验证实际部署；不再把删除 runner 回调列为未开始的实现工作。Judge 不因此成为所有 Task 的强制裁判，也不负责替 Workspace 决定研究价值。

**#118 相关清理以实际代码树为准。** 当前 benchmark CLI 和 exported runner 已只接受 flat Mission Task 模型，旧模式选择参数被拒绝；这些事实不依赖 #118 的 PR 状态。仍存在的 Runtime、历史 schema、fixture 或只读报告兼容路径要逐项核对，不能由正常入口 flat-only 推断全部旧状态与辅助入口已删除，也不能把已删除的旧默认路径重新写成待实现目标。

## 2. 目标职责与必要接口

### 2.1 组件保持少量明确的权威事实

| 组件 | 目标权威事实与调用边界 | 对现有职责的迁移 |
|---|---|---|
| 启动器 / Mission 配置 | 目标、最终验收、允许服务、预算、停止条件、输入版本 | 从 benchmark 初始化第一条共享 Task，改为初始化 Mission 与 Workspace main 初始 commit / revision `0.1`；Task 可以为空 |
| Task Service | Task 合同、依赖、当前 owner、E 生命周期、协调权限、贡献受理与撤权顺序 | 删除“第一条 Task 特殊共享”规则；一个 Task 只能有一个当前 E，一个 Bot 最多绑定一个 E |
| Workspace 逻辑模块 | Workspace 身份、main 指针、公开版本、E 输入绑定、合入幂等与条件更新 | v1 部署在 Task Service 的同一协调进程和事务域；这是独立逻辑职责，不要求新增微服务 |
| Context Service | Material 正文/附件、不可变内容身份和来源、检索、使用及纠错关系 | 实际内容由 Context 持有；Workspace、Task、Judge 通过 API 读取，不能跨服务直接打开它的数据库 |
| Runtime | Core 容量、新 Bot/Pi/sandbox、物化输入、目录权限、绑定、预算监督、停止与对账 | 从可反复换任务的宿主 Session 监督转为有限 Bot；跨 E 不恢复私有会话或工作副本 |
| Judge / 领域服务 | 自己受理操作的输入、幂等记录、执行结果、费用与取消合同 | 承接已落地的 direct Judge 边界，绑定公开 revision / 最终检查快照；服务能在 Bot 退出后完成已接纳操作 |
| Pi 四基础工具与 `swarm` CLI | 文件操作、help、参数、传输、请求 ID、结果呈现 | 业务动作经 Bash CLI 调服务；授权由服务和 Runtime 执行，CLI 不是安全边界 |
| Observation / UI / 分析 | 对权威记录的有版本投影、运行证据、解释清楚的成本与结果 | 不用投影反向授予权限、重写 main 或宣布 Mission 达成；保留未知和不完整证据 |

一个服务操作已经同步完成，不代表旧 Bot 继续有效。普通 CLI/API 请求在服务处理时验证当前 Execution，直接执行并返回；Task finish 后旧 Execution 的新写请求被拒绝。若某项服务确实需要跨 sandbox 生命周期继续运行，由该服务单独定义异步接口。Workspace main 更新核对 E、确定的源 revision、最终检查和当前 main；不建立通用许可协议。未绑定 Bot 可进行已声明的 Mission 协调操作，包括正常退出和最终提交；这些例外不允许无 E 发布研究成果。

### 2.2 新增或重建的接口面

以下是需要实现的**语义合同**。除各章用于审核的 CLI 示例外，不在设计中预先冻结内部类名、文件名或全部字段拼写。

| 接口面 | 必须可表达的操作和结果 | 必须同时具备的失败路径 |
|---|---|---|
| Mission / Workspace 初始化与提交 | 初始公开输入、Mission/Workspace、最终 submit 和提交结果查询；允许协调身份无 E 提交 | 初始化对账；固定 main/Material/checker/环境；单活跃提交；main 冻结、失败仅释放自身冻结、迟到结果拒绝 |
| 协调与选工 | 跨状态相关 Task 查询、分页、提案、take/请求查询、无 E 的 bot exit | 同 Bot 双 take、认领竞争、选工预算结束、退避与事件等待；不提供通用 revise |
| Task / E 收尾 | done/incomplete/blocked/cancelled；动态等待；无 owner Task 取消与失效依赖替换 | 依赖/finish 原子记录、环检查、取消不满足依赖、清理前不释放 owner、迟到写入拒绝 |
| Material | 正文/附件发布、读取/检索、关联/实际使用、dispute、整份 supersede 与窄 unsupersede | 新版完整承接、旧版默认隐藏；关系 CAS/无环、错误关系撤销、内容/关联部分完成和幂等 |
| Workspace | files/read/search、history/diff、稳定 save、显式 apply、三方 merge、请求结果查询 | 未合入 revision 可读；后台写/dirty 保护、parents、最终树检查、CAS、Git/索引恢复；无独立 Candidate ID/CLI |
| Runtime / provider | 固定路径预留、受控输入物化、active 后授权、稳定保存/安装、全进程停止和重启对账 | 部分准备、迟到 grant、save/apply 与 finish 竞争、软收尾与硬停止、provider 不可达 |
| 发送与观测 | 实际消息/工具输出/skill 读取、版本、成本和生命周期 | 未发送、结果未知、截断、缺记录、投影落后；不把显示状态当权威授权 |

Bot 对外使用 **`swarm material`** 处理 Material；`Context Service` 继续是实现组件名。当前 [CLI](../../../src/cli/swarm-cli.js) 已交付 `swarm context`，本阶段明确迁移为 `swarm material`，须同步初始 prompt、skills、help、示例、测试和 API 映射，并按第 7 节为现有入口提供显式退役策略。不能再把 `swarm context` 称为尚未交付的提案，也不能让两套名称在新 prompt 中混用。

## 3. 现状到目标的关键差距

本节只列实施迁移工作。旧代码不会自主提案、Session 复用或私有恢复等事实，不用于判定新设计存在缺陷；设计评价假设目标合同已被忠实实现。

| 当前源码事实 | 目标及其迁移含义 | 关键实现与说明 |
|---|---|---|
| runner 创建 Mission 后先创建共享 Task；Task Service 按 Mission 第一条记录判定共享身份，允许多个 E | Mission 不可 take；空 Task 列表是合法启动状态；排他规则适用于全部 Task，不能仅把 `parallel_quota` 改成 1 | [runner](../../../src/benchmark/putnam-runner.js)、[Task Service](../../../src/task/task-service.js)、[现有 03](../../architecture/03-mission-task.md) |
| CLI / exported runner 已固定 flat Mission Task；移除的 Task 模型参数被拒绝。历史 schema、Runtime 和 fixtures 的保留范围仍须按入口辨认 | 不重复实施 legacy 默认切换；保留已完成清理，继续核对旧配置、SDK、fixtures 和报表的实际兼容用途，不能恢复父任务管理树 | [启动器](../../../scripts/run-putnambench-benchmark.mjs)、[Task 类型](../../../src/task/task-types.js)、[现有 07](../../architecture/07-run-configuration.md) |
| Core / Session 与 E 仍是不同身份；当前手册保留 register-and-take、rotation/recovery 等路径，OpenSandbox 则按 E 创建环境 | 统一为新 Bot 可先阅读、成功 take 后只执行这一 E；Task finish/超时后新 Bot/Pi/sandbox 补位。Runtime 重启对账不等于给后继恢复研究上下文 | [Runtime](../../../src/runtime/runtime.js)、[身份循环](../../../src/runtime/identity-task-loop.js)、[现有 02](../../architecture/02-execution.md) |
| OpenSandbox runner 对新 E 启用 clean preparation；通用 Workspace/Runtime 仍有私有 resume/clone/recovery 语义，同一 durable E 可使用其旧引用 | 所有新 E 只从公开 Workspace revision 物化文件、从 Material 读取研究内容；不能把 clean 路径存在等同于所有私有回退已退役 | [WorkspaceManager](../../../src/runtime/workspace-manager.js)、[现有 02](../../architecture/02-execution.md)、[现有 05](../../architecture/05-workspace-continuity.md) |
| 现有 Workspace 是执行目录、manifest、revision 与本地 Git；其本地 `main` 不是项目共享权威 | 增加跨 E 持续存在的 Workspace 身份和 main 版本；所有公开版本都能由 Workspace 本地 Git Repository 的 commit 物化，不以宿主目录或私有 commit 代替 | [Workspace contract](../../../src/runtime/workspace-contract.js)、[05 设计](05-workspace.md) |
| Context 的 Material 有全局 `role`；Task 的 `#linkMaterial` 要求它与每条关联 role 相同，并要求非空生产 Task/E | 同一 M 可是 T1 产物、T2 输入、T3 纠错依据；用途属于关联，生产来源不可改；受控初始输入允许无生产 Task/E | [Context](../../../src/context/context-service.js)、[Context schema](../../../src/storage/context-schema.js)、[Task schema](../../../src/storage/schema.js) |
| `judge.submit_candidate` 已经 Bridge / Registry 直接到 Judge，绑定当前 Execution Workspace 文件；Task 完成仍是显式独立操作 | 承接 direct 路径，将检查绑定扩展到本阶段公开 revision / 最终合成树；Task 完成、main 接纳和 Mission 验收各自按批准合同核对，不共享一个含糊的 PASS | [Judge](../../../src/judge/judge-service.js)、[现有 04](../../architecture/04-services.md)、[ADR 0019](../../adr/0019-direct-judge-workspace-submission.md) |
| `swarm` CLI 与 isolated service hosts 已存在；Pi extension 正常 profile 仍注册 named business tools，Bridge/Registry 也保留本地控制面和同步 router | 复用现有接入并统一到四基础工具与 CLI；身份来源、当前绑定、远程许可和服务持久性必须覆盖绕开 CLI 的直接请求，不能仅凭远程 URL 推断全部状态独立 | [CLI](../../../src/cli/swarm-cli.js)、[Bridge](../../../src/agent/services-bridge.js)、[extension](../../../src/agent/swarmenv-extension.mjs)、[router](../../../src/sdk/service-router.js) |
| 普通 `task_take` 使用 `sendInitialPrompt:false`；可记录未发送的完整组合快照，返回的 claim 还可能是激活前状态 | 初始规范确实发送；take 的结果在 active 与本地授权完成后返回实际绑定；记录发送事实，不以模板 hash 代替实际消息 | [prompt](../../../src/agent/agent-prompt.js)、[Pi adapter](../../../src/agent/pi-adapter.js)、[现有 08](../../architecture/08-prompts.md) |
| shell 写文件与旧 Workspace manifest 的一致性、compatibility Docker provider 的命令结果/后台期限仍有边界；OpenSandbox 另有同步与清理合同。旧 preflight 日志访问未初始化变量的问题已在当前 runner 修正 | 稳定保存读取真实字节；分别验证实际 provider 的结果、同步与全进程清理；不把旧 provider 缺口或已修正问题沿用为当前 OpenSandbox 的验收结论 | [SandboxManager](../../../src/runtime/sandbox-manager.js)、[OpenSandbox](../../../src/runtime/opensandbox-manager.js)、[现有 09](../../architecture/09-known-boundaries.md) |
| report 使用 `child_task_count`、`scheduler`、活动型 `made_progress`；部分列表有截断；观察服务不具备统一认证/脱敏保证 | 新投影区分 Mission/Task/E/Material/main，阅读期成本不遗漏；历史字段有版本解释，UI 不越过私有数据边界 | [parallelism](../../../src/benchmark/parallelism.js)、[Observation Store](../../../src/observability/observation-store.js)、[现有 06](../../architecture/06-observability-experiments.md) |

这些改动不能靠更换名词完成。例如，给旧 Workspace 加 `workspace_id` 而保留前任私有 clone，或把共享 Mission Task 改名为“bootstrap Task”，都没有满足目标合同。

## 4. 全部代码分组到架构章节的映射

当前 [source-map.json](../../architecture/source-map.json) 收录 **101 项、16 个类别**。下表覆盖全部类别；具体 101 项仍以清单为准，不在阶段文档复制一份易过时的逐文件列表。表中的章节是实施后必须解释相应行为的位置，不能只加一个源码链接。

| source-map 类别 / 当前项数 | 本阶段涉及的完整职责 | 实施 PR 必须核对的 Architecture 章节 |
|---|---|---|
| `launch and composition` / 16 | 入口、配置与依赖锁定；零 Task bootstrap；服务拓扑；Core/Bot 创建；预算与停止；SDK exports；脚本及 real-Agent/fixture 入口 | [00 全流程](../../architecture/00-overview.md)、[07 启动](../../architecture/07-run-configuration.md)，并联动 01、02、03、05、06 |
| `Agent and prompts` / 6 | Pi 启动与路由；四工具；CLI/skills 可见性；身份绑定；初始消息和后续消息实际发送；版本 manifest；旧 Bridge/extension 退出 | [01 Agent](../../architecture/01-agent-core.md)、[08 Prompts](../../architecture/08-prompts.md)、[10 API](../../architecture/10-service-api-reference.md) |
| `Execution and control` / 5 | Core 复用而 Bot 不跨 E 复用；preparing/active/closing/closed；排他预留、grant、撤权、全进程停止、对账、等待和计时；Controller/Scheduler 留存边界 | [02 执行](../../architecture/02-execution.md)、[05 Workspace](../../architecture/05-workspace-continuity.md)、08、10 |
| `runtime and execution` / 2 | OpenSandbox provider 与 guest worker 的生命周期、RPC/事件流、断线与重试、准备/授权、写进程稳定化和全进程回收 | 01、02、05、07、08、09 |
| `agent core and transport` / 1 | OpenSandbox Agent adapter 的启动、双向 Pi 通信、输入/输出同步、凭据边界和故障对账 | 01、02、05、07、08 |
| `service and Agent integration` / 3 | CLI 解析/help/请求身份、HTTP 调用和错误；独立服务间代理的身份、幂等、超时与持久性边界 | [04 Services](../../architecture/04-services.md)、07、08、[10 API](../../architecture/10-service-api-reference.md) |
| `Mission and Task` / 2 | 无共享特例；Task 全状态/动态依赖/稳定合同/提案；独占认领；局部完成与 Mission 验收；Material 关联与权限 | [03 Task](../../architecture/03-mission-task.md)、10、[11 Storage](../../architecture/11-storage-reference.md) |
| `Workspace and Sandbox` / 3 | provider 生命周期；只读到可写；公开快照物化；独立 Git；导出真实内容；main 接纳；干净后继；审计/回收隔离 | 05、[09 边界](../../architecture/09-known-boundaries.md)，并补 02、04、07、10、11 的新职责映射 |
| `services and contracts` / 18 | Context 内容/关系；Judge/领域运算；服务认证与普通 Service 请求中的 Execution 有效性/权限校验；幂等、错误、schema 验证；HTTP/本地适配；Registry/Catalog/help；测试 double 的非生产性质 | [04 Services](../../architecture/04-services.md)、10、11，联动 03、08、09 |
| `durable storage` / 3 | 新版本 schema、Task/E 独占与请求记录、Workspace 本地 Git Repository/main branch/revision、Material 关联、各 Service 自己的同步返回值；确需长操作时的服务专属异步状态、历史兼容及迁移约束 | 11、03、04，增加 02、05、06 所需关系说明 |
| `provider deployment and instructions` / 8 | 服务与 OpenSandbox Agent 镜像、启动参数、持久卷、网络/凭据；Mathlib 与其他服务完整说明；挂载/发送的技能和 help 版本 | 04、07、08、10；引入新镜像或技能时扩展清单 |
| `observation and analysis` / 9 | 事件/投影/HTTP/SSE、离线导入与分析、Workspace 可见性、pre-E 成本、操作尾部费用、版本与未知值 | [06 观测](../../architecture/06-observability-experiments.md)、07，联动 08、11 |
| `dashboard and build` / 14 | Mission/Task/Bot/E/Material/Workspace 页面、状态解释、分页/实时对账、错误/权限呈现、构建入口和维护源 | 06、07；UI 所依赖的新 API 同步 10 |
| `generated served asset` / 3 | 观察服务实际发送的构建产物与维护源一致；不能只改 React 源而发布旧 UI | 06、07；[12 Coverage](../../architecture/12-code-coverage.md) 记录生成边界 |
| `controlled verification data` / 4 | 锁定 fixture 输入、有效/无效候选与 checker 身份；明确脚本验收和真实自主研究的区别 | 04、07、09；验证结果仍记录 Issue/PR 或版本绑定的实验报告 |
| `documentation tooling` / 4 | prompt/API/storage 生成、source fingerprints、映射完整性、链接与漂移检查；新增运行时输入的扫描规则 | 08、10、11、12、[INDEX](../../architecture/INDEX.md) 的更新规则 |

101 是当前清单大小，不是未来上限。新增 CLI、Workspace 协调模块、provider adapter、schema/migration、runtime skill 文件、启动配置或 UI 入口时，必须登记其实际路径和章责；删除文件时移除映射并说明旧行为如何终止。尤其不能因技能文件放在 `docs/` 或 `.codex/`，就沿用当前“开发文档默认不属于 runtime”的排除规则：**凡会被研究 Bot 挂载、读取或拼入消息的仓库文件都属于运行时输入，必须显式覆盖。**

测试和 `test-support/` 继续作为验证入口；原始运行记录不进入 runtime inventory。它们的排除不允许把生产 fixture、运行配置、打包脚本或实际服务说明从清单漏掉。外部 Pi/provider 内部实现不在 101 项之内，应记录依赖版本和边界，不能声称仓库手册解释了不可观察的外部上下文。

## 5. 纵向切片、依赖与回退

以下是建议实施顺序，尚未自动创建或批准 tickets。可以在一个 Issue 下使用多个 PR，也可以由负责人批准依赖图后拆分 Issue。每个切片都要形成一条可通过公开入口观察的闭环，并随代码更新架构、prompt 和观测；不能把“所有后端先写完，最后才补文档/实际发送/清理”作为切片策略。

### P0：复用并验收 #119 的运行基础

**入口到出口：** 用真实固定版本 provider 启动一个完整 Bot，四基础工具操作同一私有工作面，CLI 调独立服务，持久发布内容；中断 CLI/重启服务/结束 sandbox 后查询已受理操作和材料，再以全新环境读取已发布输入。原私有目录不成为下一 E 的输入。

**依赖与验收：** 复用已落地的 provider、worker、CLI 和独立服务部署，按 #119 最新批准范围核对独立服务、身份/网络/卷、幂等、take 前后目录授权、有限 Bot 生命周期、全进程停止及持久性。Task 选工策略与 main 合入仍在本阶段验收，不附加为无关接入能力的隐藏条件。源码和 mock 是准备证据；Docker 后端必须有真实运行证据。本次未运行真实 sandbox/provider，不把现有实现切片或文档检查算作 P0 验收。

**回退：** 保留版本固定的旧部署供旧数据只读检查；新基础不通过时不启用 #122 新模式，不以宿主 Agent 或私有 resume 作为本阶段最终验收兜底。

### S1：从零 Task 到一段安全结束的贡献

**依赖：** P0；按 #122 已确认的 v1 生命周期、权限和数据版本边界实施。

**闭环：** 创建 Mission、Workspace main 初始 commit/revision `0.1`；独立知识输入另存为 Material，Task 表为空；启动一个只读 Bot，展示并记录真实初始 prompt；Bot 经 Workspace API 读取文件并提出 Task；同一 Pi 经准备输入→E active→开放写权限→发布绑定完成 take，发布最小有效 Material，再按 done/incomplete/blocked/cancelled 调用 task finish。开放 Mission 无现成可领 Task 且尚有选工预算时由 Bot 发现缺口并提出责任；实际耗尽选工预算的未绑定 Bot 通过 bot exit 正常退出。清理完成后用新 Bot 读取该 Material。补充双 Bot 竞争同 Task 和同 Bot 双重 take 的故障安排。

**必须一起交付：** 新 schema 的隔离运行边界、Task/E/Bot 排他、稳定 Task 合同和窄动态依赖、准备与关闭请求持久化、固定项目路径、初始 revision 的 files/read/search 与可信权限开放、普通 Service 写请求校验/撤权、无 E 成本、停止对账、实际 take 返回和最小 UI 事实。Material 单次发布自动绑定来源，只需足够完成此闭环，不提前宣称检索/纠错策略已完善。

**验收出口：** [07](07-validation-and-research.md) 的 V01–V08、V09–V13 中相关发布/授权路径，以及 V18、V20、V23/V24 的机制部分；通过真实 E2 的目录、直接服务旁路、迟到 grant、响应丢失、CLI 被杀和清理后拒写验证。E1 通过但 E2 未完成时，记录实现与未验证边界，不将新模式设为正式默认。

**回退：** 新 Mission 使用显式的新模式和独立版本状态；停止接受新 Bot，关闭/隔离已有 E，保留已受理服务操作、材料和费用。可以退回旧发布包处理旧模式数据，不能让旧二进制直接写新 schema。

### S2：跨 Bot 的材料接续、复用与纠错

**依赖：** S1；初始输入例外、Material 不可变来源和 Task 关系用途的合同已审阅。

**闭环：** B1 在 T1 发布部分成果后未完成退出；删除其研究可达环境。B2 从公开 Material 接续 T1，项目文件仍使用已具备的初始 main；未合入文件接续在 S3 随 save/apply 一起交付；另一 Task 将同一材料作为输入；后续 Bot 发布完整替代版，旧版在默认搜索中隐藏，关系错误可撤销。执行中发现新前置 Task 时 finish blocked，前置 done 才唤醒；取消前置不视为完成，显式修复等待关系。提案查询跨状态相关工作，有限检索而非穷尽历史。

**必须一起交付：** 去除 Material 全局 role 与关联 role 相等的限制；生产来源不变；有效分页/截断标记、实际内容读取、计划输入与实际消费区分、发布/关联中间态对账、修正及消费者可发现性。已有 completion/notification/help 对 role 的假设同步修改。

**验收出口：** V09–V13、V15、V18、V20、V23 与 V26，并验证不能读旧私有卷、Pi 会话或未发布 Git 对象；成功发布的真实内容在原 sandbox 销毁后可物化。若一次崩溃没有新发布成果，只能从已有公开输入重做；不声称恢复了该次私有进度，也不由 Runtime 补造材料。

**回退：** 暂停新增关系/发布，保留不可变内容和关系日志；坏的检索投影可重建，不能删除原材料来掩盖错误。旧 API 如暂保留，只能按已声明版本解释历史记录，不能重新施加旧全局 role 约束破坏新关系。

### S3：Workspace 文件保存、接续、合入与 Mission 提交

**依赖：** S2；按 [05](05-workspace.md) 已确认的版本、恢复一致性与整版合入合同实施；使用 Judge 的工作量复用当前 direct 路径，并核对其实际部署、持久输入与本阶段检查绑定，不以 #117 的 Issue 状态替代验收。

**闭环：** B1 保存稳定文件树为公开 revision 后退出；B2 经普通文件接口读取并 apply 该未合入版本继续工作。两个 Task 并行保存，main 前进后用三方 merge 接纳无冲突变更；真冲突先确认工作树包含待合入源 revision，再在同一 E apply main、修复、save 后重试。最后通过 mission submit 固定 main、选定 Material 与 checker/环境，验证期冻结 main，失败仅释放本 submission 的冻结，有效 PASS 固定验收版本并收尾；main 是否恢复合入仍按当前 Mission 状态与冻结归属判断。

**必须一起交付：** files/read/search、Workspace revision/parents/来源、稳定导出和目录安装、请求幂等、最终合成树检查、CAS 与 Git/索引崩溃恢复；没有 Candidate 表、ID 或专用调用。main merge 与 E finish/Mission freeze 共享提交顺序。Task、Context 仍经 API 关联，不跨库读取正文。

**验收出口：** V14、V16–V18、V21–V22、V25–V29、V31–V32 及有关 V09/V10/V13；覆盖源 sandbox 删除后的读取/apply、连续 main 变化、后台写、冲突接续、旧检查拒绝、响应丢失、保存与 main 更新崩溃窗口、提交冻结/解冻与迟到 PASS。文件引用按 revision/path，Task done、save、merge 和 Mission accepted 各自成立。

**回退：** 停止新 main merge/submit，保留已保存版本与接受记录。修正通过后继版本表达，保留错误版本和证据；程序回退不撤销已发生外部副作用，不删除未合入历史。

### S4：四个 Bot 的有限自主协作与受控评估

**依赖：** S1–S3；[06](06-prompts-and-skills.md) 全文、skills 内容和运行参数已固定；真实模型/provider/预算得到适用授权。

**闭环：** 四个 Core 从同一 Mission 自主读、提案、选工、竞争、执行、发布、整合和退出，由新 Bot 补位；至少包含动态阻塞与取消前置修复、未合入文件接续、整份材料纠错、同 E 解决 main 冲突、全部任务暂不可领、阅读期和执行期预算结束，以及最终提交冻结。Bot 不被固定分配为四种角色。

**必须一起交付：** 完整按需 skills、空闲与事件唤醒、compaction 可观察信号及有限收尾额度、并发成本总账、所有实际发送路径、完整 UI/报告字段。前面切片已有的初始 prompt 和观测不得推迟到此才添加。

**验收出口：** 07 的 C0–C7 轨迹、V19–V32 和相应 E3 行为证据；脚本可验证机制，但不能替代自主行为。E4 质量/效率研究按预先批准的对照、重复次数和总预算执行，失败与未知值也进入报告；单次演示不声明协作收益。

**回退：** 可停止新 Bot、收窄到已验证的并发量或关闭某个未经验证策略，但改变正式研究条件必须在 Issue 留下批准和新版本。不能更改已发生实验的标签或省略 pre-E、整合和失败成本。

### S5：默认入口切换与旧路径退役

**依赖：** 前面机制和真实集成验收成立；数据迁移/还原演练完成；在最终代码树重新核对已落地的 flat-only 清理及剩余兼容路径；所有仍可执行路径已有完整说明。

**闭环：** 从批准的普通启动入口启动新 Mission，完整完成一次目标工作；再以旧配置、旧命令、旧数据库和旧报表进行显式兼容/拒绝检查。操作者能看懂迁移结果、缺项和回退边界，不会因默认参数不同进入另一个任务模型。

**验收出口：** 不再创建共享 Mission Task；不再经隐式 fallback 私有恢复；新模式不暴露旧结构任务/同 Bot 换任务/named business tools；正常 CLI/help/SDK/镜像/配置/fixtures 使用一致合同。最终代码、Architecture、生成引用和证据共同复核；实施完成与研究收益结论分别记录。

**回退：** 发布前保留已验证的上一版本包、独立旧状态备份和版本化配置。回退先停止新写入并对账，不能把新格式状态交给旧 writer，也不默认丢弃已公开成果。若数据无法安全降级，只回退启动新任务的程序，历史新格式保持只读，按已批准的导出方案迁移。

## 6. Schema、数据与运行版本的迁移

### 6.1 必须显式版本化的状态

当前 schema 仍有构造器补列、历史状态和兼容字段；正常入口 flat-only 不表示历史数据已转换为本阶段合同。本阶段改变对象归属与生命周期，不适合只增加几列后沿用所有旧解释。建议对新 Mission 固定 schema/contract 版本，新旧运行写入域隔离；具体迁移 SQL 在获准实施时评审。

| 数据域 | 新合同最少需要记录 | 一致性与迁移约束 |
|---|---|---|
| Mission / Bot / Core | 预算/验收版本；Bot/Core/sandbox；零或一个 E；submit 输入、状态、冻结与 accepted revision | 无 E 费用不能遗漏；单活跃提交；失败仅释放自身冻结；关闭/超时提交的迟到结果不影响当前 Mission 或较新提交 |
| Task / E | 稳定目标/交付/完成条件、依赖与变化历史、Task/状态版本、E/Bot、preparing/active/closing/closed、结束意图/证据 | finish blocked 与新依赖原子保存；无环；取消不满足依赖；清理前不释放 owner；无通用 revise |
| 请求 / 授权 | request ID、操作/输入摘要、Mission/Bot/可空 E、生命周期版本、服务自身结果/未知状态 | 普通请求直接验证身份；操作专属幂等/恢复记录，无通用受理许可；同 ID 改载荷拒绝 |
| Workspace / Git main branch | Workspace/Mission、全部公开 revision/commit/tree/parents、main 指针、来源、冲突状态、请求与检查 | 文件按 revision/path 定位，无 Candidate 实体；最终树检查+CAS；持久提交意图和恢复屏障，不暴露半更新版本 |
| Material / 关系 | 内容、摘要、媒体/附件清单、不可变生产来源、Evidence 自述、实际使用、disputed、当前整份 supersede/撤销关系及其版本历史 | 正式替代一律隐藏旧版，新版自包含；关系 CAS/无环，撤销不删除历史；初始化输入可无生产 Task/E |
| 服务操作 | 具体长操作确需异步时由对应 Service 定义的输入、执行状态、费用、结果与取消合同 | Bot 结束后仍可查询；没有“总事务”自动撤销所有服务副作用 |
| 观测 / 报告 | schema/事件版本；生命周期、内容版本、发送证据和成本投影 | 权威数据可重建投影；历史缺失保持 unknown，不补成零 |

### 6.2 默认迁移方案：旧运行只读，新 Mission 显式起点

第一版优先从新的 Mission/Workspace 开始，不承诺把所有历史活跃研究无损热升级。实施 PR 应给出可重复的迁移与恢复命令、只读预览和结果报告，正式执行范围由批准 Issue 决定。

1. **停止旧 writer 并核对实际资源。** 停止新 take；结束或隔离已有执行，确认 Pi/子进程及旧凭据不能再贡献。已经受理的外部作业按合同完成/取消并计费。只有数据库写着终态不足以证明可以迁移。
2. **建立一致备份。** 记录 Task/Context/Judge 各自 schema 版本、数据库备份、Material 内容清单/摘要、公开输入、运行 manifest 和仍未结束操作。跨服务备份要标明协调边界；不可只复制一个 SQLite 文件就宣布可恢复全部内容。
3. **只读检查与分类。** 检查来源/附件缺失、重复活跃 owner、旧 role 依赖、无法解释的 Task 状态、指向私有目录的内容引用。迁移预览列出接受、拒绝、需要人工决定的记录及原因。
4. **初始化新 Workspace。** 负责人明确选择可公开、可物化的项目输入或历史 Material；验证实际内容，建立明确的初始 Workspace revision。不能自动选择“最新 E 目录”或“最后一个 Git commit”，也不能把审计归档默认为共享资料。
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
| `workspace_ref`、checkpoint、private Git commit | 只作为受限历史证据；只有经过显式发布、内容核对与可见性检查的 Material 或公开 Workspace revision 才能成为新研究输入 |

取消 role 相等校验只是第一步。还要审查 Task completion 对 `material.role` 的匹配、handoff 必须专门 role 的限制、定向 response 通知、Context 搜索、SDK schema、UI 筛选和生成 help。否则表面允许跨 Task link，完成检查仍会按旧全局角色拒绝合法结果。新关系必须保留权限和来源校验，不能用“用途自由”放开修改他人生产事实。

## 7. 旧命令、私有恢复与兼容路径退役

### 7.1 应移除或明确替代的路径

| 旧路径 / 假设 | 目标处理 | 删除时必须连带核对 |
|---|---|---|
| 第一条 Task 为共享 Mission Task；并行 claim 特例 | 移除创建顺序判型及共享 claim/block/completion 分支 | runner 初始化、任务列表/可领性、预算、Mission 完成、报表与测试 |
| Root/Child、required children/branch groups、parent review 和结构等待的历史合同 | 保留当前 flat-only 入口清理；仅对仍存在的兼容入口/历史解释继续退役，需要的依赖改成明确 Task 依赖 | 通用 SDK、catalog、fixture、rework/wake、旧状态投影；不恢复已拒绝的旧 CLI 模式参数 |
| `task_register(take:true)` 同 Session 换 Task | 提案与 take 分离；已经绑定的 Bot 不再 take 第二项 | Bridge 回调、Runtime detach、checkpoint、prompt 示例、并发请求 |
| `workspace_mode=resume`、source E/path/revision、waiting/rework 私有恢复 | 新模式拒绝 private resume；仅允许明确公开 Workspace revision/Material 输入 | claim 默认、clone/restore 分支、缺快照时 live-file fallback、旧 workspace 指针复用 |
| rotation/recovery 自动继承私有上下文 | 新 Bot 只读公开资料；同一活跃 E 的 Runtime 重启仅做状态/进程对账 | Pi session 目录、工具历史、checkpoint 提示、recovery prompt、隐藏文件/卷及 Git objects |
| `execution_progress` 的隐式 checkpoint/发布/handoff 组合 | 改为显式 Material 发布和 finish 合同；必要内部审计 checkpoint 不变成共享知识 | 完成门槛、自动提醒、进度统计、旧 tools/help/SDK；不新增 Progress 核心对象 |
| named business tools、业务 Workspace/Sandbox tool 代理 | 承接 #119，Bot 使用四工具与 CLI；可信 Runtime/provider 控制面不暴露给 Bot | extension、profile、Bridge、registry、启动参数和旧别名入口 |
| 已交付的 `swarm context` 入口 | 新标准为 `swarm material`；需要兼容时设有版本/期限的同义转发，否则给出明确迁移错误 | 参数、结果、错误、request ID 语义必须相同；help 明示退役，不能在新 Prompt 混用两种名称 |
| 已由 direct Judge 替代的 Task→runner→Judge 私有提交回调 | 保留现有直接路由，不重复实施或恢复旧接力；扩展为本阶段公开版本与最终检查合同 | 来源证明、fixture/环境绑定、检查返回和独立 Task 完成；现有直接调用不自动等于 Mission submit |
| 旧 report `child_task_count` / `scheduler` 与 Task 概念混用 | 新格式明确 Task/Bot/E；历史 importer 按版本解释 | 分析脚本、UI、公开 exports、例子和既有实验报告；不改写历史结果 |

本表同时标明已完成的前置替代与尚需处理的路径。“移除”只适用于最终代码树中仍存在的行为，不能预先声称对应文件已删除，也不重新实现已经完成的清理。某文件可能继续承担其他职责，例如 Registry 仍可提供服务发现，Runtime 仍需 fencing，WorkspaceManager 仍可物化公开快照；应删除不符合合同的行为和入口，而非为了目录整齐机械删整文件。

### 7.2 在真正移除之前必须继续写清的兼容行为

实施分支若仍能调用下列路径，Architecture 就必须解释它们的入口、默认值、实际授权、状态变化、错误和限制：历史 Root/Child 及 parent acceptance/rework/wait 的残余兼容入口；共享 Mission Task；独立导出的 Scheduler；generic SDK/catalog 与 normal Agent profile 的差异；script/real-Agent fixture；私有 resume/recovery；named tool Bridge；本地同步 router 和跨库依赖；旧配置及 report/importer 字段。当前基线已拒绝旧 CLI 任务模型选择，也已改为 direct Judge，不能继续把 legacy 默认或 runner 提交 callback 写成正常入口。

短期兼容必须满足三点：**入口能辨认版本、旧 writer 不接触新状态、新模式没有自动 fallback。** CLI 别名只能转发同一授权语义，不能借旧命令获得 private resume 或免 E 发布。只读历史解析器可以比运行时写接口保留更久，但要在 source-map 和架构中标明用途。删除旧写接口前应确认正常 CLI、公开 exports、服务 manifests、构建产物、部署配置和 fixtures 都已迁移；仅让模型不再看到它，不等于它不可调用。

## 8. 观测、实际 prompt 与版本绑定

### 8.1 UI 和记录必须显示的新事实

| 视图 / 数据流 | 本阶段必须表达的内容 | 不允许的混淆 |
|---|---|---|
| Mission 首页 | 目标与验收、Workspace 本地 Git Repository/main branch/revision、全部 Task 状态、总体预算与停止原因 | 不用一条隐藏 Mission Task 充当项目；无可领工作不等于达成目标 |
| Core / Bot / E 时间线 | Core 可复用；Bot 阅读期；E preparing/active/closing/closed；后继 Bot；实际停止/隔离证据 | 准备/清理期间的 Task 仍占有；收到 finish 不等于 sandbox 已停止 |
| Material | 实际内容、生产 Task/E 或输入来源、各 Task 的用途、读取/消费版本、质疑与更正 | 全局 role 不代表所有用途；发布数、读数、consume 自报不代表知识正确或有收益 |
| Workspace | 全部 revision/普通文件/parents/来源/检查，main CAS，E 初始与 apply 输入，提交冻结 | 已保存 revision 不表示 main 前进；main 已接纳不证明全部主张 |
| 服务请求 | pending、已受理、结果未知、成功/失败/取消，身份核验与撤权顺序，旧 E 尾部操作 | 请求超时不自动失败；Bot 结束不自动撤销已接纳工作或费用 |
| 成本 / 研究报告 | 阅读、提案、检索、skills、执行、整合、等待、重试、失败及外部操作总成本 | 不漏计无 E 费用；区分单 Core 与总资源；同一服务费用不能在请求和 Task 汇总重复相加 |
| Prompt / skill 证据 | 具体发送事件、消息类型/顺序、内容身份、版本、输出截断与缺记录 | “已挂载”“已组合”“已发送”“已读取”是不同事实；任何一项都不证明 Bot 遵从 |

Observation Store 和 UI 是投影。事件丢失或落后时，应能从权威服务重新读取并标注不完整，而不是从旧 UI 状态触发认领或合入。API、分页、SSE 重连和报告导入都要随版本迁移；不能只改标签。维护源和实际 served assets 一起构建并复核。

现有 observer 的直接 Task/Context/Workspace/report 路由不具备普遍的认证与脱敏保证。新部署必须按实际身份区分研究可读内容和操作者审计；私有卷、对话、凭据和原始 tool 输出不能经 UI、搜索或下载接口回流给后继。将页面称为“只读”或对几个字段做截断都不能证明这条边界成立。

### 8.2 全部仓库控制 prompt 的文档范围

[06](06-prompts-and-skills.md) 是拟议文本及策略合同；实施后的 [Architecture 08](../../architecture/08-prompts.md) 必须写实际安装和发送的版本。完整覆盖至少包括：

- 稳定 system addendum、零 Task 的初始 user 消息、Mission/Workspace/预算动态字段、目录与装配顺序；字段缺失与默认值也要解释。
- 未绑定阅读、提案与 take 的指令；实际 take 返回；take 前只读、active 执行、task finish/超时/handoff、预算和 compaction 收尾、finish 后旧 E 请求拒绝、故障/重启通知及仍存在的 legacy 路径。
- 四基础工具的仓库配置、CLI help/schema/错误文本、服务说明，以及通过 Bash/read 返回给模型的材料、任务、检查结果、通知和 lifecycle rejection。
- 所有 runtime skills 的**完整正文**、目录、适用条件、版本/hash、安装来源、读取方式；缺失或版本不一致的行为。目录出现某 skill 不代表它的正文已进入模型上下文。
- 工具结果的截断、格式化、重试/超时提示，以及 Pi/provider 产生的 compaction/内部上下文边界。仓库无法提供的外部文本必须标明未知，不能从模板反推。

生成器应覆盖新增消息 producer/sender、技能资源和 CLI help，而不只导出 `agent-prompt.js` 的常量。安全的合成动态示例帮助读者理解最终装配；它必须标为示例，不能当成真实运行 transcript。

### 8.3 实际发送记录的最低合同

每条仓库控制消息应能关联 run、Mission、Bot、Core、Session、可空 E、消息序号、类型、生成源、模板/skill 版本、动态输入版本、最终内容摘要和发送结果。实现应区分“组合完成”“尝试发送”“适配器确认接收/写出”“发送失败或结果未知”，并说明具体确认点；单个 `runtime.initial_prompt_composed` 事件不够。

tool result 也属于模型输入。必须记录 **实际返回边界** 的内容身份及截断信息，不能只保存服务原始响应的 hash。Bash/read 加载 skill 时，应关联实际读到的文件版本、范围和返回给 Pi 的输出；可用目录、文件打开事件和整篇 skill 已发送不可互相代替。无需为证明记录完整而强制每个 Bot 全量加载全部 skills。

原始消息、必要动态内容和工具输出留在受控、忽略提交的运行证据中；公开 Issue/PR/实验报告只含脱敏投影、版本、摘要和可审查的结论。不要把凭据放进 prompt，也不要把完整私有会话提交到架构文档。记录目标是可核对外部输入和输出，不要求公开私有思维过程。仅有 hash 而缺少可授权取回的原内容时，应诚实标为不能完整重建。

### 8.4 同一次运行应绑定哪些版本

运行 manifest 至少固定：实现 commit 和 dirty 状态、所采纳设计/批准记录、schema/协议版本、CLI/help、prompt/composition、skills 内容、服务 manifest、provider/镜像 digest、Pi、实际启用的路由器（如有）与领域工具链、Mission 验收/合入政策、预算及 compaction 配置。每个 E 固定 Task 目标合同、初始文件 revision、输入 Material 内容身份及授权版本，并另记动态依赖、每次 apply/保存版本及 parents；更新工作树不能改写初始输入。

take 前后 main 改变时，返回实际物化版本并记录需要重读的变化；执行中不后台替换副本。检查绑定确定 revision/文件、最终合成树、输入、checker/环境及政策，旧 PASS 不能覆盖不同合成树。Mission submit 还固定验收输入和冻结/终态结果，结果不能回填到另一次提交。若部署升级改变这些合同，应选择新运行/新 E 或有明确协议的受控切换；不能在活跃 E 中静默替换 skills、checker 或 service schema。

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

`docs:check` 是覆盖、漂移和链接门槛，不检验叙述是否完整，也不判断模型是否正确理解指令。source-map 有 101/未来 N 个条目只说明文件已归类，不能代替对各分支的语义审阅。若 PR 声称没有架构影响，应给出具体理由；修改发送条件、错误格式、默认配置或生成 served asset 通常仍有架构影响。

### 9.2 阶段结束需要一次完整对账

阶段结束不能只汇总各 PR 的绿色检查。应固定最终 merged commit，重新走通从启动、零 Task 阅读、提案/take、产出/使用、main 更新、task finish、清理补位到 Mission 停止的整条流程，并核对异常、预算和直接服务旁路。

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

## 10. 已确认合同与实施门槛

本轮已确认 Task 稳定合同与动态等待、同 E 显式 apply/三方 merge、Material 整份隐藏、最终 mission submit、Bot 零或一 E 及软硬收尾。**整版 merge 粒度也已确认**：candidate 文件分别引用，关联文件作为完整 revision 的变更集合一起检查、原子合入。上述设计选择已完成确认；以下是后续实施与验收门槛。

| 实施门槛 | 需要固定或验证的内容 |
|---|---|
| 运行与 Provider | 固定版本/镜像；真实 Pi 通道、非 root、受保护固定路径、稳定导出/安装、全进程停止；源码不能替代 E2 |
| 协调一致性 | take/finish/动态依赖幂等；main 的 E/Mission guard；Git/索引恢复屏障；submit 冻结、解冻和迟到结果 |
| 数据和版本 | 独立新运行/显式输入、schema/CLI/Prompt/skills/checker 绑定；不自动公开私有审计或恢复旧会话 |
| 预算与评估 | 有限选工、重试、收尾额度，已受理外部操作尾部成本；真实模型/provider/重复次数和总预算另需授权 |
| 文档交付 | 按切片同步 Architecture 与生成引用；设计批准不代表已实现或实验通过，合入与付费运行按各自已有授权执行 |

这些门槛决定实现证据，不是重新开启一轮对象模型选择。若实际 Provider 或存储无法兑现合同，应在原 Issue 提供具体差距与替代方案，不通过静默削弱隔离、持久性或验收规则绕过。
