# Issue #122 · 设计与实现对账

## Results

### 固定对象与证据边界

| 对象 | 引用 |
|---|---|
| 需求和批准 | [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)；批准设计 `0541ae6e42cbe41ff41ed499c257a57340b83b09`，范围为 [01–08 章](README.md)。 |
| 修复前差距 | [09 实现审计](09-implementation-audit.md)。其中的根 Task、私有接续、提示发送和最终验收发现是当时固定树的事实。 |
| 本附件的实现点 | `9172e04f51b14df26fbbda11d2f4a02173de27b9`。其基线 `c8b2b7f162331eaada347b5f226280373a5d9677` 的全量测试 568 项，559 通过、9 跳过、0 失败。后续提交只修正关闭时已结束的启动拒绝被误判为清理待确认；修复版全量测试 569 项，560 通过、9 跳过、0 失败。代码与 [架构手册](../../architecture/INDEX.md)、[文件清单](../../architecture/source-map.json) 和生成 API、存储及 prompt 附录共同核对。 |
| 历史实验 | `issue122-formal24` 在 `7c5836f` 上运行单项目约一小时。用户提供的报告记录 `protocol_valid=true`、`invalid=false`、耗时 3,620,758 ms，以及 Workspace、Material、Task、Judge 调用。它说明当时路径可以执行，不能验证修复后的模型。 |
| 修复过程证据 | E1 为确定性测试，D 为实际本机 Docker 探针，P 为本机 OpenSandbox 经 Runner、真实 Pi、CLI、Bridge 和 Service 的受控脚本轨迹，R 为实际 OpenSandbox 丢响应恢复探针。以下列明的早期受控证据产自固定前的整合工作树和当时的探针镜像。带固定运行说明的轨迹按所列提交和镜像核对。E3 为真实模型自主运行，尚未执行。 |

### 最终固定版本复验

`e2-pinned-1794686745928` 在实现 `9172e04f51b14df26fbbda11d2f4a02173de27b9` 和镜像 `sha256:ce7a78357e493449be6203bff22c9a781ec0637d5bc148e428ed066a117cdad3` 上完成。四个不同 Execution 实际重叠，四项独立 Task 均 DONE；四路真实 save、Material 发布与源码 Judge 检查之后，增量成果依次合入 main。固定 B1 最终检查仍为 FAIL，查询该结果后原 E 能再次合入。`protocol_valid=true`、`invalid=false`、`solved=false`，没有清理错误或脚本断言失败。16 个 Bot 均 CLOSED，正确的 provider `/sandboxes/{id}` 路由逐一返回 404，实际列表接口返回 HTTP 200 和空列表。

该诊断由本地 Responses 脚本指定动作，不是 30 分钟真实模型实验。它验证的是部署与合同执行。早一版诊断脚本未处理正常的 `CHECKER_BUSY`，在四路同时请求而 Judge 并发上限为 2 时断言失败；重跑使用有限的同请求 ID 重试，未提高生产并发限额。早期失败证据保留。最终分析位于忽略提交的 `experiments/e2-pinned-1794686745928/analysis/experiment-analysis.md`。

收尾时还逐一复核了本轮 32 个受控运行所记录的 411 个不同 Sandbox ID，均返回 404。这包括未完成预期断言的诊断尝试，只说明这些已知资源不再存在，不能据此把失败探针写成通过。

本文是固定版本的证据附件。批准范围、PR 状态、后续问题与合并决定以 Issue 和对应 PR 为准。

### 约定与正常入口

