# SwarmEnv：开发约束与设计准则

状态：PR #110 的设计草案，包含用户对共享 Mission、取消任务配额和简化接续的最新修正。合并后确立第一阶段规范，不表示运行代码已满足要求。实际差距见 [实现状态](docs/implementation-status.md)。本次只更新文档；代码修复、真实实验和正式 Issue 发布按后续授权进行。

## 阅读顺序与规范效力

先读本文件、[术语表](GLOSSARY.md)、[目标架构](docs/architecture.md)、[Agent Task 运行契约](docs/20261102-agent-task-runtime-contract.md)，再读[第一阶段计划](docs/plans/phase-1/README.md)和相关代码。`CONTEXT.md` 只作导航。

本文件定义约束，运行契约给出接口和状态细节，架构文档解释整体流程；三者必须一致。Issue 细化交付与验收，不能默默覆盖原则。冲突需要显式设计变更，不能选择更符合旧代码的文件。归档、旧 Issues、历史实验和 Notion 是来源或证据，不构成第二套当前规范。既有实验事实不随新设计改写。

## 核心设计准则

**P1 — 共同目标与独立分工分开。** Mission 保存共同目标、原始验收条件和运行资源范围。共享 Mission Task 表达所有 Agent 可以继续推进的整体工作，允许多个 Execution，不设额外的任务级并行上限；实际并发仍受配置的 Core/模型容量和总预算约束。独立子任务有明确交付边界，通常只允许一个有效执行者。这里的子任务只是分工，不恢复父级审批树。创建关系不授予管理权。

**P2 — 研究方向由 Agent 提出。** 默认只登记用户目标、共享 Mission Task 和初始材料，不预设几何、组合等路线，不按题号写入策略，不要求创建固定数量的任务。Agent 可以继续共同问题的研究，无须先制造一项子任务。有真正独立的工作时才登记子任务。通用工具说明、原题要求和资源边界可以固定，测试 fixture 的预设工作不得进入真实默认路径。

**P3 — Agent 主动认领，Runtime 负责运行。** identity 在自己的 Core lane 内调用 task_take，取得 Task 的 Workspace、上下文和有效 Execution；不申请第二个 Core，不通过独立 Selection Session 替 Agent 作决定。一个 identity 同时只有一个有效 Execution，但可连续承担不同任务。没有普通子任务可做时，继续共享 Mission Task，而非因队列空而退休。短暂发现/切换开销仍计入 Mission 预算；不允许长时间无归属研究。

**P4 — Judge 是可迭代调用的工具能力。** 当前 Execution 可检查 V1、读取诊断、修改并检查 V2。失败不自动创建 Task、不强制 handoff、不要求消费其他 Task 的 Response。工具内部保存不可变输入与结果，调用者不必完成额外任务流程。日常检查权限不由完成合同是否要求 Judge 决定。

**P5 — 局部结果不替代最终验收。** 原题完成须核对原始命题、实际内容版本和固定检查环境。局部 PASS、普通 Task 完成或一个 Mission Execution 结束，不表示 Mission 完成。任何有权限的执行者均可提交完整候选，不以初始 Task/identity 身份排除。不得修改原题、放宽 checker、借用旧 PASS、隐藏失败或混淆服务故障与数学失败。

**P6 — 派生、保存、交接各有含义。** 创建子任务不结束创建者的 Execution。Checkpoint 保存进度并继续执行。普通子任务 handoff 后仍未完成，回到 OPEN；释放的是当前执行绑定，不是任务名额。共享 Mission 中某个 Execution 交接只结束它自己的执行权，不改变其他参与者；仍有执行者时共享 Task 可保持 RUNNING 且可继续认领。

**P7 — 本阶段不引入任务数量上限。** 删除累计动态新增限制，也不换成在制上限、OPEN 队列上限、N–2N 下限或任务名额回收机制。任务计数仅用于观察。保留全运行预算、模型/Core 并发容量、工具超时和单次 Execution 时间盒；消耗跨 Task 接续累计。identity 最多完成三次 compaction；第三次后可以继续，待当前上下文 token 占模型窗口比例再次达到80%时 handoff 并更换 identity，禁止第四次 compaction。3和80%是本轮明确默认参数，实验记录实际值；具体异常处理见运行契约。

**P8 — 反馈与权限必须对应具体执行。** 研究反馈属于 Task，跨 Execution 保留；截止提醒仅针对原 Execution。共享 Mission 的多个执行者分别接收和处理适用于自己的反馈，一个人的已读/处理不得替其他人确认。同伴提出证据或建议，不获得取消他人或整个 Mission 的权力。范围变化保存理由及版本/后续任务关联。撤销一个 Execution 只使它的旧写入失效，不误伤其他 Mission 执行者。

