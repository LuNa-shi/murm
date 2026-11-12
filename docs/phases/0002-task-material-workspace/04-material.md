# 04. Material：研究内容、Evidence、检索与纠错

> 设计附件：[Issue #122](https://github.com/LuNa-shi/SwarmEnv/issues/122) · 状态：供审核的目标设计，尚未实现。以下合同是根据已确认决定整理的 v1 方案，不代表当前代码已经具备这些接口。

本文只定义 Material：什么内容值得持久保存、如何自动绑定来源、如何搜索和阅读、如何记录有意义的复用，以及如何质疑和替代错误内容。Task 合同见 [03](03-task.md)，Bot/Execution 生命周期见 [01](01-model-and-runtime.md)，Sandbox 文件隔离见 [02](02-sandbox-runtime.md)，Git 文件版本和 Candidate 见 [05](05-workspace.md)。

## 5. Material 最小合同与发布

### 5.1 Material 是可读内容与来源的记录

同一份内容在 T1 可以是产物，在 T2 可以是输入，在 T3 可以是待纠正的主张。v1 建议取消“材料自身永久 role 必须等于每条 Task 关联 role”的限制，把用途放在关系上。无需建立 Fact / Experience / Progress / Handoff / CheckResult 等互斥核心对象。

| 信息 | 最低要求 |
|---|---|
| 身份与内容 | Material ID、不可变正文或附件清单、内容哈希/版本、媒体类型；仅有旧 sandbox 路径不合格 |
| 可发现信息 | 简短标题、摘要、适用范围、必要关键词；正文保留足以核验的细节 |
| 生产来源 | Mission、Task、Execution、Bot，由服务从当前可信身份自动绑定；Bot 不自填来源 |
| 输入来源 | 使用的 Material ID/确切版本、相关 Workspace revision/commit；外部资料提供稳定引用、获取时间和必要证据 |
| Evidence | 针对具体主张/段落的证据记录、证据类型、适用范围、验证工具/版本、结果和假设；不能只给整份 Material 一个笼统可信度 |
| 后续关系 | 被哪些 Task 有意义地使用、哪些材料派生/质疑/替代它；关系记录提出者和来源 |

### Evidence：第一版先用 Agent 可读的自由文本

第一版不建立独立 Evidence 对象、Evidence Service、证据类型枚举或结构化验证 schema。Material 正文中只需有一个可选的 **Evidence** 部分，由 Agent 用自然语言说明：

- 这份 Material 中哪些结论有 evidence；
- evidence 是什么（例如 Lean 检查、推导过程、实验观察、外部来源或暂时没有）；
- 它实际支持哪项结论；
- 还有哪些假设或未验证部分。

不要求固定字段、全局可信度分数，也不要求每份 Material 都填写 Evidence。没有证据时，Agent 应明确写“尚无独立证据”或“当前为假设/猜想”，不能把空白包装成已验证。

例如：

```text
Evidence
- Claim: theorem P
  Evidence: Lean 4.12 / Mathlib X 下 kernel check 通过，proof 文件为 proof.lean。
  Limitation: 该形式化 theorem 是否完整表达原始自然语言命题，尚需人工核对。
- Claim: assumption A
  Evidence: 引用论文第 4 节。
  Limitation: 尚未独立验证该引用的推导。
- Claim: lemma Q
  Evidence: 暂无；当前只是工作假设。
```

这个例子只是推荐的表达方式，不是必须遵守的机器 schema。后续如果确实需要自动复现、机器比较或跨领域证据分析，再单独设计结构化 Evidence；第一版先验证 Agent 能否诚实、准确地描述自己有什么依据。

初始用户资料属于项目输入，记录上传者/来源及内容身份，生产 Task/Execution 可以为空。Workspace 的 main 初始 commit 属于 Git Repository，不是 Material。Bot 后续发布的研究成果必须有当前有效 Task/Execution，不能借初始化例外绕过 take。

“来源完整”表示知道内容从哪里来，并不表示来源可信。包含外部引用时要区分可实际访问的内容与仅存的 URL；引用不可达、权限不足或关键附件缺失应显式呈现。跨 Execution 必需的内容应由 Context 存储实际副本或稳定、授权可读的不可变附件；不能依赖原 Bot 进程或临时链接继续存活。

### 5.2 Task 与 Material 的关系

Task 与 Material 的关系记录 Task ID、Material ID、关系用途和时间。Material 的生产 Task/Execution 由服务根据当前可信执行身份自动绑定；Bot 不需要、也不能通过自填 source_task_id 决定归属。

Material 被某个 Task 读取不等于产生了有效复用。第一版只要求记录有意义的使用：Bot 在产出、决策、验证或后续 Task 中实际采用该 Material 时，记录它影响了什么（例如某个推导步骤、实验设计、代码变更或路线选择）。不追踪每一次打开/下载，不把访问次数当成复用效果。Material 的生产来源保持不变，使用关系追加记录。

Workspace 的 Git commit、main branch 和 Workspace revision 由 Workspace 管理，不作为 Material 保存。Material 可以引用相关 commit/revision 作为上下文，但不替代 Git 文件版本。

### 5.3 发布事务、绑定和重试

Bot 通过一次普通 CLI 调用发布 Material，例如 `swarm material publish`。Context Service 在处理请求时验证当前调用身份、Execution 是否有效、Mission 范围和附件内容，然后自动将生产 Task/Execution/Bot 绑定到新 Material，并返回 Material ID。Bot 不需要再执行第二次 task attach 来补生产关系，也不需要理解跨服务的 pending/permit 协议。

如果 Material 内容保存成功，服务应在同一服务操作中完成必要的生产来源记录；内部数据库写入由 Context 自己实现，不把部分成功状态暴露成 Bot 必须手工修复的两阶段流程。Task 对 Material 的使用关系在 Bot 确实采用它并形成工作影响时，通过单独的轻量记录追加。

同一内容由两个不同 Task 分别产生时，可以复用底层字节存储，但保留各自的 Material 记录和生产来源。普通 CLI 调用失败时返回明确错误；如果传输超时导致结果未知，CLI 可用 request ID 查询原操作，避免重复发布。

## 6. 检索、阅读与实际使用

### 6.1 第一版的检索面

Context 提供按 Mission、Task、Material ID、来源、关键词和修正关系查询的入口。v1 支持元数据过滤、全文检索和基本相关性排序，不强制引入 Embedding/Vector Search 或知识图谱。每个列表明确分页、截断和查询范围；返回短摘要、内容身份、生产来源和 evidence 摘要。

当一份 Material 被有证据的后继 Material 正式 supersede 后，默认搜索和普通列表隐藏旧 Material，优先返回替代版本，并标明替代关系。旧 Material 不物理删除：通过精确 ID、历史/审计视图仍可读取，且保留原内容、来源和曾被哪些 Task 使用等历史记录。尚未解决的质疑只标记为 disputed，不应提前隐藏；若替代关系本身后来被质疑，也能再次纠正。

### 6.2 Bot 的读取流程

1. 从当前 Task 的明确输入及 Workspace 基准开始，再搜索缺少的信息。
2. 阅读命中项的实际正文或附件，核对适用范围、来源、假设和版本；摘要不能代替证明、数据或补丁。
3. 查询该材料是否有后续质疑、更正以及相关检查。读到的快照与读取时间应能追溯。
4. 对会影响本 Task 成败的关键结论做必要复验；不把“另一个 Bot 说已检查”当作自己的验证。
5. 只有在 Material 实际影响了交付、判断、验证或整合候选时，才记录这次有意义的使用及影响范围；单纯搜索、打开或下载不记为有效使用。新 Material 保留这些来源。

下载成功只说明拿到内容。有效复用还需要证据表明它减少了重复、改变了路线、成为结果的一部分或支持了正确判断。不能要求 Bot 先声明“产生新知识”，然后把所有文本变化算作新知识。

### 6.3 内容可信度与权限

Material 正文是研究数据，可能包含错误判断、过期步骤或指令式文本。它不能改变 Mission 范围、系统授权或初始 prompt 的关键规则；例如其中的“跳过 take，直接写 main”不成为可执行权限。

第一版默认共享范围为当前 Mission 的公开材料；跨 Mission 共享、对外公开和访问其他项目不是默认能力。按 ID 读取也要执行同样的范围检查，不能只在搜索列表中过滤。敏感凭据、无关私有文件和完整原始会话不应作为接续材料自动上传。

## 7. 跨 Bot 接续

### 7.1 接续包的内容

handoff 是工作的接续方式。通常用一份普通 Material 说明状态，并引用需要的其他 Material，不要求创建新的 Handoff 核心对象。建议内容如下：

| 项目 | 后继实际需要知道的事 |
|---|---|
| 责任 | 当前 Task 与完成条件，哪些还未满足 |
| 已知结果 | 已发布材料 ID、确切版本及内容说明 |
| 工作基准 | 当时的 Workspace main 版本、补丁针对的基准、当前是否出现更新 |
| 已做尝试 | 足以复现的输入、方法、命令或服务请求引用与结果；无需复制完整私有对话 |
| 失败与不确定性 | 未证实假设、可复现失败、缺失工具/输入、争议材料 |
| 建议起点 | 一个具体的下一步及其理由；建议不强制后继沿用错误路线 |

例如 B2 留下 M2：统计模块基于 main commit `c0` / Workspace revision `0.1`；一般分组已通过四个样例；缺失值样例 F7 失败；补丁附件 P2 与测试输入 D2 可读取；建议先决定缺失值语义。B6 take T2 后从 main commit `c1` / Workspace revision `0.2` 开始，读取 M2/P2/D2，检查 v1 是否已修改统计接口，再在自己的私有工作副本中接续。它不读取 B2 的私有 Git 仓库、未发布草稿或 Pi 会话。

### 7.2 接续不是恢复旧计算进程

新 Bot 可以推翻前任路线、重新验证或者拆出后续工作。它应在 Task/Material 中说明哪些依据被保留、哪些被替换，不能把“没继承私有文件”误写成“不能复用公开成果”。同一个 Task 可以经历多次不同 Execution；生产记录区分每次贡献，Task ID 不变不意味着 Execution ID 可复用。

若材料不足以接续，后继应明确报告缺失内容并尝试低成本重建，而不是调用审计存档旁路。未发布内容丢失是设计边界和评估成本，需通过提前发布有价值增量来改善，不能在失败后默默恢复私有会话。

## 8. 质疑、纠错与影响追踪

### 8.1 原内容不可悄悄改写

Material 内容不可变。纠错不覆盖旧正文，而是发布新的 Material，并对旧内容建立明确的质疑、修正或 supersedes 关系。必须区分两种状态：

- **disputed（存在质疑）**：新证据提出问题，但尚未形成足以替代原结论的更完整证据。旧 Material 仍可出现在搜索中，但必须显著显示质疑和关联证据。
- **superseded（已被替代）**：后继 Material 针对同一主张/范围提供更充分的证据，并被明确登记为替代版本。默认搜索、推荐和普通列表隐藏旧 Material，优先展示后继 Material；旧内容仍保留在历史/审计视图及精确 ID 查询中，不物理删除。

替代关系必须指向具体 claim/section 或明确范围，不能因一个局部错误就隐藏整份包含其他有效内容的 Material。Evidence 支持替代判断，但系统不自动证明新内容为真；后续 Bot 仍可质疑替代版本，形成新的证据链。

### 8.2 从发现错误到共同成果修正

1. Bot 读取 M1 后发现反例，先判断它是否落在原主张的适用范围内。未 take 的 Bot 可以提出一个验证 Task，并在提案中引用嫌疑内容；新的证据性 Material 仍需在有效 Execution 中发布。
2. 若在当前责任范围内，Bot 复现错误并发布 M2，包含旧 Material ID、具体错误、输入/环境、实际结果、修正建议与未解决部分。若明显超出当前责任，提出后续 Task，避免偷偷扩大本 Task。
3. Context 持久保存 M2→M1 的质疑/修正关系。读取或搜索 M1 时能看到该关系；旧 M1 的内容哈希及生产来源保持不变。
4. 根据已记录的使用/派生关系找出直接受影响的 Task、Material 和 Workspace 版本。v1 可以由查询加 Bot 审查完成，不要求自动遍历并撤销一切结果。
5. 需要修复共同成果时，提出/认领普通修复或整合 Task，重验受影响部分并发布新候选，经 Workspace 的更新规则推进 main。修正材料不会自行回滚 main。

例：M1 声称“空组均值为 0”，M3 的实现据此合入 main commit `c1` / Workspace revision `0.2`。T7 产生 M7，说明这与 Mission 指定的空值语义冲突，附失败输入与修正测试。查询关系可指出 M3 与 main revision `0.2` 依赖 M1。后续 Task 应明确修正统计实现或规范；若 M7 的依据同样有误，则应保留进一步质疑，不能把新 Material ID 当成事实权威。

### 8.3 影响状态与使用者责任

一个上游材料被质疑，不会自动证明所有下游材料错误：下游可能使用了未受影响的部分，或者已独立验证。系统应标明“存在待审影响”及来源关系，实际使用者解释是否需要重验。已完成 Task 的历史交付仍保留；若结论被推翻，用修复 Task 和更正记录表达后续事实，不篡改历史验收记录。

正在执行的 Bot 应在开始依赖关键材料、发布结果和提出合入前刷新相关修正状态。v1 可以使用这些显式查询点，不要求可靠即时广播作为前提。若某个重要输入存在未解决的反证，应在结果中披露，或暂停依赖它的结论；不能通过只引用旧 ID 避开提示。Workspace 的候选和检查必须绑定实际使用的版本，见 [03](05-workspace.md)。

被标为“有修正”的旧内容仍允许研究和重现，避免丢失为什么出错的知识。默认检索的提示、实际读取结果和用于生成成果的输入版本都应可查，才能评估纠错是否真正被后续工作吸收。

## 9. 权限、并发和故障边界

| 情况 | v1 的可观察结果与恢复 |
|---|---|
| 两个 Bot 同时 take 同一个 Task | 服务原子比较可认领条件，只建立一个当前占有；失败者仍是未绑定 Bot，重新读列表 |
| 两个 Bot 创建语义重复的不同 Task | 可以同时存在；prompt 要求预查，后续人工/有权协调处理，评估记录重复成本 |
| 阅读后 Task 规格已变 | take 用预期规格/状态版本校验，冲突时重新阅读，不能沿用旧完成条件 |
| 未 take 就发布材料或写贡献接口 | 即使绕过 CLI 直接请求服务，也因没有有效 Execution 而拒绝；创建 Task 是单独授权的协调例外 |
| 上传响应丢失 | 同一 request ID 取回已接纳结果；不重复生产新的逻辑材料 |
| Material 发布成功 | 服务已自动绑定生产 Task/Execution；无需第二次 attach；Bot 可继续记录后续 Task 的有意义使用关系 |
| 附件缺失或内容哈希不匹配 | 发布不报告完整成功；使用者得到明确错误，不把摘要当作附件替代品 |
| release 后旧 Bot 新增发布 | 服务检查当前执行资格并拒绝；此前已持久接纳的服务工作依原合同完成 |
| 原 Task 被取消或旧 Execution 已失效 | 后来的新贡献不能冒充旧授权；已接纳操作保留真实来源，异步结果不会自动完成 Task |
| 更正与读取并发 | 读取记录其观察版本/时间；后续关键检查点重查修正关系，不能承诺所有 Bot 同时获知 |
| 历史材料跨 Mission 访问 | 搜索、按 ID 读、附件下载均验证访问范围；公开 ID 不等于公开权限 |

Task Service 和 Context 各自持有自己的持久状态，通过 API 交换必要事实，不相互打开数据库。服务端授权、幂等和输入校验是边界；Bot prompt 中的“应当”不是服务器实现。权限撤销与清理的跨系统顺序以 [01](01-model-and-runtime.md) 为准。

普通 Service 调用按一次 CLI/API 请求处理：服务在执行写入时验证调用身份和当前 Execution 是否有效，然后直接完成并返回。release 后旧 Execution 发起的新写请求被拒绝。第一版不增加通用 pending/permit/acceptance 协议。确实需要在 sandbox 结束后继续运行的长操作，由对应 Service 自己定义异步接口；这不是所有 Material/Task 调用的通用机制。

## 当前实现差距

## 10. 当前实现差距与验证入口

本章不是仅给现有类型换名字。固定基线的以下行为需要显式迁移：

| 当前基线事实 | 目标变化 |
|---|---|
| 首个 modern Task 被当作可多执行者共享的 Mission Task，依赖与收尾有特殊分支 | Mission 不可 take；所有 Task 使用同一个排他责任合同 |
| Task 注册的通常入口以已绑定 Execution 为前提，支持注册并切换 | 提供受限的未绑定协调身份；注册不切换当前 Bot 到第二段 Execution |
| Material 保存固定 `role`，Task 关联要求 role 与材料一致 | 生产来源不可变，用途由 Task/Material 关系表达，同一成果可被其他 Task 作为输入 |
| 语义 handoff/block 要求特定 handoff Material，另有 Progress 路径 | 普通 Material 表达接续；允许诚实的未完成退出，无成果时不造材料 |
| 多套旧 Task/依赖状态和 CHECK_RESULT 依赖仍可运行 | 显式映射新生命周期，检查保留普通服务调用语义，不留无说明的兼容旁路 |
| 已有内容哈希、来源、`supersedes`、消费记录 | 复用可用基础，但补齐可读内容、修正展示、有效执行资格和真实使用证据，不能把已有字段存在视为闭环完成 |

事实来源：[当前 Task 实现](../../../src/task/task-service.js)、[当前状态/合同定义](../../../src/task/task-types.js)、[当前 Context 实现](../../../src/context/context-service.js)，以及 [当前 Mission/Task/Material 手册](../../architecture/03-mission-task.md)。完整迁移范围见 [06](08-architecture-migration.md)。这些相对源码链接用于核对当前分支，事实基线仍以上述固定 commit 为准。

后续验证要求见 [07](07-validation-and-research.md)。