- **启动与发现。** Mission 从零 Task 开始，初始公开 Workspace 有固定版本。四个可复用 Core 独立运行，各自启动一个无绑定 Bot、Pi Session 和 Sandbox，先读 Mission、项目版本、Task 状态和相关 Material。空队列时，各 Bot 能提出各自的独立工作。已有可执行积压时先考虑已有 Task，再补提议；服务不为满足计数强迫每个 Bot 创建重复工作。提议不等于领工，提议者身份不形成所有权。正式运行需检验真实模型究竟怎样选择。
- **选工与执行。** Bot 通过明确的 `task take` 获得一个 Execution。并发竞争同一 Task 时只有一个赢家；其他 Bot 可以继续发现和选工。提案可以用 `base_revision` 固定起点，未指定时 take 解析当时的 main。Runtime 校验实际 Bot 和执行栅栏，固定初始 Workspace 的 Git commit/tree 与声明的 Material 版本和哈希，准备完整 guest 项目后才授予写权限。若起点与预览不同，take 返回有界差异、继续游标和重读提示。已绑定 Bot 在执行中可以贡献独立提议，但不能再次认领。第一个提议没有根 Task、阶段控制或验收特权。
- **结束、接续与验收。** `task finish` 记录实际结果并进入持久收尾，物理清理确认后才解除占有。未完工作经公开 Material、固定文件版本与 Task 记录交接。后继从新 Bot 和新 Sandbox 开始；Task 身份可以延续，旧 Pi、私有草稿和令牌不会成为新 Session 的输入。Workspace 合入与 Mission 验收各自检查明确的政策。增量成果可进入 main；最终验收针对冻结的完整交付物。
- **并行口径。** 四 Core 独立发现和执行的并行性由重叠的持久 Execution 证据判定。四个 Session 存活、工具调用数量或四份报告不单独证明正在并行研究。同一 Task 排他占有仍成立。

### 改动与架构落点

