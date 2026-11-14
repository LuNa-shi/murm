# Issue #122：完整设计与实现一致性审计

> 审计附件，非新增设计或独立进度账本。需求与批准仍由 [Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) 管理，修复与验收记录在 [PR #124](https://github.com/LuNa-shi/SwarmEnv/pull/124)。本页记录固定代码树的缺口，不将未实现的目标改写为现行能力。

## Results

**当前实现没有完成阶段 02 的模型迁移。四个 Core 的调度循环已经启动，但没有形成设计要求的四路自主发现与分工；旧的 Core 身份、短名单领取、整题 Task、私有 Workspace 与隐式交接仍影响正式路径。问题不能归因于模型不愿提案，也不能靠把 `goal` 全部改成 `mission` 解决。**

用户已明确按现有文档执行：有合适的已有责任时优先解决；发现可独立推进的缺口时允许提出并领取新 Task。所有 Core 都应具备发现、提案、竞争、执行和退出的完整能力。不增加“每次领取前必须创建自己的 Task”的新限制，不绑定 Creator 与 Owner，也不通过允许多人执行同一个 Task 来制造并行。

### 固定对象与证据边界

| 项目 | 对照版本与结论 |
|---|---|
| 批准设计 | Issue #122 固定文档修订 `0541ae6e42cbe41ff41ed499c257a57340b83b09`；覆盖 README 与 01–08 全部章节。当前目录相对此修订仅 07/08 的实现基线引用有变化，合同正文没有变化。 |
| 实现 | PR #124 的 `36b0cf39853b37c73b8f099063d7e0d63a989b79`，相对 main `1d9be9f8146a57ba50d769615045c21a03c215bd`；同时审计未修改但仍可达的旧代码。下文源码行号均指该树。 |
| 已有真实运行 | `issue122-formal24`，代码 `7c5836fefa7124a8386150ea408068c9a6010b6b`。后续至本审计基线的改动是文档，不构成新 runtime 验证。详见[逐 Bot 实验分析](../../experiments/issue122-formal24-gap-analysis.md)。 |
| 本次验证 | E0：设计、Issue、公开能力、真实调用链、存储与文档核对；E1 局部诊断：临时目录、内存数据库、合成文件的无模型探针。没有新 sandbox 或付费实验。 |
| 证据用语 | “源码确认”不等于实机复现；“本地复现”只覆盖所述组件入口；“待 E2/E3”表示真实环境/自主行为未验收，不作通过或失败推断。优先级 P0/P1/P2 表示本审计的阻断程度，不改 Issue 标签或预算。 |

已有能力应保留：零 Task 初始化；Task 创建与排他领取基础；Material 正文持久化和生产 Task/E；公开初始 Workspace 的读取；部分 finish 结果与 fencing；真实 sandbox、文件写入与 Judge 调用。它们是迁移基础，不能证明完整合同成立。`protocol_valid=true` 与若干故障计数为 0 只对应运行器已有的检查，未验证的设计情景不会自动变成通过。

### 为什么“一项 Task 串行”属于实现偏差

1. `src/benchmark/putnam-runner.js:2627–2628` 仅允许 Core 1 在空队列时发现，并给出整题证明的 Goal、Deliverable、Completion condition。
2. `src/runtime/identity-task-loop.js:293–314` 在无候选且无 bootstrap 资格时 idle；其他 Core 因而不能从同一个零 Task 起点独立读项目、提出局部工作。
3. 普通发现文本在 `putnam-runner.js:670–677` 要求从所列 Task 中 take；`identity-task-loop.js:363–365` 又限制新提案进入领取候选。它把“优先已有合适工作”收窄为“围绕运行器短名单竞争”。
4. 唯一 Task 覆盖整个 Mission，同一 Task 排他执行本身正确。因此竞争者等待，incomplete 后再争同一项，形成串行。这次权威库确实只有 1 项 Task、39 次不重叠 Execution，不能用四个循环或四路模型请求计数代替工作并行。
5. 实际 SOP 仍把 Propose 放在 Work/Check/Share 之后，并夹有专门整合与 checkpoint 指引；它没有落实完整的任务发现流程。有关正文见下文 Prompt 专项。

这里不是要求四个 Bot 永远满载：必要依赖、没有适合的工作和预算结束都允许等待或退出。需要先证明四路都能自主发现，并在设计的 C0/C1 可分工场景中实际推进不同 Task，再研究某个难题是否值得怎样拆分。不能从这次受限运行推断“自主分工策略本身无效”。

### 全章覆盖地图

| 设计章节 | 本页核对范围 | 结论与剩余边界 |
|---|---|---|
| README | 对象、稳定合同、文件化 Candidate、生命周期、共享与验收 | 下列 Runtime、Material、Workspace、Mission 专项；保留 Task 内的 Goal，清理旧顶层行为。 |
| 01 Runtime | 对象/权威、启动、无 E 退出、take、普通调用、finish、超时、提交、停止与费用 | Runtime 矩阵与 Mission 专项；收费服务全种类的尾部成本、重启、真实隔离待验证。 |
| 02 Sandbox | 拓扑、创建、固定路径、权限与凭据、基础工具、网络、公开/私有数据、故障对账及运维 | Runtime/Prompt 矩阵；实际 UID、管理面不可达、后台进程销毁、资源限额不能由源码证明。 |
| 03 Task | 稳定责任、输入、列表、排他、动态依赖、取消替换、提案、四种结束、交付与最终验收 | Runtime 矩阵；不是有 create/take/finish 三个名字便完成。合同允许的负结果交付及多类验收组合仍需公开接口验证。 |
| 04 Material | 正文/Evidence、来源/用途、发布、检索、接续、纠错、并发、影响追踪及权限 | Material M1–M6；附件完整性、实际使用价值、跨服务撤权需进一步验证。 |
| 05 Workspace | Git/revision、初始化/浏览、输入、save/apply、整版 merge、冻结、崩溃一致性和 CLI | Workspace W1–W7；多个组件反例已本地复现。完整安全导出仍需 provider 验证。 |
| 06 Prompt/skills | 规范分层、动态消息、take/错误/通知、完整 CLI、四 skills、实际发送与版本记录 | Standards/入口专项；正式路径关闭基础工具和 skills，不能靠模板存在判定已迁移。 |
| 07 Validation | 工程/研究分层、V01–V32、C0–C7、指标、成本、复现与完成判据 | 末尾完整验收映射；formal24 不足以验证 H1–H4。本审计不重新做文献优先权评估或引入研究假设。 |
| 08 Migration | 模块权威、切片、schema/旧运行、默认入口、全部代码/手册、UI/证据、关账 | 退役清单、Standards 与观测专项；历史兼容应只读且有边界，不能留在新 Mission 写路径中。 |

## Analysis

### 1. Runtime、Sandbox 与 Task：Spec 审计

下表的 01/02/03 指本目录设计章节，`runtime.js` 位于 `src/runtime/`，`task-service.js` 位于 `src/task/`，`putnam-runner.js` 位于 `src/benchmark/`；其他文件给出相对路径。每条均包含要求、实际入口与修复验收。设计允许的自主选择边界已按用户确认保留。

| 优先级 / 范围、证据 | 批准文字 / 行 | 实际可达入口与差异 | 影响与建议验收 |
|---|---|---|---|
| P0 四 Core 同时自主发现，源码确认 | #122 User Story 3「零 Task 启动四个 Bot 后，可观察自主阅读、提案、竞争和并行推进」；01:71–86「每个 Core 创建新 Bot ID、sandbox 和 Pi」 | `putnam-runner.js:2781` 确实启动多个 controller loop，但 `:2625–2628` 把 `allowEmptyDiscovery` 仅授 Core 1，`identity-task-loop.js:293–314` 无候选且无一次性 bootstrap 时直接 idle，直到 `putnam-runner.js:650–656` 才懒建 Session。非 bootstrap 的 Prompt `:670–677` 命令只能从候选中 take，`identity-task-loop.js:363–365` 只许 bootstrap 纳入新提议。bootstrap 还复发固定提案指令（`:684–698`），模板由 harness 固定为整道证明，强制跨 Task Material 消费和 final candidate（`:2628`）。 | 四调度循环启动无法提供四个零 Task 发现 Bot 的证据；工作划分由模板和队列主导。固定同一 Mission 零 Task 障碍测试四个独立 Bot 均开始发现，并用真实轨迹检验读取、独立提案、take 竞争、不同 E 重叠、无人可做时退出。启动四路不要求同一毫秒；重叠只以 provider/Bot 时间戳建立。 |
| 已确认边界 自主提案和接续 | 01:78「先考虑已有责任，再提出并 take 新责任」，03:126–133「优先接续已有合适责任」，README:45–46 允许无任务退出；用户本轮确认按设计规则执行 | 每个发现 Bot 可按真实需要提案及领取，也可接续合适现有 Task 或正常退出；无需每个 Bot 强制创建新 Task。当前 harness 把自主发现压缩为 Core 1 固定提出整题、后继从短名单领取。 | 用真实模型验证合理接手已有工作、针对独立缺口自主提出可交付的 Task、重叠并行以及无工作退出。测试不能以唯一整题 Task 和多 Bot 串行轮转代替。 |
| P0 真实 take 竞争异常，源码确认 | #122 Story 7；01:106–145 有界处理 take 竞争 | `src/runtime/identity-task-loop.js:335–354` 明确收到 bridge 的 `take_failed` 且分类为 conflict 时，事件构造读取 `take.error`；该处只定义 `takeError`，后面的 `take` 尚未初始化。该异常先于 rescan。 | 用两 Bot 同时 take 同一个 Task，真实失败结果触发该分支，要求失败者无 E、进程无 ReferenceError、可重新发现；另测 provider 故障走有界退避而非竞争重扫。 |
| P0 Bot 身份、Sandbox 与 take 授权顺序，源码确认 | 01:73–78、88–145；02:42–84「固定 /workspace/project」「E active 后授予写权限」「绑定后才返回」 | `putnam-runner.js:500–520,1844,1916` 以长期 `agent:core-N` 表示身份，选择进程用合成 `worker-…-session-N` 作为 provider execution key；`:1953,1977–1985` 把当前 worker Session 传给 Runtime，代码注释 `:2075–2082` 描述替代会话，但实际仅在引用不同才停旧会话。Runtime 随后 `:675,524–530` 用真实 E ID 建立/ensure sandbox，而模型 worker 仍以合成 ID 启动。Bridge `services-bridge.js:203–216` 先发布进程内绑定，再执行 onTake；`runtime.js:629–675` 把 host workspace 准备好；正式路径继续使用已经启动的同一 Pi，置 RUNNING 后按真实 E key ensure 执行 Sandbox（工具调用也使用该 E key，`runtime.js:494–507`）。OpenSandbox adapter `opensandbox-agent-adapter.js:218–256` 以 `/workspace` 启动，将传入 cwd 内容同步到 provider，未走原 Bot sandbox 的固定受保护 project→物化校验→active→grant。Worker `scripts/opensandbox-agent-worker.mjs:95–122` 接受 /workspace 下 cwd 并 spawn，未看到 worker 在此链路实施 E grant。TaskService `task-service.js:2300–2313` 仅阻止 owner 有当前 active E；不是一生最多一次 take。 | 同一模型 Session 与 Runtime 执行工具的 provider 资源用不同 key 管理，Core actor 无法代表单次 Bot 生命周期。验收实机用持久 Bot ID 对齐 sandbox ID、Pi session、E、凭据/fence，take 前用非 root 检测拒写、take 后同进程读写固定路径，模拟 active/grant/绑定之间失败及迟到响应。真实 Sandbox OS 模式、安全属性需 E2 补测。 |
| P0 finish 和超时清理次序，源码确认 | 01:160–174 / 02:96–114 / 03:48–60「确认停止/隔离后才释放 owner/Core」 | `services-bridge.js:596–608` 先将 finish 提交，才调用 Runtime 物理清理。TaskService `:1787–1850`、`:1351–1361`、`:2239–2263`、`:2576` 先做 terminal 或 Task 更新；`runtime.js:1330–1379` 上报 Core IDLE 后调用 Provider，`:533–548` 甚至先回拷本地文件、记录但吞 Provider stop 错误。OpenSandbox manager `:590–600` 保留失败映射并抛错，Runtime 没用这个失败阻止解绑。 | 在尚未确认停止/隔离时，Task 已可能再次可领；旧子进程是否仍活跃本次没有实机复现。正式配置会尝试停止 Pi（`putnam-runner.js:1772–1773`、`runtime.js:1927–1935`），不能据此推断 formal24 复用了旧会话。用延迟/丢失 DELETE 和后台进程探针验证 E closing 仍占 owner/Core、贡献即停、旧进程可证隔离才释放，且不能默默回拷未保存文件。比较 finish/stop/expire/shutdown。 |
| P0 版本化输入真实性，源码确认 | 01:106–145；02:42–44,74–78；03:32–38「固定公开 base；无指定取当时 main；完整文件树与明确 Material 版本」 | `task-service.js:2327–2353` 输入 Material 可被 take payload 替换且只检查数组；输入 hash 是合同与引用哈希。`runtime.js:1542–1581` host manifest 使用该 hash；`:1584–1603` 只读取 Workspace `main` 的 `problem_file`，没有物化完整 revision，也忽略 Task base 和返回的实际 Git commit。Benchmark 引用的开工 `workspace_revision_start` 来自 bound 私有 Workspace（`:2056–2066`）。 | Workspace 多文件和未合入公开成果无法按被选版本完整接力，且输入审计会混用内部 revision。用不同 base、多文件、main 并发更新和 Material 版本校验同一次 E 的不可变输入清单；同 E apply 后核对记录不覆盖初始信息。 |
| P0 窄依赖动态语义不闭合，源码确认 | 03:64–105、209–216「创建/运行同一无环规则」「取消前置拒绝」「已完成前置即时重算」 | Task 初始 `depends_on` 用 `task_relations`（`task-service.js:1012–1039,1073–1083,1154–1157`）；公开 finish blocked 校验该图但通过 `:1802–1832,2195` 写旧 `#insertDependency`，旧构环只遍历旧表（`:2046–2054`），最后无条件写 BLOCKED（`:2262–2263`）。取消 prerequisite 不在公开 finish 检查（`:1820–1825`）。旧内部 `#blockTaskOperation` 邻近分支同步写 modern relation（`:1533–1551`）；公开 finish 未经过它。 | 混合图 `A 初始 depends B；B 动态等 C；C 动态等 A` 中，现代图缺 B→C，旧图缺 A→B，分别检查会漏掉整体环；已 done 的等待不保证安全解绑时即时 ready。测混合环、多个 wait_for、已 done/cancelled、失败重领、响应丢失与重复请求，验证事务中的版本和统一关系历史。 |
| P0 取消 / 替换接口，源码确认 | 03:87–120；#122 合同 3「无 owner Task 的取消和已取消前置的替换」 | `task-service.js:1764–1782` dispatch 缺 cancel 与 dependency replace；源码没有对应公开 capability。公开 finish cancelled `:1834–1851` 拒绝已 DONE/CLOSED 的 replacement，规则仅要求 non-cancelled；允许缺 reason 用默认，并只写 handoff metadata，无替代链检查。 | 下游不能通过批准的受限协调修复。验收当前 owner、跨 Mission、未绑定授权、其他 Bot running、无 owner 协调 cancel、replacement 环、done replacement、旧关系历史与并发 CAS。 |
| P1 Task 可发现性、提案字段、旧机制，源码确认 | 03:13–46,124–149「不增加 spawned_from」「显式分页和截断」「无固定角色」 | `task-service.js:1065–1072,1154–1164` 仍支持 `spawned_from` 并把创建标记 ROOT/CHILD；`:1173–1207` 返回截断数组，无 cursor/hasMore，detail 聚合缺完整 E/finish 历史；`putnam-runner.js:621–639,670–677` 向模型把有限 shortlist 标为 complete candidate set，仍有 parent/type/priority；`:2285` 第一提案登记为实验 root。`task-service.js:1026–1028` 仍把 CLOSED 与 DONE 都当依赖满足。 | 旧树类型仍通过实际路径进入，操作员的「未读范围」不可复核。测 >500 项分页、旧库读取兼容与新写拒绝（必要时保留迁移而不把旧字段暴露给 Bot）、真实发送记录复查。 |
| P1 Mission 与 Goal 的边界，源码确认 | #122 合同 3；README:13–14,47；03:15–26「Goal」为稳定的局部责任 | `task-service.js:975` Mission 表使用 `goal`，`:1110` Task 也使用 `goal`；`putnam-runner.js:2628` 首个 Task goal 与整个 Mission 同义从而把两个级别在行为上重叠。 | 明确哪些 Goal 是旧顶层对象、哪些是当前 Task 字段、哪些是自然语言或兼容字段。删顶层旧概念和全题模板，核对公开 CLI、prompt、报告和 API 的具体字样；若要改 Task 字段名，与 Issue 合同同步。 |
| P0 无 E 主动退出与可计费等待、软收尾/总预算，部分源码确认 | 01:80–104,170–174,222–229；02:98,110–139「no-work/selection-budget」「有限 Mission/单 Bot/选工/最终验收及收尾，已发生+已承诺」 | `agent-prompt.js:14` 指示 bot exit，但 capability/dispatch 无该操作；`identity-task-loop.js:270–300` 只记 loop idle；`putnam-runner.js:680–706,2599–2606` 是模型调用/队列/总墙钟 timeout，不等于按 Bot/Mission 持久余额或已承诺并发费用。API 尚无统一的 soft window 操作限制证明，`runtime.js:510–521` 只检查活跃执行/closing。 | 未证实无 E 可持久退出、费用尾部或剩余额度，新计算可绕常规限制的具体路径要实测。验证选工到期的 bot exit、未知 take 后禁止 exit、空闲唤醒与有界退避、软阶段保存/禁止新计算及 merge、费用并发、继承环境凭据与 hard-stop。 |
| P0 同 E 重启、compaction 与非持久恢复，源码确认 | README:24,46,71；01:158–174；02:108–114「后继读取公开状态」「一 Bot 对应零或一个 E」 | `runtime.js:705–713` 存在同一 E 重启会话；`:1525–1567` 非 fresh 可 restore 私有工作目录或 clone resume；`putnam-runner.js:536–586,1808` 实际安装恢复会话回调。公开 take 确实拒绝 `workspace_mode=resume`（`task-service.js:2329–2335`），不可据此说所有旧内部恢复均清理。重启 `runtime.js:1482–1496` 只从进程内 Session 集与 active E 开始；OpenSandbox 资源映射/对账也需跨宿主真实验证（`opensandbox-manager.js:241–271,590–600`）。 | 模型上下文死亡应结束本 Bot，再从外部已持久成果接续。分别测试 provider crash、runtime 真进程死后重启、compaction、不可取消晚回调、残留 sandbox/凭据和硬停止时文件不可见。 |
| 正向基线和未验证范围 | 03:17–30,131、#122 合同 1–3 | 现有代码有零 Task 初始化（`putnam-runner.js:1688–1708`）、创建来源 actor/E（`task-service.js:1048–1060,1159–1169`）、版本检查/幂等 take（`task-service.js:2287–2297`）、已占 owner 与 Core 守卫（`:2300–2323`）、四 finish 术语（`:1787–1853`）；不能由此推定闭环。 | 本次无新 sandbox、无付费运行。02:141–213 的 OS 身份、网络隔离、完整凭据脱敏、资源限制、后台进程和受理请求对账需 E2 保障；并行自主行为及其成本需 E3，科研收益 E4。 |
| P1 生命周期凭据和恢复资源，源码确认 / provider 未验证 | 02:42–54,126–139,186–212；01:88–100 「受限 Mission 协调身份」「E 绑定」「create 响应未知按同一标识找回」 | `services-bridge.js:283,408–419` 使用 bridge 实例 token，`putnam-runner.js:1924–1934` 每 Core 初始化该 bridge，`opensandbox-agent-adapter.js:227–235` 将其交给 worker；`services-bridge.js:203–216,349–356` 改绑定时未生成新凭据。OpenSandbox `opensandbox-manager.js:273–328` 仅在进程内 map 命中时复用；create 结果未知时 map 仍未落，health wait 失败则先删 map 再发 DELETE，即使清理失败不留该记录。 | 需要验证旧 Bot 的凭据即使仍持有也不能附着下一 Bot；此审计未进行跨 sandbox 凭据试验。用 fault stub 做 create 已完成响应丢失和 DELETE 未知，再以固定 provider 复测按 Bot/sandbox 持久记录对账。 |
| P1 Sandbox 工具入口 / 文件效验，源码确认 | 02:10–16,70–93,141–151「Pi read/write/edit/bash 与 swarm CLI」 | `opensandbox-agent-adapter.js:209–212` 明确禁用 Pi 内建工具并不加载 skills；`swarmenv-extension.mjs:65–89,98–106` 仍将各服务逐个注册为裸模型工具。OpenSandbox `opensandbox-manager.js:467–491` 同步路径是 /workspace，跳过类型/文件清单子集，用字节计数，没有上传后验摘要。 | 模型实际只能通过旧 Bridge 工具面编排，不能作为所批准 CLI 工作流已迁移的证明。用固定镜像检测四基础工具同路径、真实 Bash CLI 指令、公开文件集/摘要校验以及 skills 的实际可用性。 |
| P0 Mission 真实最终验收与停止，源码确认 | 01:176–228；03:170–205；#122 合同 7、9、10 | Benchmark 的 `putnam-runner.js:2940–2969` 在 stopCore 和报告生成后，以 operator 把所有含历史 Material 自动塞进 submission，然后用 report.run.solved 推断 PASS，不针对冻结 main 重新 Judge。Coordinator `mission-submission.js:18–40` 有本地 store、单 pending 和基础 freeze/unfreeze，但接受调用者传来的 revision、checker/env 与未校验的 Material ID，没有 commit/内容版本、deadline/费用、可执行 checker 调度和 finish 时复核当前快照。原请求重放冲突、JSON 直接写入、freeze/写入跨事务是独立缺口。TaskService `task-service.js:2281–2300` 的领取守卫没有查询 Mission submission 状态。 | 首先实现未绑定 Bot 的真实 submission、显式材料版本、冻结条件边界与固定输入检查；制造 finish/exit/merge 与 submit 竞争、同 request 重试、进程中止重启、迟到 PASS 和 checker 故障；检查 PASS 只接受对应 revision，不重写未完成 Task，允许有限收尾后按原因停止。 |


### 2. Material：来源、自由文本 Evidence 与纠错闭环

对照 [04 Material](04-material.md) 全章。源码主入口为 `src/context/context-service.js`，schema 为 `src/storage/context-schema.js`。以下均为源码确认，M4 另有本地组件反例。

| 缺口 | 设计与实际差异 | 后果与验收要求 |
|---|---|---|
| M1 · P1 · 旧角色与证据模型仍是写约束 | 04 §1 要求用途放在关联、Evidence 是可选正文自由文本；service:7–10,322–340 与 schema:12–18 仍保留固定 kind、永久 role、全局 evidence_state，并验证结构化 evidence 数组。生产来源有 Task/E，但没有独立持久 Bot ID。:385–387 会把普通 actor 请求的 checked/accepted 降为 proposed；本条不指普通 Bot 可直接自封 accepted。Task 关联还受旧 role 合同约束。 | 这不是保留旧列供历史查看：新发布仍校验这些字段。正文中的自由文本本来可存，问题是仍有另一套角色/可信度模型支配公开接口与提示。验收同一材料在不同 Task 作不同用途、无 Evidence 与自然语言 Evidence、不可伪造生产身份，不强迫新增结构化证明 schema。 |
| M2 · P0 · Mission 读取范围未在 Context 合同内闭合 | 04 §2.3 要求按 ID 读也校验 Mission。service:131–139,175–176 的 get/read 不从身份推导 Mission，搜索的 Mission 是可选调用参数；:478–486 的 supersede 仅检查两个 ID 存在，consume:298–307 也主要检查存在。 | 部署入口可能另有限制；本次未证明能从真实 Bot 跨 Mission 越权，但服务自身缺少合同所需校验。用独立服务和不同 Mission 的真实身份测试 search/get/consume/dispute/supersede，以及未绑定阅读身份，不能只测 Bridge 的正常同项目流。 |
| M3 · P0 · 当前有效 Execution 与服务独立性不充分 | service:508–519 的 fence 检查比对 task/spec/state/fencing 版本，没有单独验证 active；未传 taskService 或 E=null 时提前返回。发布允许该例外，初始化身份与普通 Bot 必须由入口区分。Context 直接调用 TaskService 对象读取事实，formal runner 的共享对象路径不能证明独立服务的一致撤权。 | 不能仅在 Tool 层限制后宣称直接服务入口安全。验收初始化身份、未绑定普通 Bot、active/closing/closed E、旧 token、新 token、撤权期间请求与重放；从权威 Task 服务取得有效性，明示已受理请求边界。 |
| M4 · P0 · 替代图允许多后继及环，撤销规则又过窄 | 04 §4.2 要求单有效后继、无环、观察版本 CAS。service:425–447 只复用同一 old/new/kind 活动关系；:478–486 无图环、同 Mission、单后继和 expected version 校验。发布时的 `payload.supersedes`（:377–387,419–421）也是直接建关系的活动入口，应一并验收。:489–507 的 unsupersede 只允许原 E 或 trusted actor，而设计允许同 Mission 的其他有效 E；expected version 缺失时默认当前值，未强制观察版本。 | 本地 Context fixture 接受 a→b、a→c、b→a 三条同时 active。该探针验证关系不变量，不证明研究 Bot 的越权路径。修复需在同一事务中校验范围、唯一后继、DAG、请求与观察版本，并验证不同 Bot 纠正错误关系且保留争议/历史。 |
| M5 · P1 · 检索、正文关系提示和影响追踪不足 | service:231–282 是可选字段过滤、SQL LIKE 和创建时间排序，返回数组，缺明确 cursor/hasMore/相关性及未覆盖范围。get 返回材料行，没有附加当前 dispute/supersede 观察快照；另有 relations API 不等于默认精确读取有提示。消费记录可追加，但 action_ref 可空，不能解释实际影响。 | 已实现 supersede 默认隐藏旧条目，应保留；还需让精确读取看见更正、查询范围与已读版本可核对。按设计用查询加 Bot 审查追踪直接影响，不新建全自动知识真值系统，也不能把 consume 次数算研究收益。 |
| M6 · P1 · 自动生产归属与第二次 attach 并存 | publish 自动记录 source_task/source_execution 是正确基础；但 `agent-prompt.js:186–201` 仍引导 publish 后 attach，`ContextService:350–366` 保留 root_integration 和硬性消费规则，runner:2628 给整题 Task 强制跨 Task 材料消费。formal24 只有一个 Task，跨 E 引用不能满足跨 Task 条件。 | 清理双阶段生产交付和根整合特例；一次 publish 的生产关系可查询且重放安全，使用关系只记录实际使用。附件须真实可读并在 sandbox 删除后仍可取；只提供 content_ref 或旧路径不能通过持久性验收。 |

M1–M6 不要求自动判断新版是否保留了所有有效知识。04 §4.1 的完整新版与 §4.4 的下游复核仍是 Bot 责任，但接口必须让它读到正文、版本、争议和实际文件。

### 3. Workspace：公开文件版本仍未成为唯一接续路径

对照 [05 Workspace](05-workspace.md) 全章。`src/runtime/mission-workspace.js` 是新公开仓库实现；`WorkspaceManager` 和 per-Core Runtime 仍管理另一套 Execution 本地版本。formal24 中实际本地写入、checkpoint 与检查，不能替代公共 save/apply/merge 的证据。

| 缺口 | 设计与实际差异 | 后果与验收要求 |
|---|---|---|
| W1 · P0 · 公开写接口参数不匹配 | `src/sdk/service-catalog.js:268–283` 公开 snake_case，`src/sdk/builtin-registry.js:163–172`、`src/sdk/service-router.js:134–137` 原样传入；Workspace/Submission 方法却解构 camelCase。 | 本地 Router 按公开载荷 save/merge 分别报 workspace_id required，submit 报 mission_id required。内部直接调用测试通过不能证明 Bot 入口通。Router:138 对 submission get 也直接传载荷，而 Registry:173 做了正确字段映射，两条查询路径还需统一验证。修复后用实际 Registry、CLI、服务传输验证，而非只测 class 方法。 |
| W2 · P0 · save 没有完成 Git、真实字节与不可变请求合同 | Workspace:187–201 接受调用方 files 文本，:243–244 写快照/JSON，saved git_commit 为 null，无真实 sandbox 稳定导出、request ledger 或来源 Task/E/Bot；版本号从读出的 revisions 推算。连续保存缺少可信当前 E ancestry。 | 本地两个并发 save 均成功返回 0.2，却报告不同内容哈希，同名快照可被覆写；不满足公开 revision 不可变。需要单写者、稳定捕获实际全树、真实 Git commit/parents、完整来源、幂等结果及崩溃恢复。不能用禁止新 tool 或两次 hash 替代停止后台写者。 |
| W3 · P0 · apply 是直接拷贝，缺工作面保护和三方接续 | Workspace:154–155,227–231 直接 materialize 到调用者 targetDir；Registry:162 接收该路径。只有与仓库根相同的有限拒绝，没有 Runtime 推导本 E 固定目录，也没有 dirty、write-busy、冲突/parents、原请求恢复及 finish 互斥。 | 本地 apply 无错误覆盖未保存 a.txt。路径风险是服务接受任意目标的源码事实，未在真实部署尝试越界。用绑定目录、稳定窗口、完整三方结果、dirty 拒绝或先 save、失败恢复与迟到 finish 注入验证；不允许由 Bot 指定宿主安装位置。 |
| W4 · P0 · merge 既未按 Git ancestry，也未检查最终树 | Workspace:203–225 取 source 的首个 parent，:258–272 按整文件相等判断冲突；checker 若提供，:213 在合成前检查 source。Registry 的正常调用未注入 Mission/Task 指定 checker。 | 同文件不重叠文本修改也报冲突；源单独 PASS 不能证明合成树。须用实际 Git parents/共同祖先，整版变更集合及删除/重命名，隔离检查最终树与固定环境。没有配置 checker 时不凭空设门槛，但完整性、权限、冲突与 CAS 仍必需。 |
| W5 · P0 · 冻结与 main 更新没有共同最终提交边界 | merge 读 record 后才 await checker，之后不重读 freeze/main/E 权限；freeze:159–172 和写 record 各自读写 JSON，Git 用普通 add/commit，没有带预期旧值的 ref CAS。 | 本地在 checker 暂停处 freeze main，再放行 merge，merge 仍推进 0.1→0.3，并把 frozen_submission_id 写回 null。需要同一协调域的最终 guard/CAS，覆盖 freeze、finish、软收尾、Mission stop 和 main 变化，不能只补入参检查。 |
| W6 · P1 · 文件安全、浏览与版本元数据不完整 | safePath:20–28 拦截 .. 与顶层 .swarm-，并非设计要求的 .git/运行配置/符号链接/特殊文件/大小完整边界。files/read/search:118–152 缺完整分页/二进制协议；#public:272 返回仓库 record，含宿主 repository 字段。#changed:254 把字符串树当文件 metadata，merge 的变化列表因此为空。 | 本地合成文件确实变化而 merge 返回 changed_files=[]；从空树保存新增路径也复现漏报；save 的 before 是 metadata、after 是文本，还可能把未改原文件报成改变。设计要求初始/last saved/applied/conflict 状态、history --all 和固定 revision 翻页。验收拒绝非法文件且无副作用，不只测试一个 .swarm-workspace.json。公开响应不应依赖宿主路径。 |
| W7 · P0 · Git/索引重启一致性与旧私有版本系统未切换 | Workspace:234–251 直接写 metadata、删除/重建快照、更新 Git，没有持久提交意图、恢复屏障和保护每个已保存 commit 的 refs。Runtime:1525–1603 仍用旧工作目录清单和单 problem_file 初始化，runner:1762 建 per-Core WorkspaceManager。 | 公共目录不自动删除是正向基础，但并发覆盖和崩溃可能破坏历史；本次未做所有崩溃点注入。应证明保存成功内容在删除 sandbox、Runtime 真重启和失败合入后仍可读取；仅公开 revision 可作为后继输入。 |

`candidateFileRef` 返回 Workspace/revision/path，本身符合普通文件引用，不因函数名含 candidate 就删除。旧 Candidate 表、路由或显示必须逐条证明仅供历史读取或明确拒绝新写；不能用搜索单词出现次数判断迁移完成。当前关键问题是新公开文件路径没有取代实际工作流。

### 4. Mission 最终验收：记录结果不等于检查了提交物

对照 01 的提交/冻结/停止与 03 §5.3–5.5。源码为 `src/runtime/mission-submission.js:18–40` 和 `src/benchmark/putnam-runner.js:2940–2969`。

| 缺口 | 源码确认及局部证据 | 必须验证的合同 |
|---|---|---|
| F1 · P0 · 不是提交者明确选择并冻结的真实验收 | runner 停 Core、生成报告后，以 operator 汇总含历史的全部 Material，再用 report.run.solved 作为 PASS/FAIL；没有针对冻结 main 的实际重新验收。Store 仅保存 Material IDs 和调用方 checker/environment/acceptance，不解析内容哈希、修正观察、可信 Mission 配置与时间费用上限。 | Bot 有效协调身份可提交现有公开交付，不造 E；输入固定后由可信服务检查。不用先前某一局部检查、Task done 或报告布尔值替代最终交付正确性。 |
| F2 · P0 · 单活跃与原请求重放不完整 | Store:23–28 在 await freeze 之前判断 active，文件直接 writeFile，无事务/请求指纹。相同 requestId 再 submit 实测 CONFLICT，而非原结果；换 ID 同快照也无检查复用策略。 | 并发两个提交最多一个生效，重复和改载荷结果确定；同快照/配置的确定性结果不能换 ID 重赌；基础设施失败按固定有界策略处理。 |
| F3 · P0 · 最终结果缺生命周期与来源复核 | finish:35–38 已对非 pending 记录返回既有终态，但对 pending 记录直接接受 verdict；没有校验可信 checker、当前 active submission、Mission 停止、配置或 main 仍匹配。store 没有独立 deadline 调度、取消/代次和 Runtime 停止联动。Workspace unfreeze 已检查冻结归属；缺口不是所有旧结果都会改判或解锁，而是缺少完整当前提交与生命周期复核。 | 当前有效 PASS 才固定 accepted revision，超时/取消/迟到/重复结果仅影响自身合法状态；停止不把未完成 Task 标 done，现有 E 有有限收尾，禁止新研究。不能据缺失 guard 宣称 formal24 曾收到迟到 PASS。 |
| F4 · P0 · freeze/持久化/恢复分离 | freeze 与 submission 文件写入不是原子受理，load 在读完成前标 loaded，unfreeze 错误被吞；与 W5 的 merge 又无最终共同 guard。 | 输入准备失败、进程死、结果未知、冻结释放失败可对账；重启不永久冻结、不重复收费、不解开新提交的锁。必须以权威服务和实际 ref 为准。 |

### 5. Standards、Prompt 与默认入口专项

本节把“实现符合设计”与“遵循仓库文档/工程规范”分开。下面 A1–A4 是 Standards 发现，D1–D4 是 Prompt/CLI 的设计差距。Phase06、Phase08 分别指本目录 06、08 章。

#### Standards 发现

##### A1 · P1 · Architecture 对真实系统提示词入口自相矛盾（文档，影响现行路径）

- 规则：AGENTS.md:49–53 要求记录实际 sender 和条件，Phase08:280–296、312–322 要求区分模板、装配、发送。 `docs/architecture/08-prompts.md:28–34` 称正常起动用 `SYSTEM_IDENTITY_PROMPT` 通过 Pi addendum，`docs/architecture/01-agent-core.md:60–62` 正确陈述 OpenSandbox 默认 null。两章在同一普通路径得出两种结论。
- 真实路径：`src/benchmark/putnam-runner.js:1738–1757` 缺省传 null（注释称 gpt_proxy addendum 曾报 Invalid URL），`src/agent/opensandbox-agent-adapter.js:198–215,246–271` 仅配置非空才附带参数，启动可不发送 user prompt；`putnam-runner.js:650–680,2611–2617` 当前把旧 BOUND SOP、Task guide 和短名单组装为 user RPC，`:1982` 绑定时 `sendInitialPrompt:false`，独立 composer 不是此处的最终模型输入。
- 影响：用组成事件、精确模板或测试 fixture 推断 system role 已送，会错误解释模型遵循和实验覆盖。可显式配置的 addendum、本地适配器、默认 provider 三条不能混写。
- 检查：在三条路径分别断言实际 launch argv、第一次 Pi RPC、system addendum 内容 hash 和被发送的最终 user body；把 Architecture 图表、prompt 生成目录和主解释一并改正。默认 provider 不支持目标机制时在 Issue 记录证据与明确决策。

##### A2 · P1 · 真实通知仍指示已删除命令和旧交接协议（活代码）

- 规则：Phase06:237–261、Phase08:248–249、280–296；AGENTS.md:51。 `src/runtime/runtime.js:1834–1842` 的 material_available 明示 `Call task.close`，handoff_warning 要求 Publish and link Handoff Material。 `rg` 的 Task 服务可用映射只有 `task.finish` / `task_finish`（`src/task/task-service.js:29–31,1767`），CLI 也只映射 finish（`src/cli/swarm-cli.js:7–14`）。架构 `08-prompts.md:173` 解说保留泛化描述，生成附录可暴露正文但未指出不可执行命令。
- 路径：TaskService link 生成 material_available（`src/task/task-service.js:1289–1293`）→ Runtime `#onNotification` 过滤当前 E→ `#deliverNotification` 结算后实际 `session.prompt(..., followUp)`，并标记 delivered（`runtime.js:1845–1889`）。这些词会进入实际上下文。warning 路径由 sweep（`:916–941`）触发。
- 影响：Bot 可能追错命令、耗尽收尾额度，提示和真实协议分叉。软收尾应支持无新成果直接按真实结果 finish。
- 检查：用真实 Registry/CLI 命令表对实际发送模板作一致性检查，分别覆盖 Material 通知、预算 warning、重复/未知发送和关停。审计当前未使用的 `Runtime.handoffTask/blockTask` 独立可调用方法（`:829–864`）时，要单独试路由而非从方法名推断旧服务写仍成功。

##### A3 · P1 · 迁移词汇表和架构基线仍锁到旧行为（文档）

- 规则：AGENTS.md:39,47–55；Phase08:312–339。`GLOSSARY.md:9–35` 仍把 shared Mission Task、多 E Agent identity、Execution-private Workspace、Workspace lineage、Claim 与 session rotation 写为 runtime baseline，定位到 `e6f97bc`。它不在 PR diff。部分这些词确实还出现在 live messages，例如 identity/Core lane 在 `putnam-runner.js:670–677,2614–2616`，但 old shared Mission Task 作为类型不能因为这一表就当作仍被创建。
- `docs/architecture/INDEX.md:3` pin `7c5836f` 并称 inventory pin 当前运行引用，但 `docs/architecture/source-map.json:3` 和生成的 `12-code-coverage.md:5` pin `f00710f`。映射已有 opensandbox worker、Dockerfile、extension、CLI（source-map:183,324,392,439），所以问题是映射标示的基线与内容解说漂移，并无证据说这些文件漏映射。 `scripts/generate-architecture-coverage.mjs:54–55` 把字段原样输出。
- 影响：读者按 accepted baseline 解读对象，或据文件指纹给旧写路径盖章。生成成功只验证登记完整性和字节漂移。
- 检查：同步 INDEX、inventory baseline、生成引用与 Glossary，保留真实仍可达的兼容行为在 Known Boundaries，旧词仅随历史解释。Phase03 Task 合同的 **Goal** 和实际 prompt 的 `Goal:`（`src/agent/agent-prompt.js:42–49`）是 Task 内部字段；Mission 是共享目标。应清理对象混用而非全局替换 goal。

##### A4 · P2 · 现有追踪不足以作阶段目标的模型输入溯源（可达，部分实现）

- 规则：Phase06:515–525、Phase08:292–304、AGENTS.md:51。现有 `src/agent/pi-adapter.js:84–112` 在向 stdin 写之前记录 `rpc_request` 原文与私有观察事件，RPC 通过独立相关 ID 等待返回。 `runtime.initial_prompt_composed`（`runtime.js:639–673`）与该 RPC 分离，且调用者可关闭发送；OpenSandbox 另有 `session_started` launch args/manifest（adapter:258–271）。Extension `src/agent/swarmenv-extension.mjs:85–86,98–106` 调 Bridge，未有四 skill 的实际加载/裁剪追踪路径。 `docs/architecture/08-prompts.md:20–49` 已部分界定模板覆盖不足，但不能满足版本关联合同。
- 影响：能检索真实 user body 时应使用 RPC 证据，但不能把 Compose hash 当 final message hash，也不能从私有 raw log/目录存在推断 provider 已读、skill 全文已达或错误后续已安全恢复。
- 检查：给同一 Bot/Sandbox/Pi/E 读取、compose、transport attempt、worker 写出、Pi accept/fail、模型返回及工具裁剪分段生成可关联记录。用本地审计最少数据验证每个真实路径的行为并在 Architecture 明示 provider 不可见边界。不提交原始会话和凭据。

#### 设计差距与真实可达入口

##### D1 · P1 · v1-draft.2、四基础工具、四技能和 CLI 都不能从 formal24 的 Bridge 成功推导

- 设计：Phase06:22–46,65–128,398–503、Phase08:183–189,245–250。目标先发完整稳定规范，再发包含 Mission、真实身份/预算/服务目录的动态启动消息，四基础工具为 Pi read/write/edit/bash，四个同版通用 skill 为 plan-task/use-material/use-workspace/finish-task，按需读；普通业务由 CLI。
- 路径：`putnam-runner.js:1738–1757,2611–2628` → `OpenSandboxAgentAdapter.buildLaunchArgs`（`src/agent/opensandbox-agent-adapter.js:198–215`）明确传 `--no-builtin-tools --no-skills --no-prompt-templates --no-context-files` → `src/agent/swarmenv-extension.mjs:63–89,98–106` 只按 profile 注册具名 `swarmenv_*` 工具 → sender `putnam-runner.js:650–680`。本地 `src/agent/pi-adapter.js:332–338` 也关闭内置工具/技能。Dockerfile:14–23 安装 `swarm` 和 src，但没有四份目标 skill 资源安装；源树可见实验用 Coding Agent skill 与 Mathlib domain skill，它们属于另外两层。Phase06 不要求强制加载四篇，要求可读、版本受控且实际读可追溯。
- 当前旧 SOP 是 composer v5 与 system 定义 v3（`agent-prompt.js:5–29,315`），语序仍为 Look→Take→Work→Check→Share→Propose（`:164–201`），含 Register、Core lane、Handoff、按回调通知、execution_progress、以术语候选引导 Judge。正常非 bootstrap discovery 还限定 listed Task，不能假设完整版 Mission 与授权服务文档已发。`taskLoopGuide` 查同一个 Registry 而硬编码 `swarmenv_task_create`（`:198`），如果 toolPrefix 或 manifest 名称变动，会给出与 advertised name 不一致的指令。用户已确认按文档执行；Phase06:80–85 明确优先接续合适既有 Task，不增加每 Bot 强制新建 Task 的规则。
- 检查：用部署镜像的真实 Pi 枚举工具、先把四工具目录/权限做通，再运行无 E 的完整 Mission/Workspace 材料发现、按需 skill read、CLI 提案过滤/明确错误。验收区分系统角色、实际 user RPC、四基础工具、CLI 权限/命令及四技能五项。

##### D2 · P1 · 现有 swarm 二进制没有覆盖目标 CLI 或默认新 Bot 的路径（可达工具栈及独立部署）

- 设计：Phase06:263–373 的命令、位置参数、受保护身份和稳定 request ID；Phase08:189,248–250 的默认入口迁移。当前 Dockerfile:17–23 确实安装 CLI 和 bash。当前 CLI `src/cli/swarm-cli.js:4–65,127–148,206–236` 映射 `task create` 而非 `task propose`，`material get/consume` 而非 `view/use`，`mission status/finish` 而非 `mission submission view`，缺 Bot exit、Workspace apply/history/status 的设计命令。除了 `service view`，取出第三个位置参数后不会传给 invoke。CLI 会按服务 manifest 查操作；有独立 operator 入口和服务名可配置，不代表 phase 命令可用。体现在 `task view --help` 要 `--task-id`，目标 `task view <task-id>` 的位置参数会被忽略。生产配置用 Bridge URL/token 走 extension，CLI 则按 `SWARMENV_<SERVICE>_SERVICE_URL` / provider manifest 走直连（`:84–109,185–216`）。保留可设置 `--actor-ref` 和 E 元数据的 envelope 是 operator 兼容面，是否能改变授权由接收方校验，本文未验证任何绕权。
- 影响：CLI 在镜像中与新 Bot 通过受保护绑定实际可调用是不同层；不能简单改 Prompt “用 CLI”，否则缺临时身份、传参/路由不一和保留旧命名等问题会转成行为错误。
- 检查：按目标根/服务/命令 help 及位置参数做快照和集成测试。对正常 Bot、无 E、活跃 E、过期 E、operator 逐一核对允许与拒绝，验证同 ID 的未知响应恢复。对旧 `swarm context`，仅配置 context endpoint 时 generic service 路径仍可能触达其 manifest，按 Phase08 标出兼容期或明确拒绝。

##### D3 · P1 · agent 可达的 execution_progress 承担隐式 save、publish 与 handoff

- 设计：Phase06:94–129,302–316、Phase08:235,248。阶段目标是显式保存、发布和 finish，私有 checkpoint 可作 Runtime 内部审计。
- 当前 `agent-prompt.js:25–27,186–201` 把 `execution_progress` 作为统一 checkpoint/handoff；`src/agent/services-bridge.js:471–481` 调 Runtime 并在 kind=handoff 时释放当前 take。`src/runtime/runtime.js:958–1061` 含保存本地 Workspace revision 和 checkpoint、发布/链接经验 Material，若 handoff 还进入 `handoffExecution`。这是实际 callable 业务通道，区别于仅有内部历史字段。旧软提醒要求专用 Handoff Material（A2）。旧方法即使拒绝写，也应覆盖拒错前对 Sandbox 的副作用。
- 检查：移除 Bot 的隐式组合链前确保显式 save/publish/finish 能按故障原因安全收尾，验证不产生假的已保存、可接续与自动发布记录。旧 route/manifest 的拒绝必须同时验证无状态副作用。

##### D4 · P1 · 固定工作路径不是当前远程 cwd，需分离运行和项目目录

- 设计：Phase06:46,75–78,87–91；Phase08:347 要真实验证固定受保护路径及进程生命周期。当前远程 adapter 固定传 `cwd:'/workspace'`（`src/agent/opensandbox-agent-adapter.js:218–225,246–254`）→ worker 实际以它 spawn（`scripts/opensandbox-agent-worker.mjs:95–108`）；`src/runtime/opensandbox-manager.js:486–491,503–513` 直接向 `/workspace/` 同步和导出，避开 `/workspace/.swarm`、Git 和部分秘密文件名。镜像也只建 /workspace（Dockerfile:21–23）。因当前 Pi 工具关闭，仅从路径推断没有恶意 write 的能力不可成立，反过来也不能断言已经成功越权。
- 检查：不凭启动文本验收；以新镜像验明确实为 /workspace/project、发现态是受保护空目录、Pi/写子进程在 take 准备期间不能写、grant 后可以写、finish/fence 后不可写，效果由 Runtime/OS 证明。

#### 残留处置口径和审核边界

- 确认历史显示兼容：`src/observability/observability-server.js:920–925` 对旧 `initial_prompt` 读回退便于历史解释。 `src/task/task-service.js:236,256` 构造器自动 schema 迁移是活代码，和历史读取不同，需另验 Phase08:209–233 要求的旧 writer 隔离。不能以 7c5836f 移除 get_task 的证据证明兼容面全清。
- `workspace_mode:'clean'` 在 Bridge:533–541 仍是活动内部字段，且 TaskService:2329 拒非 clean。它是去除 private resume 的防护痕迹，不能把字段存在定为旧能力可用。 `root-only` 仍是 runner treatment selector（`putnam-runner.js:44,1632`）；它单独不证明 Root/Child schema 回归。
- Fowler 启发式仅用于定位：当前旧 SOP 硬编码名称、Capability 注册与 CLI alias 独立维护、Runtime 实际通知和生成器配置是需要同时改的多个点；可以让验收从真实 manifest、发送点和启动配置核对，避免为了合并代码再新增注册层。主要评级来自仓库有明确要求、可达路径和可观察后果的项目。

## 本次离线验证

- `npm run docs:check` 通过，覆盖 7 份 prompt 文档、23 个 prompt source fingerprint、10 个发送点、19 个固定 guidance、100 个架构映射文件和 1,028 个链接。上面的系统角色陈述矛盾、过时 baseline 字段和已删除命令仍存在。
- `git diff --check 1d9be9f...36b0cf3` 通过。
- 用进程内 localhost HTTP double 返回 `task_view` 和 `task_create` manifest 并读取真实 CLI 请求 body，`task view T123` 到达服务的 task_id 为 null，`task view --task-id T123` 到达为 T123；`task propose` 找不到操作，未配置的 `bot exit --reason no-work` 识别为未知 service。没有调用真实 provider、没有使用实验额度。此 probe 验证参数解析和分发差距，生产权限待验。

### 6. 迁移、观测与“是否清理干净”

**还没有清理干净。** 需要退役的是可执行的旧机制，而不是所有历史单词。按 [08 Migration](08-architecture-migration.md) §6–9 核对如下：

| 层面 | 本树的实际状态 | 处置边界与验收 |
|---|---|---|
| Mission / Goal | 批准的 Task 合同仍含 Goal；runner 的首提案模板把 Mission 责任复制为整题 Task；formal24 仅有这一项持久 Task。其他执行中的 task_create 并非完全不可达。 | 保留合法 Task 字段与普通自然语言；去掉旧顶层对象混用和整题 bootstrap。不能全局替换文本来宣布模型迁移完成。 |
| Core / Bot / E | 固定 agent:core-N、合成 worker Session、真实 E 及独立 Sandbox key 混用。 | Core 只是槽位；每个新 Bot 独立持久身份、凭据及零/一 E。旧 Core 记录用于历史解释，不能代表新 Bot 权限。 |
| 树型 Task / 调度 | spawned_from、ROOT/CHILD、rootTaskId、短名单与 root-only selector 仍可达；并非所有历史 ROOT 列都必然产生新树任务。 | 按入口分别核对新写、调度策略、历史展示。保留实验 treatment 名称不意味着允许它改变新 Task 对象合同。 |
| 私有恢复 | 公开 take 拒绝 resume 是有效防护；Runtime 仍有内部 session/workspace 恢复分支和恢复回调。 | 新 Mission 不使用私有继承；保留历史读取时不能注册为 Bot 可写/可恢复能力。验证默认与配置路径、重启和 compaction。 |
| 旧收尾协议 | live execution_progress、task.close 通知、专门 Handoff Material、publish 后 attach。 | 换成显式保存/发布/finish 和无 E exit；旧名拒绝时也不得先产生副作用。普通 handoff 叙述可以保留，不再是独立领域对象或另一套状态机。 |
| Material role / evidence | 新写仍受永久角色、证据类型与全局可信度字段约束。 | 按 M1/M6 去掉活动约束；旧行只能按原版本解释，不机械映射成新事实。 |
| Candidate / Workspace | 普通文件引用 helper 正确；公开仓库与旧 E Workspace 并存，实际实验主要走后者。 | 检查全部 manifest、CLI、Bridge、Runtime、schema 和显示；后继只用公开 revision，不能把旧本地 revision 贴上新名。 |
| 旧数据库与部署版本 | Task/Context 构造器仍 ALTER 旧 schema；存在兼容读取，但未建立完整“旧运行只读、新 Mission 显式起点”的部署验收。 | 08 §6 要求固定 schema、CLI/API、prompt、skills、checker/provider 与镜像版本；阻止旧 writer 写新运行。导入需保留原来源和不完整状态，不能把旧 SATISFIED/CLOSED 自动视为新 done。 |
| Dashboard 与报告 | `src/observability/observability-server.js:1120–1127` 仍从 execution.workspace_ref 恢复旧 WorkspaceManager；当前文件不接入 MissionWorkspace/SubmissionStore。Material 投影保留 supersedes 字段，不能代替纠错关系观察；报告保留 root/child 等旧统计。 | 需要 Mission 首页、Bot 阅读/关闭时间线、公开 revision/parents/冻结与材料更正视图。服务是权威，SSE/缓存/报告落后要标示，不从旧投影驱动状态。UI 的全部组件和实际 served assets 需随后逐页验收；本次未声称浏览器覆盖完成。 |
| 分析器的身份与指标 | `src/analysis/experiment-analysis.js:989,1009` 使用目录名推导 E；formal24 的 fresh 目录导致生成分析重复计算。身份循环 take 计数、Judge 计数和实际数据库也不一致。 | 输入 schema 与稳定 ID 映射必须校验；缺记录记 unknown，不能补零。统计分开 Bot、Session、E、请求、缓存复用和独立检查；修复分析器后回算同一批证据。 |
| 文档与隐私 | GLOSSARY、Architecture 入口、source-map baseline 有漂移；历史实验资料还需按现行脱敏规则逐项检查。 | 本审计不把全部旧文档都判为活动模型，但读者入口必须说明当前行为及未完成迁移。原始会话、证明、凭据、状态库及私有绝对路径不进入本报告或知识接续。真实 observer 网络可达与权限需 E2 验证。 |

上述扫描不是“仓库以后绝无旧字符串”的证明。完成清理应有从默认入口及兼容入口出发的可达性证据、拒写回归和准确手册；关键词检索只能帮助找位置。

### 7. 本次局部复现与现有测试为何没有挡住

探针使用合成文本和临时 Git 仓库、内存 Context、可信初始化 fixture；没有模型、OpenSandbox、真实证明或远程调用。测试后删除临时数据。以下操作足以复现，不依赖私有原始日志：

| 组件探针 | 操作 | 当前结果 | 证据限制 |
|---|---|---|---|
| save commit | create 空/单文本项目，再 save 完整树，读 revision metadata | 新 revision 的 git_commit 为 null | 验证保存格式，不证明 OS 导出安全 |
| 并发 save | Promise.allSettled 同一 Workspace/base 的两个 save，分别写 left/right | 两个 fulfilled 均为 0.2，返回不同哈希 | 这一运行复现碰撞；修复应使用可控暂停点检验，而非只重复碰运气 |
| dirty apply | materialize 初始树，在目标写 unsaved，再 apply source | 返回成功，文件被 source 覆盖 | 直接 class 入口；真实 E 绑定另验 |
| freeze/merge 竞争 | 在 merge checker 中等待；freeze 当前 main；释放 checker | main 仍前进到 0.3，冻结归属变 null | 用 barrier 确定性触发，证明最终 guard 缺失 |
| changed paths | 上述 merge 实际改变 a.txt | changed_files 为 [] | 反映字符串树/metadata 比较错误 |
| 公开路由 | 按 catalog 的 snake_case 通过 ServicesRouter 调 save/merge/submit | 分别报 workspace_id / mission_id required | Registry 同形传参已静态确认，实机 CLI 还需联验 |
| submit 重放 | 同 requestId、同载荷连续 submit | 第二次 CONFLICT | 不符合原结果查询/重放；不扩大为所有并发情况已复现 |
| Material 替代 | 同 Mission 初始化 a/b/c，依次 supersede a→b、a→c、b→a | 三条关系均 active | 验证服务关系不变量；不声称真实 Bot 已越权 |
| CLI 位置参数 | 捕获 CLI transport 输入，对比 task view T123 与 task view --task-id T123 | 前者 task_id=null，后者正确 | 无外部服务的命令解析/路由探针 |

现有 `test/mission-workspace.test.js` 主要直接调用 camelCase class、顺序保存/合并，冻结测试是先 freeze 再发 merge；没有覆盖公开字段映射，也没有在 checker 中途冻结。`test/mission-submission.test.js` 验证顺序单 active 和失败解冻；“isolate late results”的测试名称没有对应迟到 PASS、真实 checker 或代次竞争。测试通过说明这些例子成立，不能扩大成 V16/V27/V28/V29 全通过。

本次 `npm run docs:check` 通过（1037 个本地链接/锚点、100 个源码归属与指纹），`git diff --check` 通过。没有重新运行全量 `npm test`：当前任务只改审计文档；历史 214 项通过仅是先前固定版本的证据。

当前任务只改审计文档。没有把以上反例改成“期待错误现状”的永久测试，也没有趁审计重写运行逻辑。后续修复应把反例转成针对公开合同的回归测试，预期值必须是设计行为。

## Next steps

### 8. 对原 V01–V32 验收逐项对账

本表沿用 [07 的验收编号](07-validation-and-research.md#5-工程验收矩阵)，不新增验收标准。“部分证据”不等于通过；没有本次实机证据的项目一律不盖 E2/E3 通过章。

| 情景 | 当前判定与关联缺口 | 修复后所需证据 |
|---|---|---|
| V01 零 Task 启动 | 有零 Task，缺四个独立发现 Bot；Runtime 首行 | 四路从空 Task 读取真实项目并各自选工，记录无 E 成本 |
| V02 认领前项目只读 | 有部分工具只读拒绝；固定路径/OS 边界未验收 | 真实非 root 进程、父目录替换与直接写的否定对照 |
| V03 管理与服务旁路 | Context/Workspace 直接服务范围不足；M2/M3/W3 | 独立身份直连、跨 Mission、管理面与伪造 E 拒绝 |
| V04 同 Task 竞争 | 正常排他有证据；conflict 分支 ReferenceError | 两 Bot 真实竞争、失败者重新发现且未获得写权限 |
| V05 Bot 重复 take | 当前 active owner 守卫不等于一生一个 E | 同 Bot 并发及结束后重复 take、真实 Pi/凭据一致性 |
| V06 take 生效顺序 | 准备/active/grant/binding 不符合唯一顺序 | 每个暂停点的状态、真实目录权限与同一 Pi |
| V07 丢响应/准备失败 | 有请求防重基础，完整补偿/重启未证实 | 同 ID 恢复、准备失败补偿及无第二个 E |
| V08 迟到授权 | 生命周期次序不闭合 | 中止准备后迟到 grant 不可重新写，安全隔离前不释放 |
| V09 贡献归属 | 有生产 Task/E；Bot/范围/active 校验不足 | 真实来源、跨 Task 合法使用与伪造来源拒绝 |
| V10 发布持久性 | 正文持久化有真实记录；附件和响应未知未覆盖 | 删除原 sandbox、失败上传、未知重试、正文/附件可取 |
| V11 失败交付收尾 | 四结果有入口，旧交接与完成条件仍干扰 | save/publish 失败下 done 拒绝、其他真实结果可收尾 |
| V12 finish 失联 | 终态先于物理清理，stop 错误可吞 | 失联/后台进程/DELETE 未知，closing 保留占有直至隔离 |
| V13 旧 E 与长操作 | 版本 guard 局部成立，已受理作业与费用未联验 | 撤权后拒绝新请求，旧作业可查询且计费有界 |
| V14 干净接续 | clean take 有限制，公开完整 revision/apply 路径不通 | 新 Bot 接续已保存文件，私有标记不出现 |
| V15 纠错可见性 | 默认隐藏已实现，精确读取/争议观察不足；M5 | dispute、supersede、精确读取和消费者可见性 |
| V16 并发 main | 无最终 CAS；W2/W5 | 同旧 main 只有一次提交，失败方原 E 可整合重试 |
| V17 最终合并树检查 | 实际检查 source 或未注入 checker；W4 | 源各自通过但组合失败、checker 期间 main 前进 |
| V18 私有/审计隔离 | 默认干净目录不是全部网络/存储隔离证明 | 实机跨副本、旧卷、observer 下载和 Git 管理面拒绝 |
| V19 预算/compaction | 无 E exit、恢复分支、费用尾部未闭合 | 阅读/执行预算、有限退避、公开接续和不热重启 |
| V20 Prompt/skill | 工具/skills 禁用、实际发送记录分层不足 | 固定镜像、实际正文/版本、技能读取/缺失及裁剪 |
| V21 一致 save | 接受 files payload，缺稳定导出；W2 | 后台写进程、真实全树、失败无假成功 |
| V22 apply 与失败恢复 | 直接覆盖 dirty；W3 | 同 E 三方 apply、稳定安装、失败回滚/对账、finish 互斥 |
| V23 动态前置 | 两套依赖图、blocked 后不正确重算 | 混合环、closing 期间 done、取消与版本化修复 |
| V24 未 take 退出 | bot exit 提示存在但接口缺失 | 无 E 正常退出、真实原因/成本、事件唤醒和退避 |
| V25 软/硬停止 | 软限制/最终 guard/清理次序不完整 | 有限 save/publish 可用，迟到 merge/贡献拒绝 |
| V26 整份替代/撤销 | 环和多后继本地复现；M4 | 关系 CAS、同 Mission 后继纠错、争议和完整历史 |
| V27 提交快照 | F1/F2/F4，公开入口字段错误 | 真实提交者、内容版本、单 active、幂等/快照复用 |
| V28 超时迟到结果 | F3/F4 缺代次、deadline/停止复核 | 旧 PASS 只审计，不接受旧版本、不解锁新提交 |
| V29 Workspace 崩溃 | 没有 journal/恢复屏障；W7 | Git 对象/ref/索引/响应各窗口真重启，幂等原结果 |
| V30 检索/探索交付 | shortlist 与分页不足，整题验收压缩局部责任 | 有限相关检索、明确未读范围、合同允许的负结果 done |
| V31 持续 main 变化 | apply/ancestry/最终检查尚缺 | 原 E 可继续、多次变化、冲突解决、成本/饥饿记录 |
| V32 普通文件/历史 | 引用形状正确；历史 CLI 与不可变性不足 | history --all、删除当前文件后旧 revision 仍可读，无 Candidate 状态机 |

C0–C7 必须在同一修复版本串起来：C0/C1 解决四路发现与分工；C2 安全保存和依赖收尾；C3/C4 删除旧 sandbox 后公开接续并处理 main 变化；C5 纠错/撤销；C6 软硬预算与无 E exit；C7 真实固定快照验收。脚本控制的四路请求只算 E1/E2 集成，不是 E3 自主行为。两种有意失败变体——最终组合树失败、材料新版遗漏有效结论——也应保留。

### 9. 修复顺序与下次正式实验入口

沿用 08 的 P0、S1–S5 切片，不另造研究方向或任务依赖账本：

1. **先完成运行基础与 S1。** 统一 Bot 身份、固定目录、凭据和状态机，修复 take/finish 的物理授权次序、竞争分支、无 E exit 与有限预算；让所有 Core 真正从零 Task 参与发现。以确定性并发和故障测试收住边界。不能单独改 allowEmptyDiscovery 后立即开正式实验。
2. **补齐 S2/S3 的共享与最终验收。** Material 范围/关系/正文、真实 Workspace 全树导出/Git/请求记录、同 E apply、最终树检查/CAS、Mission 冻结提交与停止共同验收。公开 API/CLI 与类内部测试使用同一业务路径。
3. **完成 S4/S5 的默认入口迁移。** 安装四基础工具、完整规范与四 Bot skills；去掉旧短名单强制、整题模板和隐式交接，迁移 UI/分析与文档。旧写路径明确拒绝，历史读取保留原版本含义。
4. **用固定版本完成 V 与 C 的联验，再进行已获授权范围内的真实 Bot 验证。** E2 要有实际 provider/镜像/身份/停止证据；E3 先回答独立发现和局部分工是否真实发生。下一次一小时实验的候选提交需附已满足/仍未满足的完整验收对照，不能用旧版本测试或某次 HTTP 成功抵消缺口。

本轮没有运行新实验，没有修改 runtime 或把上述问题标为修复。PR #124 仍是未完成设计迁移的实现候选；不建议以“完成 Issue #122”的口径合入或关 Issue。若要先合入一个明确的中间切片，仍须在 Issue/PR 写清真实交付边界和遗留问题，不能据此宣布阶段验收完成。本页不是额外审批闸门；它使后续修复与用户判断有一份可核对的完整依据。

### 10. 证据与限制

本页源码证据均固定到 `36b0cf3`。已有真实运行的每 Bot、Task、Material、Judge 与时间窗口见[实验分析](../../experiments/issue122-formal24-gap-analysis.md)，原始材料保留在忽略的本地实验目录；本页只提交脱敏结论、源代码定位和合成探针步骤。

审计覆盖全部设计章节及主要可达入口，不声称穷尽每个代码分支、全部部署组合或任意规模活性。网络/管理面、真实进程停止、附件与文件导出、完整成本、各类外部长期作业和 UI 全流程没有在本轮补做实机测试；相应条目保持未验证。没有通过这次单项目无对照运行评价 H1–H4 的研究收益。修复后需重新固定最终代码、generated references、Architecture 解释、Issue 接受条件和实际验证证据。
