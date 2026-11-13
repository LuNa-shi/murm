# 03. Task：稳定责任、动态等待与执行结束

> 设计附件：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122)。本文是经本轮决定修订的目标合同，不代表接口已经实现。
>
> Goal、Deliverable、Completion condition 创建后保持稳定；v1 不提供通用 revise。运行中发现前置工作可以增加有记录的等待关系，完成后恢复原责任。每个 Bot 最多 take 一个 Task，结束本次执行后退出。

本文只定义 Task 的责任、提出/选择、等待、完成和取消。Bot/Core/E 生命周期见 [01](01-model-and-runtime.md)，Sandbox 见 [02](02-sandbox-runtime.md)，Material 见 [04](04-material.md)，项目版本见 [05](05-workspace.md)。

## 1. Task 合同与视图

### 1.1 稳定目标与可变运行状态

Mission ID 标识共同目标，Workspace ID 标识对应的持久项目仓库；一对一关联不意味着可以混用两个 ID。

| 层次 | 信息 | 约束 |
|---|---|---|
| 稳定身份 | Task ID、Mission ID、Workspace ID、Creator | 来源由可信身份记录；在某个 E 中提出时同时记录 E |
| 稳定责任 | Goal | 本项要解决的问题及其对 Mission 的作用 |
| 稳定责任 | Deliverable | 应交付什么可被使用的成果 |
| 稳定责任 | Completion condition | 何时算完成；明确是否要求进入 main、指定哪些检查 |
| 初始上下文 | Inputs、可选 Workspace base revision | 保存明确 Material/文件版本和初始条件，不隐式继承私有目录 |
| 运行关系 | Dependencies | 必有但可空的 Task ID 列表；通过本章的受限等待操作调整，保留关系版本和完整历史 |
| 运行状态 | Status、当前 owner、阻塞/取消原因、可选 replacement | 当前 owner 是 E；历史执行与结束结果单独保留 |
| 系统记录 | 合同版本、关系/状态版本、时间戳 | 状态变化不等于修改目标合同；并发写按预期关系/状态版本检查 |

不提供通用 `task revise`。Bot 不能修改 Goal、Deliverable 或 Completion condition，也不能通过降低要求把本次工作变成 done。原责任确实需要改变时创建新 Task，再明确取消旧责任并保留替代指向。

Dependencies 是运行协调关系，区别于上述稳定责任；这项受限变化允许真实研究过程中新增前置工作。它不引入复杂条件语言、任意文本编辑或自动判真。

不增加 `spawned_from`。Creator 和创建时 E 已表达提出来源；依赖只由明确关系决定，不从创建顺序或“父 Bot”推断。

### 1.2 Workspace 起点与文件引用

Task 可给出公开 `base_revision`；不指定时，take 解析当时 main 的实际 revision。Runtime 记录初始 revision/commit 和输入内容版本，Bot 不需要提供 Git SHA 或管理 Git。

这个起点是初次执行输入，不意味着整个 E 永远不能接入新成果。同一 E 可以显式 `workspace apply --from R/main`；Runtime 记录来源和当前 dirty/conflicts，原始输入保留审计。若稳定完成条件明确限定某个版本，后续 apply 不会自动取消该要求。

项目成果以 `(workspace_id, revision, path)` 引用。candidate 是某 revision 中的普通候选文件，不存在独立 Candidate ID、存储、关联或 discard 命令。save 保存整个一致文件树并产生不可变 revision；apply 后尚未 save 的工作树不能当作已持久版本。

### 1.3 List 与 detail

- **List** 返回轻量摘要：Task ID、目标摘要、状态、当前执行者、依赖满足情况、阻塞/取消原因摘要及最近更新时间。分页和截断必须显式。
- **Detail** 返回稳定合同、当前与历史等待关系、输入、初始 Workspace 起点、创建来源、历史 E、结束记录、替代指向和检查/交付引用。
- Bot 必须通过 detail 核对具体责任，不能把列表摘要当成完整合同；未读完相关分页不能声称不存在相关工作。

Task 不强制有父任务或固定专业角色。“读取一个文件”“执行一次搜索”通常是步骤；能形成独立责任和可接收交付的工作才值得成为 Task。

## 2. 状态与排他执行

| Task 状态 | 含义 | 可否 take |
|---|---|---|
| ready | 未完成、无 owner、全部必要前置满足，Mission 允许继续 | 可以，服务原子检查 |
| running | 一个 E 已占有责任，包含 preparing、active 和未安全解绑的 closing | 不可以 |
| blocked | 无 owner，但仍有必要前置未满足或失效前置待修复 | 不可以 |
| done | 当前 Bot 已声明达成稳定合同，服务结构检查通过 | 不可以 |
| cancelled | 责任明确撤回，保留原因与可选替代 Task | 不可以 |

