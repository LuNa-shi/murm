# 05. Workspace：文件、revision 与 main 合入

> 设计附件：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · 状态：目标设计，尚未实现。
> 已确认：Mission 与 Workspace 一对一；Workspace 是 sandbox 外的本地 Git Repository；Runtime 管理全部 Git；candidate 是某个 Workspace revision 中的普通文件，不另设 Candidate 对象、ID、存储或调用接口。
> 已确认：save/apply 按完整文件树处理，**merge 以完整 revision 的变更集合为单位原子合入**；文件按 revision + path 单独读取和引用。v1 不提供逐文件选取合入，理由与影响见第 5 节。

本文定义 Workspace 文件版本、只读访问、保存、接续、main 合入与失败恢复。Sandbox、固定路径和权限顺序以 [02](02-sandbox-runtime.md) 为准；Task 责任见 [03](03-task.md)；研究内容与纠错见 [04](04-material.md)；Mission 最终提交见 [01](01-model-and-runtime.md)。

## 1. Workspace、revision 与文件引用

Mission ID 标识整体目标，Workspace ID 标识其唯一项目仓库，两者不能混用。main 是该仓库内的真实 Git branch。Workspace 位于 sandbox 外，跨 Agent、Task 和 Execution 保留；Mission 结束不删除文件版本。第一版不需要远程 GitHub Repository，不创建 Git tag，不自动 TTL 或 GC。

每个公开、不可变的文件树都取得 Workspace 范围内唯一的 revision，包括初始版本、尚未合入的保存版本，以及成功合入 main 的版本。revision 映射到完整 Git commit/tree；main 指向其中一个版本。编号可按分配顺序递增，但**编号大小不表示继承关系，也不表示已经进入 main**；父版本关系由 Git parents 表达。初始版本可显示为 `0.1`；本文 `R1`、`R12` 等是 revision 的可读代称，不是另一类 ID。

这替换旧稿“只有 main 更新才产生 Workspace revision”的定义。未合入成果也必须通过 Workspace revision 读取，不能另外引入 Candidate ID 才能访问。

| 概念 | 权威事实 | 边界 |
|---|---|---|
| Workspace | 仓库身份、公开版本、main 与版本来源 | 不保存 Material 正文，不判断研究价值 |
| revision | 不可变完整文件树、Git parents、来源与保存请求 | 未合入版本也是正式可读版本 |
| main | 当前接纳的共同项目版本 | 不等于 Task done 或 Mission accepted |
| 文件引用 | `(workspace_id, revision, path)`，可附内容摘要 | 路径须存在于该 revision；不能脱离仓库引用候选 ID |
| E 工作目录 | 当前 E 独立、可编辑的项目文件树 | 未保存内容不成为后继可见的公开成果 |

“candidate”仅描述某文件正被考虑作为成果或检查输入。例如 `W1 / R12 / proofs/lemma.lean` 就是候选证明，通过普通文件读取、版本比较和 Workspace 操作使用。相同路径在不同 revision 中是不同的确定版本；改名、删除产生新版本，不改写历史引用。

Material 保存研究说明、结论、反例和证据，可以引用上述文件坐标。revision 来源可记录 Material ID/内容版本；文件不需复制成 Material 才能公开，Material 也不能代替实际文件字节。

## 2. 服务职责与最小版本记录

Workspace 是独立逻辑模块，v1 与 Task Service 位于同一协调进程和事务域，协调 E 有效性、Mission 提交冻结和 main 更新。Context Service 独立持有 Material，通过 API 查询，不跨库读取正文。不要求新增微服务，也不引入通用 pending/permit 平台。

| 责任 | 负责方 |
|---|---|
| 仓库、revision、main 与请求结果 | Workspace 模块 |
| 隔离工作树、稳定导出、物化输入与全部 Git 操作 | 可信 Runtime / Workspace 模块 |
| 编辑文件、决定保存/接续/合入、解决内容冲突 | 当前有效 E 的 Agent |
| 验证指定内容和环境、保留检查结果 | Mission/Task 配置的可信检查服务 |
| 发布、检索和纠正研究内容 | Context / Material Service |

revision 最小记录包括 Workspace、revision、commit/tree、parents、来源 Task/E/Agent 或受控初始化来源、初始输入与 apply 的版本、真实改动路径/摘要、可选 Material 引用、请求 ID。Runtime 从真实身份和内容产生字段；Agent 不能自报 Git author、Task/E 或 SHA 来获得权限。保存发生在未解决的 apply 冲突中时，还记录冲突状态和路径，区分“可以接续”和“可以合入”。