| 批准设计及原差距 | 已执行的实现及架构 |
|---|---|
| [01 Runtime](01-model-and-runtime.md)：原入口把第一提案提升为根，调度围绕既定 Task，最终结果可能由 Runner 推断。 | Runner 的 Mission 初始化、四 Core 发现、绑定交接和收尾；Task 只接受显式 take，Bot 注册、清理和 Mission 提交独立持久。按 Bot、Execution、Sandbox 记录生命周期，接受后关闭新研究工作，已获授权的收尾受原期限约束。[01 Agent Core](../../architecture/01-agent-core.md)、[02 Execution](../../architecture/02-execution.md)、[03 Mission/Task](../../architecture/03-mission-task.md) |
| [02 Sandbox](02-sandbox-runtime.md)：旧入口可延续 Session、私有工作目录或放宽访问，按任务耗时不足以证明资源受限。 | `runtime`、`opensandbox-manager`、worker、Docker 隔离辅助程序和模型网关固定新 Bot 的身份、项目权限、到期、出站网络、磁盘及 inode 上限。Sandbox 创建意图、provider 标记与 ID 先持久化；丢响应、迟到资源和重启对账不能靠本地清除标签宣称成功。请求额度、真实清理及本地原始审计是独立边界。[02 Execution](../../architecture/02-execution.md)、[06 Observability](../../architecture/06-observability-experiments.md)、[07 Configuration](../../architecture/07-run-configuration.md) |
| [03 Task](03-task.md)：旧 root/父子/阶段字段影响调度；选工受报告分页、辅助代领或瞬时状态影响。 | Task 服务使用平面 Mission 队列、有界只读发现和固定插入窗口游标，页内状态仍为当前状态。同一责任键仅在合同及输入一致时去重；同请求 ID 重放原回执。排他 take、幂等回执、动态依赖、`blocked` 收尾、有限协调授权下的取消和前置修复。报告聚合总量独立于 Task 详情页；只读/提议计数不冒充进展。[03 Mission/Task](../../architecture/03-mission-task.md)、[04 Services](../../architecture/04-services.md)、[06 Observability](../../architecture/06-observability-experiments.md) |
| [04 Material](04-material.md)：旧发布要求全局种类或 Evidence 状态，读取得量和复用混淆，纠错缺少版本比较。 | Context 持久保存正文、附件字节、哈希与版本，声明式 use 固定实际消费身份及影响，引用可连到新 Material 或 Workspace revision。近似检索有界，exact 读取保留历史身份。dispute 记录质疑，正式替代指向完整新 Material；撤销校验原后继及观察版本，保留旧关系和撤销事件。跨 Mission、未授权和已有关闭栅栏由权威服务拒绝。[04 Services](../../architecture/04-services.md)、[05 Workspace](../../architecture/05-workspace-continuity.md) |
| [05 Workspace](05-workspace.md)：旧读取与保存可能混入 host 私有树，不能以路径或旧 PASS 当作固定输入。 | 每 Mission 一个公开 Git 仓库。公开 view/history/files/read/search 与 revision-pair diff 使用固定版本和有界分页。take 安装完整字节树。guest 暂停采集、save 回执对账、apply 三方安装与回滚、显式冲突解决、merge 合成树和 main CAS 对应真实文件和 Git ref；历史版本仍可读。合入与最终验收分别取明确政策，无额外合入 checker 时允许结构合法的部分工作进入 main。[05 Workspace](../../architecture/05-workspace-continuity.md)、[07 Configuration](../../architecture/07-run-configuration.md) |
| [01/05 最终验收](01-model-and-runtime.md)：先前的 SOURCE 检查和 Runner 汇总不足以判定 Mission 已交付。 | 普通 Judge 校验授权的固定公开文件、工具链和输入身份。Mission 提交独立固定 main tree、Material 清单、接受条件、checker、deadline 和冻结代次，由锁定 Lean 验收器评估合成产物。机器路径有独立受理/并发预算；无可执行 checker 的专门部署可显式启用 owner 本地人工入口。缓存、拒绝、科学 FAIL、基础设施失败和迟到结果采用不同回执。[03 Mission/Task](../../architecture/03-mission-task.md)、[04 Services](../../architecture/04-services.md)、[07 Configuration](../../architecture/07-run-configuration.md) |
| [06 Prompt 与工具](06-prompts-and-skills.md)：仓库文件存在、模板合成和真正发送之间有缺口。 | worker 启动校验固定系统文本、四份 skills 和镜像模型目录，真实 Pi 注册 read/write/edit/bash；业务操作通过 `swarm` CLI 和已认证 Bridge。Runner 以当前真实身份和阶段组成消息，发送前复核；工具返回和 compaction 保留生命周期约束。分析器可用原始 Pi 完成事件记录实际返回内容的摘要与序列化字节数；缺少截断元数据则标未知。该边界只证明 Pi 记录了工具返回，不证明随后发送给模型。[01 Agent Core](../../architecture/01-agent-core.md)、[08 Prompts](../../architecture/08-prompts.md) |
| [07/08 验证与迁移](08-architecture-migration.md)：API/schema、实际发送和报告口径不一致，旧入口仍可能影响新实验。 | 正常 CLI/Runner 固定新版合同，拒绝旧并行模式和 `swarm context` 命令组，报告不把现代第一项 Task 解释为根；存储采用增量迁移和固定快照，权限与数据归属沿服务所有者校验。生成 API、存储和 prompt 附录支持按实现抽查。旧数据路径仍需显式隔离，下文逐项说明可达性。[06 Observability](../../architecture/06-observability-experiments.md)、[10 API](../../architecture/10-service-api-reference.md)、[11 Storage](../../architecture/11-storage-reference.md)、[12 Coverage](../../architecture/12-code-coverage.md) |

### 受控实机证据

以下运行均使用本地脚本端点驱动真实 Pi，通过真实 CLI 请求和服务状态核对。脚本的决定事先指定，计量单位是本地 fixture-processing units。没有发真实模型付费请求，也没有把受控轨迹当作自主研究结果。