**P9 — Material 可复用，保存机制保持简单。** 内容保留生产 Task/Execution、来源和版本；引用用途、不同接收者的决定分别记录。Progress Material 同时用于 checkpoint/handoff，文件工作引用 Runtime 管理的本地 Git commit；文本研究不要求虚构 Workspace。保存失败允许丢弃本次未保存状态并结束旧执行，不无限等待、不假报保存成功，也不删除此前有效 Material/commit。正常路径必须用真实测试证明可靠接续。

**P10 — 权威状态一致，私有工作面隔离。** Agent、Task Service、Runtime 和报告使用相同身份与状态。task_take 复用调用者 lane，准备失败撤销未生效绑定；不能把数据库与 Git/进程操作假定为一个事务。相同请求重放幂等，同键不同请求显式报冲突；筛选、分页和计数如实表达。每个 Execution 使用独立可写 worktree，共享 Mission 不共享可变目录或可任意覆盖的全局最新 commit。受支持部署端到端一致，不支持组合启动前拒绝。

**P11 — 按准则审计，并逐项验收。** 用户举例和旧问题表不是范围上限。沿工具说明、Bridge/SDK、权威服务、Runtime、runner、配置、分析与测试检查同类偏差；确定问题纳入相应 Issue，未复现风险如实标明。每项实现必须映射到[可观察行为](docs/validation/20261102-phase-1-behavior-acceptance.md)、反例和证据，不能以一个总体利用率掩盖未实现功能。

## 第一阶段范围

仅安排 [S1–S3](docs/plans/phase-1/README.md)，继续现有数学、PutnamBench 和 Lean 环境。S1完成直接检查；S2完成共享 Mission、主动分工和最小可用的 Git/Progress 保存接续；S3完成执行中反馈、compaction 轮换和异常接续。S2不以尚属S3的自动轮换作为关闭前提。

不做任务配额系统、价值评分、语义去重算法、向量检索、全局共识、复杂调度、分布式快照事务、跨Task自动Git合并、万级部署或prompt搜索。删除错误API指令、提供真实接口帮助和必要的checkpoint提醒属于一致性修复；寻找更好的措辞、解题示例和研究策略属于后续优化。

Git快照仅用于实验工作面接续，不修改或推送项目主分支。文件选集与敏感排除必须明确，保存失败采用有界尝试和明确的丢失记录，不增加通用事务框架。每个新接口必须说明其可观察效果，不借修复扩大抽象层。

## 开发与验收

代码Issue在独立worktree/分支实现，main不直接开发。每项交付完整行为及对应测试/报告，不按数据库、API、测试拆半成品。可以在一个Issue内分步提交，但真实验收针对完整clean实现。

每项同时通过符合性回归和[两小时真实验收](docs/validation/phase-1-acceptance.md)。实验前登记对照、处理、模型/工具版本、资源、主要改善现象与判定规则。每项功能逐行给证据；正常研究行为在真实Agent中验证，罕见失败用受控集成/故障测试，不要求同一次两小时偶然覆盖全部。未触发就标未覆盖，不能用零错误当通过。

共同Mission的多Execution并行与不同子任务的分工并行分别报告；前者不能冒充后者。模型调用、选择/切换、协调、保存、恢复和Judge成本均进入账目，未知项不补零。生产prompt不得包含验收数量指令，不刷任务、检查、材料或反馈。

PR分别审查Spec和Standards；撤销旧行为时更新相关旧测试，保留身份、fencing、checker绑定和隐私保护。文档PR只验文档，不宣称真实效果。代码实现运行适用测试、npm test和git diff --check，未运行的检查说明原因。不合并PR、发布/关闭Issues或启动付费实验，除非当前授权包含该操作。

## 实验与数据保护

运行前probe并锁定clean实现提交、fixture/Lean/Mathlib、provider/model、提示与工具schema、Core数、资源和命令。环境未就绪记BLOCKED，不静默替换模型。已有代码未实现的新设计必须在状态表中注明。

.env仅从授权checkout复制到忽略位置或使用进程环境，不输出值。原始对话、证明/候选源码、stdout/stderr和状态库保存在本地忽略的experiments/，公开只发布脱敏证据。运行快照的Git库留在本地，不把原始对话、凭据或私人写作语料提交到项目仓库。

Runtime有序发送初始与后续消息，不并发启动相互竞争的Agent turn。证据绑定实际运行提交，区分自然研究、受控干预、确定性fixture与静态检查。历史结果不改写。
