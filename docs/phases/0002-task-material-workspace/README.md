# 阶段 02：Task、Material、Workspace 与 Bot Runtime 设计

> 设计与决策入口：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · 原始讨论：[Issue #120](https://github.com/LuNa-shi/SwarmEnv/issues/120) · 前置 Sandbox 阶段：[Issue #119](https://github.com/LuNa-shi/SwarmEnv/issues/119) · 文档审阅：[PR #123](https://github.com/LuNa-shi/SwarmEnv/pull/123)。
>
> 状态：目标设计，已按本轮用户确认统一跨模块合同。仅 Workspace 整版 merge 粒度保留最后确认；设计审阅不代表运行实现或真实 sandbox 已验收。[Architecture](../../architecture/INDEX.md) 继续描述当前实现。

## 1. 项目目的与对象关系

本项目建立可复用的 Agent Swarm 环境：Services 提供独立持久能力，Task 组织工作责任，Material 保存研究内容，Workspace 累积项目文件。研究目标是验证 Bot 能否自主发现和选择工作、形成并行分工、复用和纠正成果，并跨 Execution 推进 Mission；机制可执行不等于研究收益已成立。

| 对象或称谓 | 职责与关系 |
|---|---|
| Mission | 所有 Bot 共享的整体目标、预算和最终验收范围；不可 take |
| Task | 局部目标、交付与完成条件；同一时刻最多一个有效执行者 |
| Material | 可持久读取、引用和纠错的研究内容 |
| Workspace | 与 Mission 一对一、ID 不同的本地 Git Repository |
| revision / main | revision 固定公开文件树，含未合入保存；main 是共同项目分支 |
| candidate 文件 | 某 Workspace revision 中的普通文件；用 revision + path 引用，不是新增对象 |
| Core | 可复用计算槽位 |
| Bot | 一次全新 sandbox/Pi 生命周期；对应零个或一个 Execution |
| Execution | take 原子预留时创建的一次排他尝试，记录输入、权限与准备/执行/清理 |
| Sandbox | Bot 的独立临时环境；预留固定项目路径，take 后物化并开放写权限，Bot 结束后销毁 |

整体对象关系由本 Overview 给出；各章负责对应合同。跨 E 可读取公开 Task、Material 和 Workspace revision，不继承私有会话、目录或未保存状态。

## 2. 文档地图

| 顺序 | 文档 | 权威范围 |
|---|---|---|
| 01 | [Core Runtime：Mission、Core、Bot 与 Execution](01-model-and-runtime.md) | 启动、take/finish、无任务退出、软硬停止、Mission submit |
| 02 | [Sandbox 与 Execution Runtime](02-sandbox-runtime.md) | 固定路径、进程/网络/凭据、准备与授权、停止和 provider 验收 |
| 03 | [Task：任务合同、分工与执行责任](03-task.md) | 稳定合同、动态等待、提案/选工、完成、取消和依赖修复 |
| 04 | [Material：研究内容、Evidence、检索与纠错](04-material.md) | 内容与来源、使用、质疑、整份替代及错误关系撤销 |
| 05 | [Workspace：文件、revision 与 main 合入](05-workspace.md) | 统一文件读取、稳定保存、同 E apply、三方 merge、恢复一致性 |
| 06 | [完整 Prompt 与 Bot Skills](06-prompts-and-skills.md) | 完整规范、动态输入、CLI、四份 skills 和真实发送记录 |
| 07 | [验证、相关工作与研究假设](07-validation-and-research.md) | 工程与组合场景、四 Bot 轨迹、研究对照和成本 |
| 08 | [架构迁移与实施切片](08-architecture-migration.md) | 实施顺序、源码职责映射、兼容迁移与 architecture 交付 |

Prompt/Skills 只把模块合同转成可执行指导，不另创权限；Validation 检验这些合同与真实行为；Migration 说明如何从现状实施，旧代码差距不充当新设计缺陷。

## 3. 已确认的跨模块合同

### 3.1 Task 与 Bot 生命周期

- Mission 可以从零 Task 启动多个 Bot，自主阅读、提案和选工；选工预算有限，不要求穷尽全部历史。
- 一个 Bot 最多 take 一个 Task，take 前允许正常 `bot exit`；Runtime 退避或等待事件，不靠假 Task 合法退出。
- Goal、Deliverable、Completion condition 创建后稳定，不提供通用 `revise`。运行中新发现的前置工作通过窄的 `finish blocked --wait-for` 表达，不改变验收标准。
- finish 支持 done、incomplete、blocked、cancelled；取消不满足依赖，替代不自动等价。仅在无 owner 的 blocked Task 上显式修复已取消的依赖，并核对版本、权限与无环性。
- take 顺序统一为准备输入、E active、开放目录写权限、发布绑定并返回成功。finish 接受后拒绝新贡献，Task 直到旧进程停止/隔离才释放。
- 软收尾仍允许保存现有文件、发布接续 Material 和 finish；硬停止立即撤权，只承认之前已持久的成果。

### 3.2 文件与知识交付

- Material 保存研究内容；文件成果保存为 Workspace revision，并用 Workspace/revision/path 引用。只发布“代码完成”的文字不构成文件交付。
- Candidate 不再有独立 ID、存储、列表或 discard；读取走普通文件接口，删除当前文件产生新版本，历史不删除。
- take 前通过 `files/read/search` 读取真实文件；本地固定项目目录尚未填充，prompt 不假设本地有只读 clone。
- save 固定一致文件树，不自动改 main；同一 E 可显式 apply 公开 revision，初始输入保留审计。版本变化不强制换 Bot。
- main 采用真实三方 merge、最终合成树检查和条件更新。Runtime 管全部 Git、parents 与请求幂等，Bot 不填 Git SHA。
- 当前有效 E 可自主合入，复杂跨 Task 协调才另建普通整合 Task；Task done、文件保存、main 更新和 Mission accepted 各自独立。

### 3.3 Material 纠错与 Mission 提交

- Material 正文和生产来源不可变；Evidence v1 是正文中的自然语言说明，不新增 Evidence 对象。
- disputed 保留警示；正式 supersede 一律从默认列表和搜索隐藏整份旧 Material，新版须承接仍有效内容。精确 ID 和历史仍可读取；错误替代可通过受控撤关系操作恢复可发现性。
- `mission submit` 固定当前 main、显式选择的不可变 Material 内容版本、验收/checker/环境版本。验证期间冻结 main merge，现有 E 仍可保存成果。
- 失败、错误或超时保留结果并解冻；PASS 固定 accepted revision，进入正常停止。单活跃提交、请求幂等和迟到结果 guard 防止验收错版本。
- 未绑定但具 Mission 协调权限的 Bot 可以提交公开成果；不为点击最终提交而创建 Task，不把未完成 Task 全部标成 done。

### 3.4 第一版边界

v1 的 Workspace 与 Task/Mission 位于同一协调进程和一致性域；Context、Judge 和领域服务独立持久化。普通请求直接验证身份和状态，不引入通用许可/作业系统。Git 与版本索引通过服务专属持久请求记录和恢复屏障保持一致。Workspace 长期保留、不自动 GC；Runtime 不做进程级研究恢复。

## 4. 唯一待确认项与实施门槛

**待确认：文件可以分别引用，但 merge 是否默认按完整 revision 原子合入？** 本稿推荐是，以免实现、测试和配置被拆开合入；不增加逐文件选取与依赖分析。影响与示例见 [05 第 5 节](05-workspace.md#5-candidate-文件化对操作的影响)。相关 prompt、示例和验收统一按这个推荐默认展开，尚不标为最终批准。

以下属于实施与验证门槛，不再重复询问设计方向：Provider 是否能可靠暂停写入、授权和停止所有进程；Git/数据库故障恢复；私有审计数据按部署政策保留；实际磁盘增长；选工、收尾与服务尾部费用配置；真实模型和实验资源授权。实现前固定版本和范围，按 07 验证，不以设计文档代替运行证据。

## 5. 审核与维护

设计判据是：假设所有组件忠实实现合同，四个 Bot 是否仍因规则冲突、缺操作或不合理限制无法推进。当前代码中的旧循环、Session 复用或私有恢复只属于 08 的迁移背景，不作为本轮目标设计缺陷。

用户决定与采纳版本记录在 #122/PR；本目录是可审阅的版本化附件。任何合同修订同步相关模块、Prompt、Validation 和 Migration；实现 PR 再据实际行为更新 Architecture。本次只修订设计，不改运行代码，不合并 PR，也不启动付费实验。