| 轨迹 | 受控观测 | 证据局限 |
|---|---|---|
| C0–C1 启动、分工与竞争 | `e2-control-1794683288233`，四 Core 发现同一零 Task Mission，各自提议。两个真实 Bot 竞争同一个 Task，一方冲突后可用原 Bot 领另一项。授权令牌跨 Core 请求返回 401，持有本入口令牌返回 200；四个 Execution 重叠运行。`e2-capture-1794685256601` 另验证各路在 take 前经 CLI 浏览公开 Workspace 的 files/read/search、Task、Material，并通过真实 Bash 读取四份固定 skills 全文。take 前写入、chmod、rename、进程观察和访问 worker/管理端口的指定尝试被拒。 | 尚未组合 take 的每个停点和所有对抗性权限尝试。 |
| C2 收尾和运行期依赖 | `e2-dependency-1794683616698`，原 E 提交 `blocked --wait-for` 后收尾，旧 sandbox 返回 404；新 Bot 在依赖满足前经真实 CLI 被拒。前置 Task 到达 DONE 后，同一 Task 可在新 E 执行并完成。两 Task 均 DONE，14 个本 Mission sandbox ID 均返回 404。另一条受控轨迹确认 detached 后代在 finish 前存在、之后资源消失。`e2-capture-1794685256601` 四路均遇到 FIFO 导致保存失败，删除 FIFO 后重新保存成功，再读回并核对后台写入期间固定采集的字节与哈希。该运行四个 E 重叠，11 个 Bot 进入 CLOSED，11 个 sandbox ID 均返回 404；同 ID 的 save 与附件 publish 可重放，无效附件发布被拒。`e2-finish-dependency-1794685844197` 另覆盖公开交付尚未保存、`done` 被拒后正确登记 incomplete、blocked 或 cancelled 的三个分支。 | 未在同一次收尾中注入所有写入停点和 finish 响应丢失。 |
| C3 工作接续 | `e2-control-1794683454869`，前任以 incomplete 正常结束，sandbox 已返回 404，后继在新 sandbox 读取公开 Material 与未合入 R0.2。公开 CLI 执行接续、使用引用、apply 和后续 save/merge；前任未保存私有文件没有进入新项目。 | 网络重放与合入检查变体需要独立故障组合；实机后继证据不证明模型会自行找出前任成果。 |
| C4 主线变化 | `e2-control-1794682956736` 的独立累计合入与同 E apply。`e2-merge-race-1794685302325` 中两个真实 E 在 main 0.1 上并发合入；先到者推进 main，另一个收到 `MAIN_MOVED`。后者在原 E 用新请求 ID 重算合成树，将双方文件并入 main 0.5。受控布局检查拒绝下一份含指定标记文件的合成树，CLI 核对 main revision 和 commit 未变，13/13 sandbox 返回 404。`e2-merge-interface-1794686580337` 的两个组件各自通过检查，合成树的接口校验失败且 main 不变；同一 E 修正后再合入通过，13/13 sandbox 返回 404。`e2-text-conflict-1794686644694` 使用同一初始文本的两份并行改动。第一份进入 main，第二份合入收到真实 Git 冲突；脏目录 apply 被拒，原 E 保存后 apply main，读到冲突标记和双方内容。冲突选项未清除时 `save --resolved` 被拒，修复并移除选项后保存、合入成功；公开读取确认两份修改和另一个已保存文件均在 main，原 E 和初始版本不变。该轨迹使用诊断 sidecar 和已固定的 c8b2b7f guest 镜像，13/13 sandbox 返回 404，`protocol_valid=true`、`invalid=false`。实际 Docker 探针覆盖停写和回滚。 | 合成树布局、接口检查是诊断政策，不能佐证 B1 数学结论；没有在实机安排持续冲突导致的饥饿。 |
| C5 质疑、替代与撤销 | `e2-control-1794683454869`，真实 CLI 完成 dispute、全文替代、查看旧 ID，错误旧版本撤销遭拒，匹配版本撤销成功。`e2-material-meaning-1794686263556` 固定 host `c8b2b7f` 与同 revision 标签的镜像 `sha256:5204f1adada971a8acc3bce5ac9c183f230925448e4adc221dc0946a2927361c`。先用只纠正错误但漏掉有效段落的 M2 替代 M1；经真实 CLI 精确读取两份内容确认遗漏，旧版本撤销被拒，按当前版本撤销后 M1 恢复出现在默认列表。完整 M3 同时保留有效段落并修正旧错，替代后默认列表显示 M3、隐藏 M1，旧 ID 仍可查原内容和当前后继。文件另经 save/merge。17 个 Bot 均为 CLOSED，17 个 sandbox ID 均返回 404；`protocol_valid=true`、`invalid=false`。 | 两份发布内容和纠错动作由本地脚本指定；并行后继和成环拒绝由确定性测试覆盖。 |
| C6 无工作与回收 | 实机观察未绑定 Bot 无工作退出；`e2-recovery-1794682291844` 在实际 provider 响应丢失后经对账找到并确认删除原资源。`e2-soft-fault-1794685131745` 触发真实软收尾，已有 E 仍可 save/publish，新 merge/apply 被拒，硬到期清除实际 sandbox 并阻止定时迟到发布。 | 未在同一运行中耗尽全部选工和研究额度，也未实机保持一项已开始的 merge 越过软收尾边界。 |
| C7 最终验收 | `e2-control-1794682956736` 先累计合入，真实 CLI 提交固定 main 0.9。锁定 B1 checker 返回 FAIL，CLI 可查询；同 E 随后再次合入，证明失败后解冻。`e2-submission-fault-1794685107439` 中，冻结期竞争提交返回 `CONFLICT`，迟到 merge 返回 `MISSION_SUBMITTING`，真实锁定检查器在 12 秒预算内进入 `timed_out`（`SERVICE_TIMEOUT`），随后原 E 可合入并推进到 0.5。`e2-functional-final-1794686525534` 固定一条 Material 和两个不同的 Git tree，功能诊断首次检查 FAIL，原 E 修正后 PASS，Mission 持久接受并正常收尾，`protocol_valid=true`，7/7 sandbox 返回 404。此差异揭示了一次 C7 清理误报，修复将已结束的启动拒绝和实际资源待清理区分。 | 功能诊断使用事先设定的交付和检查，B1 仍未达到最终验收。新旧检查结果跨冻结重叠及含并发 Material 的提交组合仍以 E1 证据为主。超时探针确实停止检查器，没有制造迟到 PASS。 |