main 合入另记旧 main、新版本、检查输入/环境和请求结果。检查沿用服务自己的记录，不新增核心对象。索引可加快查询，但不能成为脱离 revision 的候选事实来源。

## 3. 初始化、只读浏览与工作目录

### 3.1 初始化与 take 前阅读

操作者提供 Mission 与初始项目文件。Runtime 建立仓库、初始 commit/revision 与 main；空项目也有明确版本。只有文件树已持久且可重新物化，才宣告就绪。独立研究输入可受控发布为 Material。

Agent 启动时在 sandbox 中预留固定 `/workspace/project`；未 take 时为空且不可写，不假设存在完整本地只读 clone。Agent 经 Workspace 服务列目录、读文件、搜索内容和比较版本。Pi 会话、CLI 配置、skills、缓存及运行日志置于独立运行目录，不进入项目导出范围。

只读接口允许 Mission 阅读身份在未绑定 E 时使用：

- `files` 返回目录、路径、类型/大小与分页信息。
- `read` 返回实际内容、摘要、范围与截断信息；二进制按声明的字节/下载接口返回，不能仅给摘要冒充正文。
- `search` 支持路径与文本检索，说明命中、分页及未覆盖范围。
- `history --all` 和 `diff` 能发现、比较尚未合入的公开 revision，显示来源 Task/E 与 main 可达关系。

`--at main` 是移动引用。一次查询先解析为确定 revision，结果返回该版本；分页和关联读取继续固定该 revision，不能翻页时切换到新 main。精确历史读取不需要当前 E。

### 3.2 take 的初始输入

Task 可指定公开 Workspace revision；未指定时 take 解析当时 main。Runtime 固定实际初始 revision，从仓库导出完整树，通过已验证的 Provider 文件传输能力填充固定目录。顺序为：**准备并核对输入 → E active → 开放目录写权限 → 发布贡献绑定并返回 take 成功**。不假设 Provider 支持动态挂载，不向 Agent 暴露 `.git`、共享 refs 或管理凭据。

新 E 不读前任私有目录、会话、shell history 或未保存对象。接续来自公开 Task、Material 和 Workspace revision。默认 take 后可显式 `workspace apply --from R12` 接续未合入版本，无需 Candidate 下载或恢复接口。

### 3.3 初始输入不永久冻结工作基线

初始 revision 是不可改写的审计事实；同一 Task、同一 E 内允许显式 apply 新 main 或其他公开 revision。`status` 分开说明 initial revision、last saved revision、applied revisions、未保存差异和冲突。apply 后未 save 的合成树不能被称为已持久 revision。

main 前进不强制结束 Agent，不修改 Task 的 Goal、Deliverable 或 Completion condition。若 Task 明确要求复现固定历史环境，更新工作树后不能声称仍在原环境完成复现；保留原验证，或提出目标不同的新 Task。普通开发 Task 更新输入不等于改变工作责任。

## 4. 保存一致文件树

`workspace save` 保存当前项目树为新 revision，返回 revision、真实改动路径、摘要、parents 与来源；不推进 main，不自动完成 Task。无内容和来源状态变化时可明确返回已有版本。连续 save 沿上次保存版本建立父关系，不能每次重挂初始 main；apply 后保存保留实际双方 parents 和输入来源。

保存的顺序与失败合同：

1. 在本 E 取得短暂的 Workspace 操作互斥，确认 E/Mission 允许保存。
2. 等待当前写入完成，以经验证的暂停写入或一致快照机制稳定整个项目树。扫描两次、计算 hash、禁止新工具调用，都不能单独证明后台进程已停止写入。
3. 无安全导出窗口时返回 `WORKSPACE_BUSY`，不宣告成功、不自动结束 E。硬停止不承诺临时内容一定保存。
4. 读取真实字节，核对路径、类型、大小与范围，在同一 Workspace Repository 建立 commit 和 revision。
5. 确认内容、来源与请求结果可重新读取后返回成功，释放短暂保护。结果未知时用原 request ID 查询/重试。

v1 拒绝越出根目录的路径、符号链接、特殊文件、超限文件及 `.git`、会话、运行配置、日志和凭据。`.gitignore` 不是安全边界。仅有 patch、前任 sandbox 路径或自报 manifest，而没有完整可物化树，不算已保存。