Task 只有在旧 sandbox 已停止或隔离、当前 owner 仍为旧 E 时才解除占有。收到 finish 不立即释放 owner，不能先变 ready 再慢慢清理。

单次 E 崩溃不代表 Task 永久失败。incomplete 或异常退出后，服务依据已持久的等待关系计算 ready/blocked。Mission 已成功、取消或停止时，即使局部条件满足，也不得重新 take；不为简化列表而把未完成 Task 一律写成 done。

## 3. 动态等待、取消与修复

### 3.1 最小依赖语义

`T1 depends_on T2` 表示 T2 达到 done 后，T1 的这条前置才满足。多个前置全部满足才能认领。T2 一次 E 失败不改变这个规则；T2 cancelled 不算 done。

每次添加或替换关系，Task Service 检查目标存在、同一 Mission、没有自依赖，也没有由原有与新增关系共同形成的环。创建时与运行时使用同一规则；第一版不加入表达式或多种依赖类型。

Dependencies 与 Material 输入不同。若 T2 尚未 done，但已有局部成果足以开始独立工作，可以读取这些成果并提出独立 Task，不必建立不必要的等待关系。一旦明确声明必须等待，就不能仅因为有一条进度 Material 而绕过它。

### 3.2 执行中发现新前置：finish blocked

例如 T1 执行到一半才发现必须先完成 T2：

1. 当前 Bot 读取已有任务，复用相关 T2；没有适合责任时先 propose T2，确认成功及其 ID。
2. 保存值得保留的文件 revision 和 Material，供后继使用。
3. 调用 `swarm task finish --outcome blocked --wait-for T2 --reason ...`。
4. Service 验证当前 E、依赖和环，在同一协调事务中保存 request、结束意图及新增等待关系，并把 E 转 closing。
5. Runtime 停止整份 Bot；安全解绑后 T1 按全部依赖的当前状态计算 blocked/ready。前置已全部 done 时直接 ready，不等待一个已经发生的完成事件。
6. 若仍有未满足前置，后续 T2 done 时 Service 再重新计算 T1；全部条件满足时变 ready，由新 Bot 在新 sandbox 中 take。

`--wait-for` 将明确前置加入当前有效关系，不静默删除原有依赖。若 T2 在处理期间已经 done，收尾后可以直接 ready；若拟增加的 T2 已 cancelled，拒绝这次 finish blocked 并说明需要选取有效前置，当前 E 仍可处理错误。

不能把“需要等 T2”写在 progress 文本中却用普通 incomplete 让 T1 立即重新可领。也不能先结束 Bot 再补写等待关系；finish 与关系记录的原子性是验收要求。

### 3.3 前置取消后的受限修复

前置被取消时，下游保持 blocked，返回明确的失效前置和替代提示；取消不会自动满足依赖，也不会自动把下游一起标 done。

使用：

```bash
swarm task dependency replace T1 --from T2 --to T3 --reason "..."
```

这个协调操作仅在以下条件同时满足时允许：

- 调用者具有本 Mission 的有效协调权限，未绑定 Bot 也可以调用；
- T1 处于 blocked 且没有当前 owner；
- T1 当前确实依赖 T2，T2 已 cancelled；
- T3 存在、同一 Mission、未 cancelled，且不会形成自依赖或环；
- 请求匹配预期关系/状态版本；竞争修复者必须刷新事实再重试。

只替换指定关系，保留其他依赖、稳定责任和旧关系历史。若 T3 已 done，重新计算后可 ready；否则继续 blocked。替换依据由 Bot 说明，Service 检查结构，不宣称它已证明两个研究交付语义等价。

不提供无理由“清空依赖”或强制 unblock。若没有满足原责任的替代前置，应保留真实阻塞或明确取消该责任，不能反复认领同一个已知不可推进任务。

### 3.4 原责任取消与新责任替代

原 Goal/Deliverable/Completion condition 确实需要变化时，先 propose 新 Task，再明确撤回旧 Task：