### V01–V32 对照摘要

| 条目 | 已查证机制及尚未覆盖的实机情形 |
|---|---|
| V01–V03 | E1/D/P 覆盖零 Task 发现、项目保护、作用域凭据和网络隔离；P 覆盖各路真实公开发现、指定的 take 前目录与网络拒绝，以及跨 Core 令牌拒绝。未触发所有权限入口组合。 |
| V04–V08 | P 覆盖竞争胜者、同 ID 重放、二次 take 拒绝和正常 prepare/grant。`e2-take-fault-1794685439288` 在真实 guest 中确认准备及授权前项目只读，首次 take HTTP 请求中断后用原 ID 经真实 CLI 取回唯一 E 回执，另一 Bot 在迟到 grant 前已物理停止且 grant 被拒。11 个 Bot 均到 CLOSED，11 个 sandbox ID 均返回 404。准备失败、接管中重启和绑定后应答前的精确停点仍由 E1 覆盖；R 是另一类 provider 响应丢失。 |
| V09–V13 | P 覆盖实际 save、publish、Judge、finish、物理销毁和新身份接续；E1/D 覆盖来源拒绝、收尾失败和全 UID 后代终止。V11 实机覆盖 FIFO 导致公开交付保存失败、拒绝 done，以及 incomplete、blocked 和 cancelled 三种收尾。V12 的 `e2-finish-crash-1794686074925600601` 在实际 finish 持久接受且 provider DELETE204 应答被拦截后终止协调器；重启对账得到 E SUCCEEDED、Task DONE、Bot CLOSED，原请求可由可信 Task 服务重放，7/7 sandbox 返回 404。V13 的 `e2-long-history-1794686351426` 保留一次已受理的真实 Lean 检查，旧 E 结束后新 Bot 查询同一持久 ID 得到 PASS，检查实际执行一次。 |
| V14–V18 | P 覆盖新 sandbox 的 M/R 接续、纠错及顺序合入。V15 实机验证遗漏内容的错误替代、撤销恢复和完整替代后的默认隐藏与历史读取。V16/V17 实机验明同基线 CAS、原 E 重试合成双方内容，以及受控合成树 FAIL 后 main 不变。E1/D 另覆盖默认查询、旧 PASS 拒绝与隔离；未逐一实机触发跨 E 私读路径。 |
| V19–V22 | V19 的选择预算、无工作退出和停止有 E1/P；真实上游 compaction 未观察。V20 由 D/P 验证真实 Pi 四工具、固定资源和实际调用；E1/D 为 V21–V22 注入 capture/install 错误和并发写者，P 观察真实 save/apply，V21 另实机触发不安全的 FIFO 快照失败、清理后重新保存以及后台写者的固定采集对账；V22 验证同 E 处理真实 Git 文本冲突、显式解决并合入。未逐个注入所有捕获或安装停点。P 从实际 Pi 事件观察 Bash 返回四份 skills，该类工具事实不证明后续模型请求送达。 |
| V23–V26 | P 验证运行期依赖、旧 Sandbox 删除、新 Bot 认领和纠错 CAS；无工作退出已触发。V23 实机保持旧 E 为 CLOSING 直到前置 DONE，结束时重算为 OPEN；另有取消前置后仍阻塞、拒绝反向等待环、授权替换后新 E 再认领并交付，14/14 sandbox 返回 404。V25 由实际软收尾和硬停止诊断验证已授权交付及禁用扩展；已开始的 merge 跨软边界失权，以及全部预算同时耗尽主要由 E1 覆盖。 |
| V27–V29 | P 验证固定 Git tree 最终 FAIL、独立功能诊断中的 FAIL 后修复与接受、冻结期竞争提交和合入拒绝、真实检查超时和解冻，R 验证 provider 恢复。E1 验证迟到结果栅栏和多个 Git 持久化停点。V29 的 `e2-git-crash-1794685929761411091` 在 main ref 写入后、版本元数据和回执写入前终止协调器；重启后首次公开读取恢复 0.3，同一 ID 重放与公开文件字节一致，7/7 sandbox 返回 404。其他 Git 崩溃点仍由 E1 覆盖。 |
| V30–V32 | E1 验证有界检索、大量历史、普通文件删除与历史保留。V30/V32 的 `e2-long-history-1794686351426` 累计 505 项，真实 CLI 读取两页各 10 条，共读 20 项，保留继续游标，另外 485 项未读。普通文件删除后，0.2 仍能读取原文件，0.3 保留版本但请求该文件会被拒；Mission 关闭后历史仍保留。P 多次推进 main。历史堆积下自主选工与持续冲突导致的饥饿未验证。 |

