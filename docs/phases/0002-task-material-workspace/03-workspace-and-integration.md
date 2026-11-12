# 03. Workspace：工作副本、主分支与成果累积

> 设计附件：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · 状态：供审核的目标方案，尚未实现。
> 已确认：Workspace 是核心对象，main 是其中的主分支；Git 风格管理可作为第一版基础。下面的字段、组件位置、合入规则与接口语义是本稿的具体建议。
> 当前实现对照基线：`008ecdb9ab64adcd8135042ff2160ec1db704952`。

## 阅读目录

1. [对象关系与最小范围](#1-对象关系与最小范围)
2. [谁保存内容谁维护主线](#2-谁保存内容谁维护主线)
3. [初始化与执行工作副本](#3-初始化与执行工作副本)
4. [可见性权限与-git-隔离](#4-可见性权限与-git-隔离)
5. [发布什么以及什么时候提出合入](#5-发布什么以及什么时候提出合入)
6. [普通整合-task-的完整流程](#6-普通整合-task-的完整流程)
7. [main-更新的服务端合同](#7-main-更新的服务端合同)
8. [并发旧版本与失败处理](#8-并发旧版本与失败处理)
9. [错误成果纠正与撤回](#9-错误成果纠正与撤回)
10. [贯穿四-bot-例子的版本轨迹](#10-贯穿四-bot-例子的版本轨迹)
11. [第一版边界与后续问题](#11-第一版边界与后续问题)
12. [与当前实现的差距及验收](#12-与当前实现的差距及验收)

配套章节：[模型与运行](01-model-and-runtime.md)、[Task / Material 策略](02-task-material-policies.md)、[完整 prompt 与 skills](04-prompts-and-skills.md)、[验证与研究](05-validation-and-research.md)、[架构迁移](06-architecture-migration.md)。

## 1. 对象关系与最小范围

**Workspace 表示一个项目共同维护的工作空间。** 它管理项目当前可继续使用的主线、主线的明确版本，以及每段 Execution 从哪些已发布输入建立了自己的私有工作副本。Workspace 的生命周期可以跨越许多 Bot、Execution 与 Task；一个 sandbox 的销毁不应删除 Workspace。

Mission 与 Workspace 一对一绑定。Workspace 就是该 Mission 的项目 Git Repository，位于 sandbox 外部并在本地持久化；它有一个名为 `main` 的共享主分支。任务表中的 `workspace_id` 指向这个 Workspace。不同 Task 可以修改同一项目的不同部分；它们并不因此共享可写目录。一次成功 take 只绑定一个 Task 和一个 Execution，在对应 sandbox 内创建或准备这个 Execution 的私有工作副本。

| 对象或名称 | 第一版含义 | 生命周期与关系 |
|---|---|---|
| Mission | 全体 Bot 可见的目标、原始输入与运行约束 | 不作为 Task 认领；关联一个 Workspace |
| Workspace | 项目共同成果及其工作副本的管理对象 | 跨 Task、Bot 与 Execution 存在 |
| `main` | Workspace 本地 Git Repository 中的主分支 | 普通 Git branch；每次推进指向新的 commit |
| Workspace revision | Workspace 对 main 每次成功更新分配的递增版本号，例如 `0.1`、`0.2` | 记录对应的 Git commit；revision 是本系统版本标识，不创建 Git tag |
| 私有工作副本 | 一个 Execution 在 sandbox 中使用的文件工作面 | 只归该 Execution；release 后不交给后继 Bot |
| 本地 Git 分支 | Bot 管理自己工作副本的一种工具 | 改本地分支名或提交不改变共享 main |
| 合入候选 | Execution 从自己的独立本地 clone 导出的 Git commit/变更及其来源、检查信息 | 由 Runtime 导入 Workspace 本地 Repository，作为 Workspace candidate 保存；不要求成为 Material |

同一个 Task 未完成后再次被认领，会有新的 Execution 和新的私有副本。新副本取自当前公开 main 和明确选择的 Material，而不是克隆前一 Execution 的私有历史。后继可以读到“前任基于 v3 研究并发布了 M8”，但读不到前任未发布的目录、对话或命令历史。

本章不使用 `workspace lineage` 作为必须理解的新概念。需要追溯时，直接记录“基于哪个主线版本”“使用了哪些 Material”“由哪个 Task/Execution 产生”“替代或修正了什么”。

## 2. 谁保存内容，谁维护主线

第一版建议把 **Workspace 协调模块放在 Task Service 的协调进程与同一持久状态事务域中**。这是部署简化，不是把 Workspace 降格成 Task 的字段集合。模块负责 Workspace 元数据、Execution 与副本的绑定、main 指针、合入请求及其幂等结果。它在 Workspace 本地 Repository 中管理 refs、commit 和 revision；普通操作按一次 CLI/API 请求处理，服务在执行时校验当前 E。不得把每次服务调用包装成通用 pending/permit/acceptance 协议。

Context Service 继续独立拥有 Material 的内容、附件、可见性、来源与修正关系。Workspace 模块通过 Context 的 API 核对并读取候选，不能直接打开 Context 的数据库。Runtime 通过 sandbox provider 准备副本、授予本地写权限、启动/停止进程并执行资源清理。第一版不为 Workspace 再增加一个必需的独立微服务。

| 责任 | 负责方 | 不应暗中承担的责任 |
|---|---|---|
| 选择值得整合的成果、处理内容冲突、解释检查结果 | 认领普通整合 Task 的 Bot | 不能自行宣布自己的服务权限或伪造有效检查 |
| Task/E 独占、当前执行资格、main 条件更新 | Task Service 内的 Workspace 模块 | 不替 Bot 发明研究结论、解决代码冲突 |
| 持久保存候选内容、查阅 Material 与修正关系 | Context Service | 不因上传成功自动改 main 或判定 Task 完成 |
| 物化公开基线、管理私有目录权限和 sandbox | Runtime | 不读取前任私有目录来补齐未公开成果 |
| 执行已配置的检查，返回绑定具体输入的结果 | Judge 或相关领域 Service | 不把返回值提升为必须由用户理解的新核心对象 |
| 确定合入政策和 Mission 验收目标 | Mission 的批准配置与负责人 | Bot 不得通过改本地配置放宽这些规则 |

Workspace 可以在服务内部使用 Git 管理公开版本，但外部权威记录至少包含下列信息。字段名称供审核，不能视为已有 API。

| 记录 | 最少需要表达的信息 |
|---|---|
| Workspace | `workspace_id`、`mission_id`、当前 `main_revision`、对应 `main_commit`、内容摘要、合入政策版本 |
| Workspace revision | revision 编号、对应 Git commit、父 commit、来源 Task/E、合入候选、检查证据引用、更新时间 |
| Execution 绑定 | Task/E、Workspace、物化的 Workspace revision、额外输入 Material 及内容摘要、sandbox/私有副本标识 |
| 合入请求结果 | 请求 ID、执行者、预期 Workspace revision、candidate commit、成功的新 revision 或明确失败原因 |

初始版本的生产者是用户/项目输入，不伪装成 Bot 产物，也不为此创建 Mission Task。Git commit 是 Workspace 的实际文件版本。Workspace Repository 位于 sandbox 外部，服务可从本地 Repository 物化任一保留 revision；不需要为每次 Execution 创建远程仓库。Material 独立保存研究内容和来源，不承担 main 分支或版本快照的角色。

## 3. 初始化与执行工作副本

### 3.1 Mission 开始时

负责人提供 Mission、原始项目文件或空项目、允许使用的服务、运行预算，以及适用于该项目的合入条件。启动过程在 sandbox 外创建本地 Git Repository，导入原始项目文件，建立 `main` 初始 commit，并初始化 Workspace revision `0.1`。项目说明、数据集等可独立引用的知识内容可以另存为 Material；Git 文件树本身不是 Material。revision `0.1` 可以是空文件树和一个明确的输入说明；不要求为了初始化制造一段 Bot Execution。

初始化操作应能安全重试，避免创建重复 Mission/Workspace。Workspace Repository 和初始 commit 建立并可物化前，不向 Bot 宣告主线已准备好。

Runtime 随后启动四个 Core 的全新 sandbox / Pi / Bot。它们共享 Mission 和 Workspace 的读取权限，拥有各自只读的项目副本及必要的运行目录。主分支不是四份可写目录的集合；四个 Bot 看到的初始版本可以同为 v0，但不共享写权限。

### 3.2 阅读阶段到 take

认领前，Bot 可以查看当前 main、任务列表及已公开 Material，理解项目并提出任务。Bot 此时没有 Execution 贡献权限，也不能修改受保护项目目录。必要的 Pi 日志、会话、缓存写入放在单独运行目录，不能据此宣称“整个文件系统绝对只读”。权限细节见[运行协议](01-model-and-runtime.md)。

take 认领成功后，Task 进入 `running`，Execution 进入 `preparing`。Runtime 选择并记录当前公开 main 的具体版本，解析 Task 输入与后继接续所需 Material，验证内容摘要，并在项目仍不可写时完成物化。若 Bot 阅读 v0 期间 main 已前进到 revision `0.2`，take 的成功结果必须明确“本次实际从 v1 开始”，列出输入版本；Bot 应重新检查相关变化，不把之前对 v0 的判断直接当作 v1 的事实。

准备完成后才进入 `active` 并授予当前 Bot 私有项目写权限，随后提供 E 凭据并返回成功。Pi 会话保持不变，因此本次认领前的阅读上下文保留。准备失败进入关闭与补偿，不把半准备目录交给另一个 Task。

在执行期间，副本的 main 基准固定，不随其他 Bot 的合入而自动变化。Bot 可以通过服务读取新版本，主动在自己的副本中整合并记录新基准；必须重新验证受影响内容。后台静默替换正在编译或编辑的目录会破坏观察的一致性，第一版不采用这种方式。

### 3.3 release 后

Bot 必须在 release 前显式选择需要保留的成果并完成 Material 发布。release 先撤销新贡献请求资格，进入 `closing`，再停止本地进程。Task 在确认旧执行停止并完成归属核对前仍保留 `running` 的占有事实；随后依据完成条件进入 `done`，或回到可继续的 `ready` / `blocked`。旧副本可以作为受限审计存档保留，但不成为下一个 Bot 的挂载、克隆源或搜索输入。

一个 Mission 的 Workspace 和 main 不随 release 删除。下一个 Bot 从公开版本重新开始：若前任没有保存 candidate 或发布 Material，系统应诚实地承认那部分研究无法接续，不能用私有恢复旁路替它补上。

## 4. 可见性、权限与 Git 隔离

| 数据或操作 | 未 take 的 Bot | 当前有效 E 的 Bot | 后继 Bot | 可信运行/服务端 |
|---|---|---|---|---|
| Mission、Task 全状态、可见 Material | 可读；允许已定义的协调操作 | 可读及授权内协调 | 可读 | 按各自职责维护 |
| Workspace main 与公开历史 | 可读 | 可读 | 可读 | 通过受控更新维护 |
| 当前私有项目目录 | 只读 | 可写 | 不可读前任目录 | 准备、授权、隔离、审计 |
| 当前 Pi 对话、日志、缓存 | 本 Bot 必需范围 | 本 Bot 必需范围 | 不继承 | 按审计权限留存 |
| 他人私有副本 | 不可读写 | 不可读写 | 不可读写 | 按管理职责操作 |
| 直接改共享 Git refs / main | 不允许 | 不允许 | 不允许 | 只有验证通过的服务操作 |
| 发布候选并请求推进 main | 不允许贡献写入 | 受 E 范围、Task 合同及合入政策限制 | 需取得自己的 E | 服务端复核 |

第一版每个 Execution 使用独立的本地 clone，包含独立 `.git` 管理数据；由可信 Runtime 从 sandbox 外的 Workspace Repository 执行本地 clone，再将整个 Execution clone 工作目录挂载到 sandbox。Bot 可在该副本中自由创建分支和 commit。Runtime 不把 Workspace 主 Repository 的 `.git`、共享 refs 或管理凭据挂给 Bot。优先保证隔离，不使用共享可写 `.git`、`--shared` alternates 或前任私有对象库；后续可测量后再评估 reflink/COW 或受控对象池。**不要把普通 `git worktree` 的共享宿主 `.git` 目录直接挂给多个 Bot。** Git 官方文档说明 linked worktree 会共享部分 refs 和默认配置；这个机制不等于隔离边界。[Git worktree 官方文档](https://git-scm.com/docs/git-worktree)、[Git clone 官方文档](https://git-scm.com/docs/git-clone)。

Bot 可以在自己的副本创建本地分支、提交、看 diff；这些只是本地工作。Runtime 不把宿主 Git 凭据、Docker socket、服务数据库、provider 管理接口或共享可写 refs 放进该副本。main 更新授权来自当前 E 和服务端状态，不来自分支名称、Git author、客户端填写的 Task ID 或 `.gitignore`。

导出成果时按显式文件清单读取实际文件字节并计算摘要，不能信任可能滞后的本地文件索引。第一版拒绝逃出根目录的路径、符号链接及特殊文件，限制大小，并排除 `.git`、Pi 会话、运行日志、凭据和运行元数据。发布可见性由服务策略控制；`.gitignore` 只影响 Git 跟踪，不能替代这些规则。支持更丰富文件形态需以后单独扩展合同。

## 5. 发布什么，以及什么时候提出合入

并非每个有价值的结果都应进入 main。一次失败尝试、局部观察、未完成证明、反例或独立数据集可以作为 Material 保留，供其他任务检索与使用。代码、证明文件、数据结构和项目文档等文件改动则可以保留为 Workspace candidate，即使 Agent 判断它暂时不值得合入 main。main 只保存项目当前适合作为共同起点的文件内容；不要求每个候选都合入，也不要求所有知识都进入 Git 主线。

Bot 判断一个成果值得提出合入时，应回答：

1. 它推进了哪项 Mission 目标，解决或支持了哪个 Task？其他工作为什么需要把它作为共同起点？
2. 实际内容是否已经持久发布，来源、适用范围、未知项是否清楚？
3. 基于哪个 main 版本产生，与当前主线有什么差异或冲突？
4. 哪些检查适用于它，检查覆盖到哪一步，哪些结论仍只是猜想？
5. 合入是否会使已有可用行为退化，或把已被质疑的 Material 当作无条件事实继续传播？

“能够发布 Material”与“满足 main 合入要求”是两个门槛。局部 Task 如果合同只是交付可复用 patch 或研究报告，发布并达到该合同后就可以完成。若 Task 的合同明确要求项目主线具备该行为，则必须等相应 main 更新成功；不能用一个尚未接纳的候选满足它。

第一版不要求每个研究 Bot 创建真实 GitHub PR。Bot 可以通过 Workspace 工具保存一个 candidate，查看 diff、来源和检查结果，并自行决定是否进一步请求 integrate。Candidate 是 Workspace 管理的 Git 对象/变更，不是 Material；相关研究解释和证据可以另行发布为 Material。本次仓库设计文档的 GitHub PR 是工程审核入口，和运行时项目内的合入候选不是同一个对象。

建议的候选内容至少包括：

| 字段含义 | 为什么需要 |
|---|---|
| Workspace、来源 Task/E、候选内容摘要 | 绑定工作归属及实际待合入内容 |
| 基准 Workspace revision 和 base commit | 能重现差异，识别过时基准 |
| candidate commit、完整文件树及可读 diff | 后继不依赖原 sandbox；审核者能理解改动 |
| 纳入/使用的 Material ID 与具体版本（如有） | 保留知识来源，支持纠错影响追踪 |
| 检查所用输入、检查器/政策版本和结果引用 | 防止把旧版本 PASS 贴到新候选上 |
| 预期改善、兼容性、已知问题及知识确定程度 | 避免把代码通过或合入动作冒充科学结论 |

第一版允许用 patch 作为局部成果，但交给 Workspace 模块推进 main 的候选应能完整物化目标文件树。只有一个 patch 和前任路径、没有可访问基准内容，不能成为可复现的主线版本。内容存储可以去重，逻辑上仍须给出完整可读的结果。

## 6. 普通整合 Task 的完整流程

维护 main 是普通工作，不设置特殊 Task 类型、固定整合 Bot 或永久管理者。任何 Bot 都可以在查看现有工作后提出一个目标清楚、交付要求包含 main 更新的整合 Task；成功 take 后才执行。它的权限仍来自 E 与 Mission 的政策，不来自自己在标题中写了“整合”。

一个普通整合 Task 可以是：“把过滤模块 M1 合入 Workspace W 的当前 main，并通过项目规定的模块和回归检查；保持统计与输出接口兼容。”Bot 执行如下：

1. 读取 Task、当前 main、candidate/Material 的实际内容与修正/质疑记录。确认没有同目标的整合正在进行，记录选择理由。
2. take 后从 Runtime 准备的当前基线开始，在私有副本应用成果。发现旧基准差异时由自己处理，不要求 Runtime 猜测语义冲突。
3. 运行适用检查。需要远程 Judge 时按普通 service call 提交固定输入，并记录其返回结果；单纯本地写一个 `PASS` 文件不构成可信的合入凭据。
4. 选择公开文件并发布不可变Workspace candidate。检查与candidate 的内容摘要一致；若检查后还改了文件，则相关检查失效，须重新执行。
5. 按 Task 的合入政策请求推进 main，带候选、预期旧版本和稳定请求 ID。
6. 若成功，读取服务返回的新 main 版本，登记到本 Task 的结果中。Task 完成条件满足后 release；这个 Bot 不继续 take 下一项工作。
7. 若冲突或被拒，按下一节处理。可以在当前有效 E 内修正后再次提交新候选，或公开已完成部分并按未完成 release。

同一个 Bot 可以在本 Task 范围内发布多个有价值的中间 Material。候选每次修改都产生新的 commit/candidate revision；不悄悄改写旧候选，让检查引用失去意义。若一个研究 Task 的原始完成条件已经包含明确的主线整合，同一个 E 可以完成这两部分，不必为了凑流程额外新建一次整合 Task。

## 7. main 更新的服务端合同

下列操作语义是目标 Workspace API 设计：`candidateSave(...)`、`candidateView(...)`、`integrate(workspace, expected_revision, candidate_commit)`。它不是允许 Bot 自由写任意 ref 的 Git push。为便于审核 prompt，第一版暂用以下 CLI 拼写；它们均未实现，后续接口改名须同步这里与 prompt。

```bash
swarm workspace view --workspace W --revision main --json
swarm workspace candidate save --json
swarm workspace candidate view C5 --json
swarm workspace integrate C5 --expected-revision 0.1 --json
```

`view` 返回 main branch、Workspace revision、对应 commit 和公开历史，不返回私有目录。`candidate save` 由可信 Runtime 从当前 Execution 的独立 clone 导出允许文件并导入 Workspace 本地 Repository，返回 candidate ID 和 commit；candidate 不必关联 Material。`candidate view/diff` 返回基准、候选内容摘要、来源 Task/E 和差异。`integrate` 由 Bot 明确选择候选并请求更新 main，携带 expected revision；服务端验证当前 E、candidate 来源、政策及检查要求。普通调用同步返回结果；如果本地 Git 操作确实耗时而需要异步化，由 Workspace Service 自己定义状态查询，不引入通用 request/permit 框架。

**合入政策在 Mission 初始化时确定并有版本。** 政策声明允许的变更范围、必需的检查、结果证据来源、是否需要人工批准。第一版建议在满足已批准政策的普通变更上自动执行服务端接纳，不要求负责人手工审每一次局部成果；若 Mission 配置要求人工审批，则必须携带相应批准，Bot 无权绕开。没有定义适用检查的项目，不应把“没有检查失败”当作已具备自动合入条件，应先补足政策。

政策检查可以只验证材料格式、来源与范围，也可以验证编译、测试、形式证明或其他领域条件，取决于 Mission。研究性文件允许明确标注的假设与未决问题。**main 表示项目接纳的当前共同工作基础，不保证里面每个知识主张已被证明为真。**

服务处理顺序：

1. 验证调用者身份和当前 E；若 CLI/API 操作本身有重试语义，使用该操作自己的幂等键避免重复更新。
2. 通过 Context API 解析候选及来源，确认可见性、内容持久性和完整摘要，记录当前已知的质疑/修正信息。Context 不可达或附件缺失时不推进 main。
3. 从可信检查服务读取与候选摘要、输入、政策及检查器版本相符的结果。Bot 自述只能作为解释，不能冒充服务给出的通过事实。若项目需要人工接纳，核对针对该具体候选的批准。
4. 在 Task / Workspace 同一事务中检查 E 仍为 `active`、属于当前 Task、Task 仍由它执行，且 E 范围与 Task 合同允许所申请的 Workspace 操作。候选的最终整合生产者必须是这个 Task/E；其他 Task/E 的成果通过候选的输入来源引用保留。确认当前 main 恰为请求的 `expected_main_revision`，候选也基于此版本，政策版本未改变。
5. 原子写入新 main 版本、父版本、候选及来源引用、证据摘要和该请求的成功结果。任何一项条件不成立都不移动指针。返回新的版本与快照引用。

main 更新是一次 Workspace Service 操作。服务在处理时检查当前 E；若 release 已结束该 E，则拒绝。若 integrate 已经完成并返回成功，release 不会回滚已经提交的 main。第一版不为普通操作引入通用跨服务事务协议。

Git commit 本身固定文件树内容。若候选依赖 Material 中的研究主张，Workspace candidate 记录对应 Material ID/版本；integrate 前重新查询其纠错状态。Material 被后续 supersede 不会改写历史 commit，但会提示当前 main 可能需要普通修复 Task。

Workspace candidate 的保存与 main 更新是两件事。候选保存成功但 integrate 失败时，candidate 仍保留，可继续比较、修订或丢弃；它不是 Material，不会因为失败而消失。

## 8. 并发、旧版本与失败处理

| 情形 | 服务与 Bot 的行为 | 保证与边界 |
|---|---|---|
| 两个 Bot 同时 take 同一整合 Task | Task 排他认领只允许一个成功 | 这是 Task 互斥，不阻止它们提出两个语义相同的 Task |
| 不同整合 Task 都从 v1 生成候选 | 首个条件更新得到 revision `0.3`；另一个得到版本冲突 | 不会把后提交候选静默覆盖成另一条 v2 |
| 候选基于 revision 0.1，main 已到 0.3 | Bot 在自己的副本读取当前 main，重新整合并保存新 candidate | 不允许直接把旧快照当成新 main，从而丢掉中间改动 |
| 合入有内容冲突 | Bot 解释冲突并解决，或发布局部成果后未完成退出 | v1 不要求自动语义合并器；不能仅因 Git 没报冲突就判定结果正确 |
| 检查通过后文件又变了 | 旧结果与新候选摘要不匹配，拒绝接纳 | 重新检查受影响内容，不能复用过时的 PASS |
| candidate 导出失败或文件校验失败 | 当前 E 内修正/重试，或未完成 release | 不登记成可整合候选，不先移动 main 再补内容 |
| 提交超时、成功响应丢失 | 使用同一请求 ID 查询既有结果 | 结果未知不是失败，更不是允许重复生成主线版本 |
| main 更新成功后进程崩溃 | 服务已有持久结果，恢复对账；Task 完成另按合同处理 | main 不因 Bot 未收到响应回滚，Task 不靠进程内记忆认定完成 |
| 发布完成后 E 已进入 closing | 新 main 请求拒绝；后继可在自己的 E 中继续整合公开候选 | 不能拿旧凭据完成新的贡献操作 |
| Context/检查服务暂时不可用 | 保留本地工作和已保存 candidate；只有政策确实要求该服务时才暂停 integrate | 不把不可校验当作通过 |

多个 Bot 可以并行准备并保存 Workspace candidates；main 更新本身是一条串行提交线。每次成功更新推进 main 到新 commit，并将 Workspace revision 递增。第一版不创建 Git tag，revision 由 Workspace 元数据维护。这可能成为瓶颈：反复冲突会浪费检查与模型成本。第一版先记录候选等待时间、重做检查次数、版本冲突和浪费成本；Bot 提案策略优先复用已有整合工作，必要时把彼此依赖的变更放入一个边界明确的普通 Task。是否需要合入队列或更复杂调度，必须由测量结果支持，暂不新建调度子系统。

## 9. 错误成果、纠正与撤回

Material 的更正与 Workspace 的修复是相连的两个步骤。发现 M1 错误时，Bot 先按照 [Material 纠错策略](02-task-material-policies.md) 发布有来源的质疑或更正，并关联被质疑内容与使用范围。原 M1 以及引用它的 main 历史不被静默改写。

Workspace 模块通过已登记来源关系展示哪些主线版本引用了 M1，并把当前版本的相关疑点呈现给 Bot。已经从该版本启动的 E 不会自动换文件，但应能在再次取用、发布或请求合入时看到最新纠错状态。通知/状态标记是在提醒需要重新判断，不能代替对影响范围的研究。

需要修复时提出普通 Task：“确认 M1 对当前 main 的影响并修正过滤边界行为”。执行者从最新 main 开始，验证问题、保留其他已经合入的成果，发布修正候选并通过同样的条件更新过程生成新版本。撤回也以新版本表达，保留被撤回版本、原因、证据与后继版本的关系；不要求 Bot force-push 或抹除历史。

如果紧急停止使用某版本是 Mission 的运维需求，负责人可以按已批准的管理策略暂停新执行或暂停合入。此操作与 Bot 的普通权限分开。第一版不新增由 Bot 自行触发的全项目自动回滚器，更不以某条纠错意见自动删除其他 Bot 的成果。

## 10. 贯穿四 Bot 例子的版本轨迹

Mission 是为 CSV 分析工具添加过滤、分组统计和 JSON 输出。Workspace W 的 main 初始 commit `c0`、revision `0.1` 来自原始项目文件；独立说明/样例可另存为 Material M0。[运行章节](01-model-and-runtime.md)解释四路启动；这里聚焦版本与归属。

| 事件 | 私有工作与公开产物 | W 的 main | 说明 |
|---|---|---|---|
| B1/T1、B2/T2、B3/T3、B4/T4 各自 take | 各 E 从 commit `c0` 建立独立本地 clone | main revision `0.1` | 四路并行不共享可写目录 |
| B1 完成过滤 patch | 发布 Material M1（研究说明/证据），并保存 Workspace candidate C1（代码变更）；T1 按局部交付完成 | main 仍为 `c0` / revision `0.1` | 发布 Material 和 candidate、Task 完成均不自动合入 |
| 新 B5 take 普通 T5 整合 C1 | 在当前 main 基础上应用 candidate C1、检查并形成新 candidate C2 | `c0` → `c1` / revision `0.2` | 由普通 Task 推进 main；候选 C1/C2 是 Workspace Git 对象，不是 Material |
| B2 部分完成分组统计后 release | 发布未完成 Material M2；如有文件变更可另存 candidate C3；T2 可继续 | main revision `0.2` | M2 不确定性不会因存在 main 而消失 |
| 新 B6 再次 take T2 | 从 main commit `c1` / revision `0.2` 创建独立 clone，并读取 M2/C3（若公开） | main revision `0.2` | B6 不能访问 B2 私有目录；candidate C3 是显式公开候选而非私有工作目录 |
| B3 发布 JSON patch | 保存 Workspace candidate C4（基于 `c0`），可另发 Material M3 解释实现和测试结果 | main revision `0.2` | 候选保留不意味着必须合入 |
| 后继 Bot/T6 整合 M3 | 在 v1 整合，保留过滤功能，重新检查并发布 M6 | v1 → v2，指向 M6 | 不将 v0 + JSON 直接覆盖为最新 main |
| B4 的验证资料 M4 被后继 Task 使用 | 记录有意义的使用关系；若测试文件值得保留，也可保存 Workspace candidate | 视后续判断而定 | Material 和 Git 文件候选各自独立 |

若另一整合 Bot 在同一时段也以 v1 提交，只有一个请求能够把 v1 推进到 v2。失败者仍保有自己的候选 commit，但需要面对新的 v2 重新判断。这是共享主线的必要代价，不能在例子中省略。

最终报告应分别回答：哪些 Task 达成交付；哪些成果已公开；main 当前具备什么；哪些 Mission 验收条件已经验证。分组统计未完成时，即使过滤和 JSON 已合入，Mission 也没有因此完成。

## 11. 第一版边界与后续问题

第一版仅需要一个 Workspace、一条 main、每 E 一个私有副本、显式 Material 发布、普通整合 Task，以及可重试的条件更新。Git、分支、工作副本与 PR 式审核是工程基础；本项目不把使用这些机制本身作为创新声明。它们的作用是让分工形成的成果有一个可持续累积、可追踪的共同位置。

值得研究的是 Task 选择、可检索和可纠错的 Material、受控主线累积如何共同影响实际工作质量与成本。是否比独立并行后一次性整合更好，是否减少重复探索与错误传播，需要[对照实验](05-validation-and-research.md)，目前没有本阶段的运行证据。

以下内容不作为 v1 必需机制：多 Workspace/跨 Mission 合并、长期 Bot 身份、私有工作继承、自动语义冲突解决、通用合入队列、所有候选自动纳入 main、强制 GitHub 账号与真实 PR、自动科学判真。需要逐项审核的具体建议包括：Workspace 模块的部署位置、项目适用的合入政策、完整快照的存储成本、工作副本与公开历史的保留上限。它们不能凭“方案总体可接受”就被描述成已经通过实现验收。

## 12. 与当前实现的差距及验收

当前基线的 WorkspaceManager 会为每个 Execution 初始化自己的 Git 仓库及名为 main 的分支，并支持从前任 Workspace 的指定 revision/commit 克隆。它没有由所有 Bot 共同推进的 Workspace 主线。当前 architecture 还明确说明本地文件索引可能滞后于 shell 写入，Git 提交与元数据快照不等于一个覆盖全部实际字节的原子版本。这些事实见[固定版本 WorkspaceManager](https://github.com/LuNa-shi/SwarmEnv/blob/008ecdb9ab64adcd8135042ff2160ec1db704952/src/runtime/workspace-manager.js)与[当前 Workspace 实现手册](../../architecture/05-workspace-continuity.md)。

因此本阶段涉及真实行为迁移，不能只把旧目录改名或把 `parent_workspace` 改成另一英文词。需要建立共享 Workspace 与 main 记录、公开内容物化、当前 E 授权、候选导出和条件更新，退役跨 E 私有克隆；同时保留旧实验记录对旧实现的准确说明。具体改动顺序见[架构迁移](06-architecture-migration.md)。

本章的实现验收至少应能观察到：

- 四 E 各自从明确版本启动，修改自己的目录不会改变其他副本或 main。
- Bot 不能通过共享 `.git`、宿主卷、旧私有仓库或伪造 CLI 字段绕过权限。
- 原 sandbox 删除后，所有被接纳主线版本仍可从 Workspace 本地 Git Repository 的 commit 精确物化；未发布内容不能被后继取回。
- 两个同预期版本的合入最多一个成功；响应丢失重试返回原结果，不产生重复版本。
- 输入或候选字节变化使旧检查不能继续授权；release 先撤权时拒绝新的 main 更新。
- 候选 commit 导入、Workspace main 更新、Task 收尾之间的部分失败都能重试并对账。
- 纠正 Material 不静默改历史，当前 main 的来源与需重验部分可识别，并能用普通 Task 发布修复版本。
- 真实运行记录能区分 Task 交付、Material 发布、main 前进与 Mission 验收；任何一项都不以 HTTP 成功或 Git 提交数量代替。

这些是待实现的验收条件。本文档 PR 的检查只能验证文档及引用一致性，不能证明上述 sandbox、授权或合入路径已经运行通过。