- **正在执行的旧 Task：** 当前 owner 使用 `task finish --outcome cancelled --reason ... --replacement T3`；同正常 finish 一样安全关闭 E/Bot。
- **无 owner 的 ready/blocked Task：** 有效 Mission 协调身份可使用 `task cancel <task-id> --reason ... [--replacement T3]`，按预期状态/关系版本更新。
- **其他 Bot 的 running Task：** 旁观 Bot 不得取消或接管；通过公开信息提出问题，由当前 owner 或受信任操作者决定。
- done 不通过普通 cancel 改写；历史完成记录与后续研究纠错分别表达。

replacement 指向同 Mission 的明确非 cancelled Task，不能指向自己或形成替代链循环。它保留责任变化的解释，不自动迁移已有下游，也不替原 Task 满足 done 条件。下游先保持 blocked，核对替代工作后按上一节显式修复依赖。

如果新责任根本不能满足原下游，不能假装替换成功；需要调整责任时创建新 Task，并取消已不适用的旧责任。取消链保留真实原因，最后无可推进工作时正常等待/退出，不生成一串空任务来填 Core。

## 4. 提出并选择有价值的 Task

### 4.1 提出前的阅读

1. 读 Mission 目标、验收、预算与 Workspace main 的实际版本。
2. 查全部相关 Task 状态，包括 running、blocked、done、cancelled；处理分页。
3. 检索并阅读全文，核对 Material 的来源、适用范围、修正关系和相关文件 revision。
4. 优先接续已有合适责任；确有缺口时提出新 Task，说明与近似工作的区别或衔接。

系统阻止同 request ID 重复创建，并保证同 Task 单 owner；它不能保证并发提出的两个不同 Task 没有语义重叠。重复工作需要通过实际行为和费用评估，不靠改名隐藏。

无 owner 的重复责任可按明确 cancel 合同退役并指向保留项；已运行任务由当前 owner 处理。不能由旁观 Bot 强占或删除其他正在执行的工作。

### 4.2 合格提案与选工

| 提案需回答 | 例子 |
|---|---|
| 局部目标是什么 | 修复 CSV 分组统计的空组和缺失值处理 |
| 谁能使用交付 | 后续整合者使用保存的文件版本、用例与运行说明 |
| 怎样判断完成 | 对明确输入范围通过指定检查，说明未覆盖项与是否须进入 main |
| 与已有工作怎样衔接 | T2 已处理一般分组，本项只修复空组，引用 M2 和对应文件版本 |
| 为什么现在值得做 | 它阻止当前整体回归，且有可复用输入 |

任务规模以有限 E 能产生有用增量为参考，不要求一次必定完成，也不固定拆成 N 项。紧密相关且共享上下文的步骤可以保留在一个 Task。

Bot 比较 Mission 相关性、解锁作用、可复用成果、重复成本、不确定性和剩余预算，给出简短选择理由，不输出私有思维过程。v1 不把猜测价值变成隐藏调度器，也不固定经理/研究员角色。

没有适合工作时可以说明真实等待条件，或在没有 E 和未决 take 时调用 `bot exit --reason no-work|selection-budget`。Runtime 按事件/退避重新评估；空队列、选工预算耗尽或 Bot 退出都不等于 Mission 完成。

## 5. 执行、交付与 finish

### 5.1 take 后核对输入

take 返回 Task/E、固定项目目录、初始 Workspace revision、Material 版本和权限预算。Bot 核对与选工时观察的差异；take 前项目内容来自 API，不能把空的预留目录误认成空项目。

main 的后续变化不会后台改写当前目录。需要接入公开新成果时，在同一 E 内显式 apply；需要长期保留本地成果时 save。初始 revision、最后保存版本、apply 来源和未保存状态分别记录。一个 Bot 不在同一 sandbox 中 take 第二项责任。

### 5.2 什么值得保存

有价值的局部成果可以是实现、反例、排除路线、可复现失败、资料整理或部分推导。消费者应能知道已经知道什么、根据什么、尚缺什么。

- 研究结论、方法、证据说明与接续建议发布为 Material。
- 项目代码、数据与候选文件通过 save 保存为整个文件树的不可变 revision。
- 同一成果可以同时有文件与研究说明，并以精确文件引用相连；不创建第二份 Candidate 对象。
- 临时日志与每个模型回合不自动成为 Material。

例如 B2 未完成统计模块，但保存了触发错误的输入、部分修改和失败测试，并发表解释其范围的 M2。后继可以读取 M2 和 revision 内的具体文件，再 apply 整份版本继续；不能只留下前任 sandbox 路径。

### 5.3 分开记录的完成事实