save 固定内容，不保证研究正确。可以保存未完成证明、失败实验和未解决冲突，但须如实显示。对于 apply 已报告的冲突，普通 save 保留进度；处理完成后 `save --resolved` 表达 Agent 已处理这些冲突，由 Runtime 核对树和冲突状态。未解决版本不能直接 merge；声明 resolved 也不代替指定检查。

## 5. Candidate 文件化对操作的影响

文件引用与变更集合应分开：一个证明文件可以独立引用，代码、测试和配置却可能必须一起合入。save 固定完整文件树，apply 根据完整版本及父关系准备工作树。**已确认 v1 的 merge 以完整 revision 的变更集合为合入单位；candidate 仍只是其中的普通文件。** 指定检查针对最终合成树，成功时整体推进 main，不逐个文件部分提交。

| 旧稿操作 | 统一操作 | 影响 |
|---|---|---|
| 创建 Candidate / 取得 Candidate ID | `workspace save` 得到 revision 与改动路径 | 不另存候选正文、压缩包或 manifest |
| candidate list / view | `history --all`、`files/read/search --at R` | 查版本和文件，不维护候选查询体系 |
| Candidate diff / 引用 | `diff --from R1 --to R2`；引用 `(W, R, path)` | 固定内容，不依赖可变路径或独立 ID |
| 接续 Candidate | `workspace apply --from R` | 物化并三方整合公开版本 |
| integrate Candidate | `workspace merge --from R` | 根据 ancestry 合入变更集合，不用旧文件覆盖 main |
| Candidate discard | 无独立 discard 状态/命令 | 不再选用该版本即可；后续项目树里的文件可普通删除再 save，旧 revision 仍可读 |

删除当前文件与删除历史不同。未入 main 的实验版本可以不合入；已入 main 的错误文件通过删除/修正、save 和 merge 形成新版本撤回。v1 不设置文件级 active/discarded 状态，不自动 GC。`history` 默认看 main 历史，`--all` 看所有保存版本，可按 Task/E 和路径筛选。

v1 不提供按文件选取合入。只需贡献部分成果时，先在工作目录准备包含所需完整成果集合的新 revision，再请求 merge，并审阅全部 changed paths；不能把一个文件引用当作此次合入范围。这保留删除、重命名和关联文件在同一次版本变更中的一致性。

## 6. 同一 Execution 内接续与冲突处理

`workspace apply --from R` 将公开 revision 与当前工作状态做真实三方合并；`--from main` 先固定实际 main revision。它只更新本 E 工作树，不推进 main。Runtime 记录来源和 parents，Agent 不执行 Git。

apply 前先 save 未保存改动；存在未完成写进程或不安全切换时返回 `WORKSPACE_BUSY`。使用与 save 相同的稳定窗口和 E 内互斥，防止后台写入与安装并发；不能靠一次 status 判断代替该保护，也不能静默覆盖目录。

无冲突时返回实际输入与改动摘要，Agent 核对后 save。有冲突时在工作目录交付可编辑合成结果和完整冲突说明，包括删除/重命名冲突，保留双方 parents；Agent 用普通文件工具处理后 `save --resolved`，再 merge。接续含未解决冲突的 revision 也继承并显示冲突状态，不能因为换了 E 就清除待处理事实。

apply 响应未知先查原请求，不重复安装；失败不能留下对 Agent 宣称成功的半棵树。Runtime 完成安装或从本 E 已固定版本恢复，对账前暂停该工作面的新写入。finish 与安装互斥；finish 已接受后，迟到 apply 不能重新开放目录。

例如 B1 保存 `R12 / proofs/lemma.lean` 后退出；B2 take 后读取并 apply R12，补完证明、save R15、merge R15。全过程用公开版本和普通文件，不继承前任私有状态。

## 7. main 的三方合入与检查

### Lean 项目检查的补充要求