## Analysis

### 原偏差为何出现

旧运行器把旧层级任务实现的便利机制当成了协作模型。第一份提案被提升为共享根；选工围绕它或由兼容路径替 Bot 选择；报告继续以根任务统计分解。即使 Sandbox、Judge、Task API 都正常，真正执行的仍不是四个并行 Bot 各自发现可独立完成的工作。旧的 session 恢复和私有目录接续又让“下一 Bot 通过公开信息理解进展”缺少可观察边界。把 `goal` 批量改名并不能改变这些调度与状态转换。

现在的源头是一个 Mission 的公开事实和四条可并行的发现循环。需要辨别三层证据。提议与 take 说明 Bot 能控制选工；不同 Bot 的重叠 E 说明授权和执行可以并行；只有自主运行时的行为及可复核交付，才能说明模型在既有积压、重复研究或冲突下作了有价值的选择。历史正式报告和脚本轨迹都无法单独替代第三层。

### 旧术语、路径与数据

| 术语或机制 | 本版边界 |
|---|---|
| `Mission` 与 `goal` | Mission 是研究边界；`Mission.goal`、Task 的目标或稳定责任描述中的 `goal` 是合法字段或自然语义。Task/Execution/Mission 身份与目标文本独立。 |
| `root`、`parent`、`spawned_from`、旧分支状态 | 现行注册 Bot 的提议、领取、统计和公开详情不依赖旧层级名词；新现代提议不接受 `spawned_from`。正常 Runner/CLI 拒绝旧并行模式，报告导入只对历史格式读取旧根任务，现代报告不合成根。历史 SQL 列、兼容 helper 或测试路径仍可读取旧记录。 |
| Material 的 `kind`、`role`、`evidence_state`、结构化 Evidence | 现代公开材料合同使用自由正文和固定来源、版本、哈希及附件。保留历史字段以回放旧记录。Context 是服务组件名；其现代 CLI 入口是 `swarm material`，旧 `swarm context` 明确拒绝。程序角色、认证 role 和 Evidence 作为普通文字概念仍合法。 |
| Candidate、私有 Workspace、Session resume | 公开候选是普通文件和 Git revision；不通过 Candidate 对象或 discard 命令管理。历史或显式兼容调用仍可能见相应表示。注册 Bot 的跨 E 接续走公开状态，旧 Session、私有草稿和绑定凭据不迁移给后继。 |
| `solved`、`PASS`、`protocol_valid` | 运行协议、局部源码诊断、Task 完成和 Mission 最终接受分别记录。PASS 属于给定检查及输入；只有持久 Mission 接受能建立当前正式路径的 solved。活动量只说明发生了操作。 |