| 事件 | 必须观察到的事实 | 不隐含什么 |
|---|---|---|
| Material publish | Context 已持久接收并可按 ID/版本读取 | 不代表已被他人使用或结论正确 |
| Workspace save | 一致文件树已持久保存，返回 revision、变化路径和来源 | 不自动推进 main |
| Task done | 当前 Bot 声明满足稳定责任，结构检查通过 | 不自动合入 main 或完成 Mission |
| main merge | Workspace 已按版本与检查合同接纳 revision | 不自动代表全部 Mission 要求达成 |
| Mission accepted | 01 中固定交付通过最终验收并记录 accepted revision | 不替所有尚未完成 Task 标 done |

有些 Task 只要求交付可供后继使用的文件与验证说明，因此可在 merge 前 done；有些明确要求进入 main 并通过回归，必须取得对应 merge 与检查结果。退出时不能改变这两种合同。

完成声明由当前 Bot 根据合同作出。Service 只检查可信 owner、合同版本、明确要求的交付可读性、文件/Material 引用和指定检查结果；要求 PASS 的检查必须实际通过并绑定正确输入。机器可检查项须在创建时明确，不从任意自然语言临时猜测。没有指定检查时，Service 不伪造科学判真。

### 5.4 四种 finish 结果

| 请求 | 使用场景 | 安全解绑后的 Task 状态 |
|---|---|---|
| `finish --outcome done` | 原合同已满足 | done |
| `finish --outcome incomplete --reason ...` | 未完成，但无新明确前置要等待；后继可接着做 | 依据全部已持久依赖计算 ready/blocked |
| `finish --outcome blocked --wait-for T2 --reason ...` | 新发现必须先完成的 Task | 记录依赖，依据实际状态 blocked/ready |
| `finish --outcome cancelled --reason ... [--replacement T3]` | 责任应撤回或由新合同替代 | cancelled |

准备结束时先尝试 save/publish、确认外部结果，再按真实责任 finish。没有新成果也能如实 blocked/cancelled/incomplete，不为退出创建空材料。blocked 必须有可检查的 Task 前置，不能只写不可判定的自由文本等待条件；服务短暂故障按运行层有界重试处理，不伪造研究 Task。

保存或发布失败只影响可交接成果，不能把已确认的等待关系抹去：仍需等待明确前置时使用 blocked，责任确已撤回时使用 cancelled，未完成且没有新前置时才使用 incomplete。结束记录如实说明未持久内容无法接续，不要求为记录阻塞先成功发布 Material。

finish 的结束意图、动态等待/替代信息、request 与 E closing 同时持久受理。受理后拒绝新贡献，Runtime 独立完成全进程停止和条件解绑；连接断开不等于失败。Bot 不在 finish 后再上传或修改文件。

软收尾窗口仍允许保存已有增量、发布内容和 finish；硬停止只承认已持久成果。阈值来自有限运行配置，不把示例次数或百分比写死为算法。

### 5.5 与 Mission 提交的关系

Mission 最终检查使用 [01](01-model-and-runtime.md) 的 submit 合同，允许有效 Mission 协调身份提交，不要求先 take 一项虚构“提交 Task”。当前 E 若确实承担验收工作，也可记录为来源。

submit 与 finish 各自有明确持久受理点。已受理的最终检查不因提交 Bot 随后 finish 而丢失；尚未受理且 Bot 已退出的请求被拒绝。Mission PASS 后，运行层按正常收尾停止未完成工作，保留 Task 实际状态，不能批量把它们标 done。

## 6. 验证与迁移入口

目标合同至少通过以下公开流程验收：

- 零 Task 启动、相关状态列表/分页、并发提案与单 owner take；
- Goal/Deliverable/Completion 不可被 finish 或依赖修复改变；
- 执行中提出 T2，T1 原子 finish blocked，T2 done 后 T1 可由新 Bot 接续；
- 初始依赖与运行依赖共同构成环时拒绝；
- 前置 E 失败不解除等待，前置 cancelled 不算 done；
- cancelled 前置的并发 replace 使用关系版本检查，不丢其他依赖；
- 责任变化后旧 Task 明确 cancelled，不反复重新认领；replacement 不自动满足下游；
- 同 E 显式 apply 与初始输入审计并存，保存后的文件可在原 sandbox 删除后读取；
- soft grace 成功保存，finish 后贡献拒绝，硬停止不伪造交接；
- 无 E 的正常 bot exit、Mission submit 和费用仍可追踪。

[07](07-validation-and-research.md) 定义工程/研究证据层级，[08](08-architecture-migration.md) 维护实现迁移。此章描述目标合同，不依据当前代码是否已实现来判定设计是否成立。