[Issue #127 的后续实施决定](https://github.com/LuNa-shi/SwarmEnv/issues/127#issuecomment-6906617716)将 Lean 检查输入扩展为固定修订的完整 Workspace。多个 Agent 可以分别交付 Lean 文件，通过 `import` 接续；整合不要求复制辅助证明正文。具体研究依据见 [Workspace 项目检查调查](11-workspace-judge-research.md)。

- Judge 取出同一不可变修订的文件树，由固定工具链和可信 Lake 配置确定所有应检查的 Lean 模块，交给 Lake 处理依赖顺序。不得把无法覆盖的 Lean 文件静默排除后声称整项目通过。
- Agent 提交源码，不能通过改变检查配置、依赖、工具链或构建目标降低验收条件。项目编译在隔离、无网络且有资源与时间界限的环境中进行。
- 项目检查结果记录实际文件覆盖、修订、Git 树和检查环境。指定文件的交付证据还须证明该文件确实参与了对应项目检查；仅存在于快照中不够。
- 普通项目诊断可以帮助处理包含未完成证明的中间版本，必须如实记录警告与检查范围。项目编译成功不自动完成 Task 或 Mission；最终验收仍核对锁定原题声明、证明依赖和可信内核重放。
- 合并检查依旧绑定最终合成树，并受原有权限、冻结、截止时间和 main CAS 规则约束；公开检查结果不赋予过期 Agent 新权限。

以下合并顺序仍适用。

### 7.1 谁可以合入

当前有效 E 可自主请求 merge，不要求原 Task 预先包含整合责任。复杂冲突、跨 Task 协调或大范围重构可另建普通整合 Task；不设永久整合 Agent，不为每次 main 变化创建新 E。

Task 只要求可复用文件时，save 并给出文件引用即可交付；要求研究内容时发布 Material；只有 Completion condition 要求 main 包含变更时才必须等 merge。Task done、save、merge、Mission accepted 分别记录，互不替代。并非所有保存版本都要入 main。

### 7.2 一次 merge 的顺序

1. 用 request ID 固定 `merge --from R`，确认有效 E、其当前操作权限允许 merge（未进入仅允许保存/发布/finish 的软收尾）、同一 Workspace、Mission 未停止/冻结；源 revision 完整可物化、来源可追溯且无未解决冲突。
2. 固定当前 main 为 M，按实际 Git ancestry 三方合并 M 与 R。旧初始版本本身不是拒绝理由；不把 R 的旧快照直接覆盖 main。
3. 有冲突时返回固定 M/R 和冲突说明，main、源 revision 和当前 E 保持不变。Agent 先核对当前工作树是否已包含源 R。若未包含，先 save 自己的进度并 apply R，处理/保存该次冲突，再 apply 固定或更新后的 main，修复、save 后重试。若已包含 R，可直接 save 当前进度后 apply main。不能只更新 main 却遗漏待合入的 R；复杂工作才交给后继。
4. 无冲突时，在隔离目录检查**最终合成树**，运行 Mission/Task 指定检查并固定 checker、环境/工具链和政策版本。R 上的旧 PASS 不自动覆盖与新 main 合成的内容；可信 checker 不能由 Agent 修改。
5. 检查通过后，在提交临界区再次确认 E 有效且仍允许 merge、Mission 未冻结/停止、main 仍是 M，以 CAS 条件更新 main，登记新 revision、parents、检查与请求结果。
6. 返回新 main revision。merge 成功不静默改当前 E 工作树；需要同步时显式 apply main。

Git 三方合并依据共同祖先处理内容和重命名。[git merge-tree](https://git-scm.com/docs/git-merge-tree) 可不改调用方工作树/索引而构造合成树；[git update-ref](https://git-scm.com/docs/git-update-ref) 支持带旧值的条件更新。这些能力不代替语义检查，也不自动提供 Git 与业务数据库之间的事务。

没有额外配置检查时，不虚构测试门槛；身份、内容完整性、冲突状态和 CAS 仍须验证。无文本冲突不等于研究正确。Material 纠错不静默修改历史；其消费者判断重验与修复。

### 7.3 并发、重试与冻结

| 情形 | 结果与下一步 |
|---|---|
| main 前进而 R 无冲突 | 对当前 M/R 合并并检查最终树，无需结束 E |
| 两请求针对同一 M 检查 | 至多一个 CAS 成功，另一个 `MAIN_MOVED`；保留版本与 E |
| 检查期间 main 再前进 | 本次 `MAIN_MOVED`；新尝试重新合并检查，不复用旧树 PASS |
| 响应丢失、结果未知 | 原 request ID 查询/重试返回原结果；同 ID 改载荷拒绝 |
| 已收到明确冲突后重试 | 新尝试 ID；CLI 管请求标识，Agent 不管理 SHA |
| R 已包含在 main | 返回 already-included/no-op，不虚增版本和检查费用 |
| 历史贡献被后续版本撤回 | 旧 merged 记录不证明当前有效；恢复须用新修正 revision |
| Mission 正在最终验证 | `MISSION_SUBMITTING` 拒绝 merge；现有 E 按原权限/预算继续本地工作和 save/publish，验收快照不变，冻结本身不启动软收尾 |
| E 进入软收尾、finish 已接受或失效 | 新 merge 拒绝；尚未提交的 merge 也在最终 guard 拒绝 main 更新，保存版本与既有检查记录保留 |

v1 一请求只针对固定 M 尝试，不在服务内无限重试。竞争使用有限退避并计入预算；CAS 不保证每个 Agent 在有限时间内成功。保存、合并、等待、检查和失败成本均进入总成本。

## 8. Git 与版本记录的故障一致性

每次 save/main 更新都有 Workspace 自己的持久请求记录，不是通用作业系统。成功响应表示内容、revision、来源和结果可在重启后恢复。Git 与数据库并非天然原子事务，不能只写“可对账”而没有恢复判据。

v1 使用本 Workspace 单写者和恢复屏障：先持久记录 request、旧 main、新 commit/revision、检查及提交意图，再 CAS 更新 ref，最后完成 revision/main 索引和请求结果。持久 revision 的 Git 对象由内部保留引用保护，不依赖悬空对象；这些引用不成为 Agent 操作的 branch/tag。

- ref 仍为意图的旧值：尚未成功推进，可恢复执行或明确失败。
- ref 已为意图的新值：完成索引与原结果，不重复推进或登记版本。
- ref 与旧/新值都不同：关闭写入口并报告对账错误，不猜测、不回退或覆盖版本。

重启先恢复未完成请求再开放 main 读写；运行中 ref/索引临界区的读取须返回一致版本，或短暂不可用，不能旧 revision 配新文件。后续写者不可跳过未完成提交。只导入对象但 save 未登记完成时，不返回成功；原 ID 可安全完成同一保存请求。

finish、Mission freeze 和 merge 最终提交在同一协调域决定先后：finish/freeze 先成立则迟到 merge 不提交；merge 已成功则后续 finish 不撤销。临界区只覆盖最终核验/持久提交，不运行长时间 checker。具体持久化与故障演练是实现验收门槛。

## 9. Workspace CLI 合同

以下是目标 CLI，尚未实现；服务执行授权，CLI 不是安全边界。Workspace 可来自可信 Mission 绑定，跨上下文引用须明确 Workspace ID。

| 命令 | 用途与身份 |
|---|---|
| `swarm workspace view` | Mission 阅读身份看 Workspace、main 与状态 |
| `swarm workspace history [--all]` | main 历史/全部公开版本，按 Task/E/路径过滤 |
| `swarm workspace files --at R [path]` | 列目录，返回固定版本和分页 |
| `swarm workspace read path --at R` | 读取实际文件，无需 E |
| `swarm workspace search query --at R` | 检索版本的路径/内容，无需 E |
| `swarm workspace diff --from R1 --to R2` | 比较公开版本；无参数时看当前 E 差异 |
| `swarm workspace status` | 初始输入、保存版本、apply 输入、dirty/conflicts |
| `swarm workspace save [--resolved]` | 有效 E 保存稳定树，不改 main |
| `swarm workspace apply --from R` | 有效 E 三方整合到本 E 目录，允许 `main` |
| `swarm workspace merge --from R` | 有效 E 请求检查完整 revision 的最终合成树，并原子条件更新 main |

副作用请求支持稳定 request ID 与原结果查询；普通网络重试沿用 ID，明确失败后的新尝试用新 ID。读请求固定 revision，不能用自填 Task/E 升级身份。完整提示与 skill 见 [06](06-prompts-and-skills.md)。

## 10. 验收边界

必须验证：未绑定 Agent 能读确定版本的真实文件；未合入 revision 在 sandbox 销毁后仍可接续；save/apply 保留 ancestry；稳定导出不混入后台写；安装失败不留假成功；main 持续变化不强制换 Agent；检查绑定最终树；CAS、结果未知、撤权/冻结竞态和 Git/索引崩溃窗口均有确定结果。

还须验证没有第二套 Candidate 身份：读写只经普通 Workspace 接口，删除当前文件不破坏历史引用；多文件成果按第 5 节已确认的整版粒度处理。组合场景见 [07](07-validation-and-research.md)，迁移见 [08](08-architecture-migration.md)。本次文档不证明这些运行路径已实现或通过真实 provider 测试。