术语清理的验收对象是正式 CLI、Bot 可见 catalog、实际 prompt、公开 DTO 和报告主字段。同时检查仍可达的兼容入口是否有清楚的调用方和权限。历史记录、安全审计及不同领域的合法同名字段保留各自语义。完整边界见 [架构手册](../../architecture/INDEX.md) 与 [术语表](../../../GLOSSARY.md)。

### 仍需保留的限制

- 正常正式部署是同一协调器内的 Task、Context、Judge 权威组合。独立 Hosted Service 无法证明跨进程同等授权/提交顺序的路径拒绝写入。外部计费领域服务还没有经过可信费用契约支持，正式门槛保持关闭。
- Bot 资源清理用实际 provider 对账。未知 checker 尾部资源仍占持久额度，进程重启不自动算已清理。此取舍容许容量不足时安全拒绝新检查。实际资源恢复探针只覆盖所列丢包形态。
- Files/Material 的分页有固定边界和继续游标。Task 可用状态是页请求时的实时状态。输出范围、观测时间和作者自述消费都不能等同于完整历史或科学复用。
- 30 分钟单项目已获授权，沿用 formal24 的 `gpt_proxy` / `gpt-6.1-sol`。生产请求费用上界和本次总额仍待确认；诊断中的 fixture-processing units 不能用来计算生产费用。
- [已知边界](../../architecture/09-known-boundaries.md) 区分当前入口、可执行兼容路径和历史读入。固定提交由同一轮检查核对章节正文与生成引用。

## Next steps

1. 固定实现的 Spec 和 Standards 复审通过。全量测试 560 通过、9 跳过、0 失败，生成文档和变更检查均通过。受控证据命中范围和未触发的组合按 Issue 记录。合并与遗留问题由 Issue/PR 审核决定。
2. 已授权的下一次正式实验保持 `putnam_2025_b1`、四 Core、单项目、`gpt_proxy/gpt-6.1-sol`；准备的总时限为 1,800,000 ms，每 Bot 最长 600,000 ms，选工最长 120,000 ms，Execution 最长 600,000 ms，均受剩余 Mission 时间约束。该正式实验尚未启动。在运行前，落实已选上游的实际费用上界和本次总额，锁定代码、镜像、fixture、checker、工具/提示版本，并确认配额、清理和四路发现证据。设定各 Bot 的有限生命周期时，保持 Mission 总时限独立。
3. 正式实验按 Issue 的验收条件观察四个 Core 各自看到的初始状态、真实提案及其选工理由、并行重叠、对已积压任务的选择、通过公开产物接续的后续动作，以及固定最终提交的检查和资源正常收尾。逐项报告观测结果和未观察到的情形；若出现新偏差，链接具体事证并在 Issue 或后续 PR 修复。

未逐一在 provider 注入的额外故障变体由 [Issue #125](https://github.com/LuNa-shi/SwarmEnv/issues/125) 跟踪。该验证后续项不把已有 E1 证据降格为已发现的源码缺陷，也不改变当前已批准的设计与实验资源范围。
