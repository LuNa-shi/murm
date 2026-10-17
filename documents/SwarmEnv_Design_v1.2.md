# SwarmEnv 设计方案 v1.2

## 面向长时程、可验证 Agent Swarm 的最小公共运行环境

版本：v1.2  
日期：2026-10-17  
文档性质：完整、独立、可直接用于架构评审和 MVP 实现

## 0. 设计范围与核心主张

SwarmEnv 是一个围绕完整长时程任务建立的公共运行环境。根 Task 保存用户交给系统的完整目标，Agent Core 负责提出和执行局部行动，Runtime 负责让任务在执行者退出后仍然能够等待、恢复和接续，Context Service 负责保存不同可信度的公共材料，Judge 或其他 Domain Service 负责提供完成判断所需的检查依据。

系统面向这样的任务：目标不能一次性完整规划，局部工作需要跨多个 Agent 和多个时间段复用，执行者可能崩溃或被替换，外部服务可能延迟或重复返回，最终结果必须经过独立检查。系统首先保证任务责任、执行责任、公共材料和完成依据能够稳定衔接；任务选择、Context 检索、模型策略和资源调度可以在这个基础上独立优化。

v1.2 只把四个概念作为核心持久对象：Task、Execution、Material 和 CheckResult。它们分别回答四个不可替代的问题：系统要完成什么，当前由谁执行，公共环境中留下了什么，凭什么认为结果成立。Agent Core、Runtime、Context Service 和 Judge 是角色或模块；Workspace、Checkpoint、Input Snapshot、Lease、Generation、Event 和 Service Call 是字段或内部机制。只有当后续系统出现新的独立生命周期或明确的一对多扩展需求时，才把这些机制提取成新的公共对象。

v1 的物理部署边界是单机、多进程、单 Runtime，所有 Task 的 parallel_quota 固定为 1。这个限制用于降低第一阶段的部署复杂度，不降低系统对崩溃、等待、恢复、重复提交、迟到结果和权限边界的要求。第一阶段要证明的是公共运行语义，而不是在一开始解决所有多机运维问题。

## 1. 系统模型：根 Task、子 Task 和四个核心对象

### 1.1 根 Task 表示完整数学问题

第一条证明任务不是一个局部引理，而是用户交给系统的完整数学问题。假设用户要求证明费马大定理，系统首先登记一个根 Task。这个根 Task 保存完整目标、用户给定的定理陈述、定义、允许使用的公理、初始 Proof State、已有材料以及最终完成条件。它代表从用户问题到最终可验证证明的全过程，因此不能因为某个 Agent 暂时退出、某个子任务完成或某条路线失败就自动结束。

根 Task 的当前执行者会根据证明状态和公共材料提出子 Task。子 Task 可以处理局部引理、未满足条件、反例排查、定义一致性检查或证明编织。它们承担根问题中的局部责任，结果通过支持关系、依赖关系或等待关系返回根 Task。子 Task 的完成只表示根问题多了一份可能有用的依据；只有整合后的整体证明对象覆盖根目标，并在固定假设、版本和检查规则下通过最终检查，根 Task 才能进入 SATISFIED。

从完整语义上看，Task 之间可以有父子、支持、依赖和编织关系。父子关系表示某个局部责任由哪个上层目标产生，支持关系表示成果可能帮助另一个任务，依赖关系表示工作必须等待另一项工作，编织关系表示多个局部成果需要组合。但为了让 v1 的实现边界明确，MVP 只把严格的 parent-child 树作为可调度关系：`required_children` 和 `child_task_terminal` 只能引用当前 Task 的直接子 Task，子 Task 再逐层管理自己的直接子 Task。support、跨树 dependency 和 weaving 在第一版只作为材料引用或任务元数据记录，不参与阻塞、唤醒、认领或其他调度动作。create_child_task 必须使用 operation_id 或显式幂等键，禁止环、重复的同一子任务、无限扇出和超过 max_depth 的任务树。这样保留了未来扩展的语义入口，同时避免第一版一开始就实现通用图调度器。

### 1.2 Task：长期存在的目标和责任

Task 是系统中拥有任务语义真值的对象。它至少包含 task_id、root_id、parent_id、owner_ref、task_type、task_type_version、目标和规格、spec_version、spec_hash、输入 Material 引用、任务关系、completion_contract、parallel_quota、state_version、max_depth、max_children、max_attempts、retry_policy、root_deadline、cancelled_at、状态、创建来源和时间信息。这些是控制边界的字段，不是新的领域对象：state_version 用于 CAS，深度、扇出、尝试次数和截止时间用于防止 swarm 无限扩张，retry_policy 用于把失败和不确定结果的处理变成可执行规则。

Task 的 completion_contract 定义什么结果可以推进任务。对于根证明任务，它可以说明最终目标、允许的 Assumption、需要覆盖的子目标或依赖、允许的环境版本，以及是否需要最终 Judge。对于 research Task，它可以规定必须交付的研究报告、材料或子任务结果，不要求 Judge。Task Flow 根据这个合同解释交付物或 CheckResult，Agent 只能提出候选和完成请求，不能直接把任务标记为完成。

MVP 不实现任意脚本化的完成合同，而是实现一个很小的可解释结构：`required_children` 只指向当前 Task 的直接子 Task，并要求它们已经满足；`required_materials` 指向必须交付的 Material；`required_check` 可选，只有在任务需要独立检查时才指定 checker_ref、checker_version、input_snapshot_hash 和 PASS verdict。完整证明或需要正式检查的代码 Artifact 可以配置 `required_check`；research Task 可以只要求交付研究报告或其他 Material，不创建 CheckResult。父 Task 通过子 Task 的完成结果逐层获得更深层任务的结果，不直接调度孙任务或跨树任务。Task Flow 根据合同评估结果，用当前 state_version 做一次 CAS 决定任务是否 SATISFIED；Agent 只能请求完成，不能用自然语言声明替代合同。

### 1.2.1 Task 类型注册表：先规定任务形状，再允许 Agent 创建

Agent 不能凭空发明一个只写着目标、没有验收方式的 Task。MVP 使用一个很小的、带版本的 Task 类型注册表。`task_type` 和 `task_type_version` 是 Task 的普通字段；注册表不是第五种领域对象，而是 Task Flow 启动时加载的配置。MVP 先固定四类 Task：

| `task_type` | Agent 必须交付 | 完成判断 | 是否需要 Judge |
|---|---|---|---|
| `default` | 由创建者明确声明的 Material、Artifact 或子 Task 结果 | 按实例的 `completion_contract` 验收；有 Parent 时默认需要父 Task `accept_task`，root 使用 owner 接受 | 否 |
| `research` | 带来源的研究报告、事实、经验或猜想，至少指定一个研究交付物 | 有 Parent 时进入 `parent_review` 并由父 Task 接受；root 使用 owner 接受 | 否，除非该实例显式增加 `required_check` |
| `proof` | 面向指定目标和环境的 proof Artifact，或者明确的候选证明 | `required_check` 的匹配 CheckResult 为 PASS | 是，MVP 默认使用本地可信 checker |
| `implementation` | 代码、文档或其他可落地 Artifact，以及声明的检查命令或验收材料 | 配置了 `required_check` 时必须 PASS；否则有 Parent 时由父 Task 按合同接受，root 使用 owner 接受 | 可选 |

`default` 是兜底类型，不是没有规则。创建者仍然必须提交局部目标、预期输出和验收条件；Task Flow 不会因为 Agent 发布了一段文本、生成了一个文件或声称“完成”就自动关闭 Task。`research`、`proof` 和 `implementation` 只是把常见的输出和完成规则预先写好，减少 Agent 每次重复描述协议。

Agent 创建子 Task 时至少提交 `parent_task_id`、`task_type`、`task_type_version`、局部目标、范围、预期输出、验收条件和 `operation_id`。Task Flow 根据类型注册表补全默认合同，并检查深度、扇出、预算、父子权限和 `required_check` 配置。MVP 不维护复杂的 allowed-child matrix，所有已注册类型都可以作为直接子 Task。提案不合格时，系统拒绝创建 Task 并返回缺失字段；Agent 不能用创建一个普通 Task 再在正文里声明“这是 proof”来绕过类型注册表。针对同一责任继续修改时使用 `request_rework`；发现需要另一份独立责任时，父 Task 的执行者才使用 `create_child_task` 创建新的直接子 Task。

Task 的 spec_version 和 spec_hash 在 v1 中是 Task 的字段，不单独建立 TaskVersion 对象。每次创建 Execution 时，系统冻结它所依据的规格版本和哈希。目标或输入规则发生修订时，Task 版本递增，旧 Execution 的写入必须被拒绝或标记为需要重新检查。只有未来需要同时维护大量历史版本、跨版本依赖和复杂回溯时，才把版本抽成独立对象。

Task 的 parallel_quota 表示同一个 Task 同时允许的有效 Execution 数。v1 固定为 1，因此同一个 task_id 在任意时刻只有一个有效的逻辑执行责任。这个限制只针对同一个 Task，不限制兄弟子 Task 并行。根 Task 可以拥有一个 active Execution，同时让多个子 Task 各自拥有一个 active Execution。

### 1.3 Execution：一次可替换的执行责任

Execution 表示某个 Task 的一次认领和执行尝试。它至少包含 execution_id、task_id、owner 或 agent_ref、状态、state_version、attempt_no、fencing_version、runtime_generation、lease_expires_at、heartbeat_at、launch_token、冻结的 spec_version、initial_context_ref、input_material_refs、input_snapshot_hash、workspace_ref、workspace_revision、checkpoint_ref、checkpoint_hash、instruction_version、steer_material_refs、wait_condition、wait_deadline、resume_token、已产生的 Material 引用以及创建和更新时间。state_version 用于状态 CAS，runtime_generation 用于区分 Runtime 重启前后的运行世代，heartbeat_at 和 lease_expires_at 用于回收悬挂执行，launch_token 用于把数据库记录和实际启动的进程绑定。

Execution 合并了任务执行中最必要的语义。它说明当前是谁在负责、当前执行是否有效、这段执行使用了什么输入、在原 workspace 和 context 上次工作到哪里、如果等待或崩溃应当从哪里恢复，以及这次执行产生了哪些材料。每个尚未终结的 Execution 都必须能从持久化的 workspace、原始 input snapshot 和 checkpoint 恢复；恢复不是重新开一个空会话。一个 Task 可以先由 Execution A 执行，等待或失败后再由 Execution B 顺序接手；Task 的目标保持不变，Execution 记录具体责任段。若因过期或 fencing 必须创建 B，B 仍然引用 A 的 workspace、context 和 checkpoint lineage。

Process 是 Runtime 内部实际启动的进程，Agent Core 是这个进程中的模型和工具循环。MVP 的 Agent Core Adapter 通过本机 `nurouter pi` 启动 Pi 的 RPC/会话模式；NuRouter 负责 provider、account、group 和 model 路由，Pi 负责模型调用、工具循环、会话和扩展。Agent Core 不直接调用模型 provider，也不能绕过 NuRouter 启动另一套 Pi。fencing_version 是 Execution 的递增字段，lease_expires_at 是 Execution 的有效期字段。v1 不把 Process、Generation、RunLease 和 ExecutionLease 分成多个面向架构的对象，因为它们暂时没有需要独立管理的领域生命周期。未来出现多机执行、多个运行段或复杂租约策略时，可以把 Execution 拆成逻辑 Attempt 和物理 Process，而不改变 Task、Material 和 CheckResult 的语义。

等待状态下，Execution 仍然保留 Task 的逻辑责任，但释放 Agent Core、Process、模型容量、Sandbox 和不必要的数据库连接。这样 parallel_quota=1 不会因为等待而允许第二个 Execution 取得同一 Task 的责任，同时物理资源可以被其他 Task 使用。等待条件满足时，Runtime 只创建一个有效的恢复机会；等待超时、取消或明确失效后，才释放逻辑责任。

父 Task 的返工也沿用这条恢复语义。父 Task 接受交付时，子 Task 的 `parent_review` 等待结束，Execution 进入 `SUCCEEDED`，Task 才能按合同进入 `SATISFIED`。父 Task 请求返工时，Task Flow 追加一个不可变的 `steer` Material，递增 `instruction_version`，保留原 `workspace_ref`、原始 `input_snapshot_hash` 和已有 checkpoint，把等待中的同一个 Execution 转为可恢复的 `CREATED`；Runtime 随后从原 checkpoint 启动它。steer 是原指令之上的增量意见，不能静默覆盖原 Task 规格，也不能降低类型注册表规定的验收条件。若原 Execution 已经 EXPIRED 或 FENCED，则创建新的 Execution，但仍沿用同一 Task、workspace、context 和 checkpoint lineage。

### 1.4 Material：公共环境中的材料和成果

Material 统一表示跨 Agent、跨 Execution 和跨时间共享的公共材料。它可以是用户给定的 Assumption、Agent 提出的 Conjecture、运行中观察到的 Experience、带来源的 Fact 或 Claim、具体的证明或代码 Artifact、失败记录、交接材料或检查结果。

Material 至少包含 material_id、kind、scope、evidence_state、payload_ref、version、source_task、source_execution、provenance、适用范围、创建时间和可选的 supersedes 引用。Material 的正文或大文件使用不可变引用，修订时创建新的 Material 版本，不原地覆盖旧内容。

kind 表示材料是什么。v1 至少支持 assumption、fact、conjecture、experience、failure、artifact、steer 和 check_result。scope 表示材料可以影响什么，至少区分 proof_relevant、operational 和 strategy。evidence_state 表示当前证据进度，可以使用 proposed、observed、checked、accepted、rejected 和 stale。

kind、scope 和 evidence_state 必须分开。经验即使被反复观察，也不会因此变成数学事实；猜测即使被 Agent 高度确信，也不能自动进入 Proof State；候选证明即使已经保存，也不代表它已经成立。用户给定的 Assumption 只能由受授权的输入流程修订，Agent 不能通过发布同名 fact 覆盖定理、定义或公理。

所有 Agent 都可以发布 Material。发布表示材料已经被持久保存并且具有来源，不表示它已经被证明。Context 可以保留彼此矛盾的 conjecture 和 experience，后续任务再根据来源、适用范围和检查结果选择或修订路线。Material 的 accepted 状态必须带有作用范围：对 experience，它可以表示记录已经被系统保存或调度采纳；对 proof artifact，它只能表示在特定目标、假设、输入和检查器下得到正式支持。

### 1.5 CheckResult：独立检查依据

CheckResult 表示 Judge 或 Domain Service 对候选 Material 作出的结构化判断。它至少包含 check_result_id、candidate_material_id、target_task_id、target_spec_version、input_snapshot_hash、checker_ref、checker_version、environment_ref、verdict、证据引用、status 和应用到的 Task 版本。它不是所有 Task 的必经步骤，只在 completion_contract 配置了 `required_check` 时创建和应用。

CheckResult 的 status 表示检查请求运行到了哪里，取值可以是 REQUESTED、RUNNING、RECEIVED、APPLIED、IGNORED 或 SUPERSEDED。它的 verdict 表示检查结论，取值可以是 PASS、FAIL、INCONCLUSIVE 或 ERROR。两者不能混在一个字段里，因为“检查尚未返回”和“检查已经返回但失败”对 Task 的下一步处理完全不同。

MVP 以 check_results 记录作为 CheckResult 的唯一权威真值；如果 Context Service 需要统一检索，可以异步投影一个 kind=check_result 的 Material，但该投影不能反向覆盖 check_results。每个检查请求都有唯一 request_key，至少由 candidate_material_id、checker_ref、checker_version 和 input_snapshot_hash 组成。同一 request_key 重复调用必须返回同一结果；同一 key 携带不同 payload 必须返回 CONFLICT，不能静默覆盖。

为了兼容统一检索，CheckResult 可以投影为 Material 中 kind=check_result 的一种特殊类型，但协议上必须保持其独立语义，且投影不能成为第二套真值。配置了 `required_check` 的 Task 只有在收到与候选、目标、输入快照、假设、环境和 checker 版本都匹配的 CheckResult 后，才能根据 completion_contract 推进完成状态。没有配置独立检查的 research Task 依据交付合同进入 `parent_review`，由父 Task 接受后完成；Agent 的自然语言报告、候选文件已经存在、队列为空或子 Task 成功，都不能越过合同直接关闭 Task。

## 2. 模块职责和状态所有权

Agent Core 是主动研究模块。它可以读取 Task 提供的目标和输入，提出子 Task，发布 Material，调用 Judge 或公共服务，保存 Checkpoint，申请等待并提交候选。MVP 中每个真实 Agent Core 都由 Runtime 启动本机 NuRouter 入口，再由 NuRouter 启动锁定版本的 Pi；标准启动形态使用 `nurouter pi ... -- --mode rpc`，Pi 的 session 目录和 session id 绑定到 Execution。NuRouter 的 provider、account、group、model 配置属于 Runtime/本机配置，不进入 Task、Material 或 CheckResult。Agent Core 不拥有 Task 的完成真值，不得直接修改其他 Execution 的责任，不得直接修改 Runtime 容量，也不能通过正文声明提升 Material 的 evidence_state。

Services SDK 是 Agent Core 使用公共能力的唯一客户端边界。它提供 Task/Execution 的受限读写操作和 Context Service 的 Material 读写操作，并自动携带 operation envelope、版本和 fencing 信息；它不暴露 Workspace Manager 的创建、保存、恢复或 fencing 接口。

Task Flow 是任务控制模块。它负责登记根 Task 和子 Task，保存任务关系，检查 parallel_quota，创建和结束 Execution，解释 CheckResult，维护 Task 状态，并根据完成合同决定任务继续、等待、重试、重新分解或关闭。Task Flow 不负责启动操作系统进程，也不负责解释 Artifact 的数学内容。

Runtime 是被动运行模块。它负责为 Execution 启动和停止 Process，交付输入，保存和恢复 checkpoint，管理等待、期限、物理容量和 fencing，处理 Runtime 重启和迟到结果。Runtime 维护运行状态真值，但不选择证明路线，也不把 Agent 的完成声明直接当成 Task 完成。

Context Service 负责保存 Material，提供版本化读取、发布、来源记录和输入构造。它是 Agent 之间共享信息的公共服务：Agent Core 通过 Services SDK 读取和发布 Material，但不能借此修改 Task、Execution 或 Workspace 的私有状态。Context Service 不负责 Task claim、Execution 调度、私有 Workspace 的创建保存恢复或 Judge 的数学判断。文中旧称 Context Store 指这个服务的持久化实现；服务边界统一称为 Context Service。Judge 或 Domain Service 负责根据任务类型生成 CheckResult。它提供证据，但不能直接修改 Task 的完成状态。

Initial Context、Context Service 和 Workspace Manager 需要明确区分。Initial Context 是某个 Execution 的冻结输入包，不是一个可随当前共享环境变化的查询结果。它至少包含冻结的 Task 规格、初始 prompt、选定 Material 的不可变引用和 hash、input_snapshot_hash，以及本次执行需要知道的服务和环境信息。Task Service 在创建 Execution 时确定输入边界，Context Service 按这个边界构造并持久化 manifest；后续 Context Service 新增的 Material 不会悄悄改变已有 Execution 的 Initial Context。父 Task 的返工通过追加 steer Material 更新指令版本，但不覆盖原始 Initial Context。

Workspace Manager 是 Runtime 内部的执行基础设施，不是 Agent Core 通过 Services SDK 调用的公共服务。Runtime 在启动 Execution 前让 Workspace Manager 创建或恢复该 Execution 的私有 Workspace，并把 Initial Context 和初始 prompt 写入固定位置；Runtime 在安全边界保存 Workspace revision、checkpoint 和恢复引用，在等待、崩溃接手或 Runtime 重启时根据持久引用恢复原 Workspace。Workspace Manager 必须保证不同 Execution 的可写目录隔离，并在旧 fencing 失效后阻止旧进程继续写入。Agent Core 只通过 Workspace 中的文件和工具工作，通过 Services SDK 访问 Context Service；它不能直接创建、保存、恢复或替换 Workspace。

五条关系组成系统的责任链。Agent Core 与 Task Flow 之间传递意图、候选和任务提案；Task Flow 与 Execution 之间把长期责任映射到一次可替换的运行；Runtime 通过 Workspace Manager 为 Execution 交付和恢复私有工作区，并通过 Services SDK 让 Agent 访问 Context Service；Execution 与 Context Service 之间冻结输入和产生公共材料；Material 与 Judge 之间产生检查依据；CheckResult 再回到 Task Flow，由 Task Flow 解释 completion_contract。Runtime 横切 Execution 的启动、停止、等待和恢复，但不理解证明语义；Context Service 横切 Material 的版本和检索，但不改变任务真值。

~~~mermaid
flowchart TD
    A[Agent Core]
    T[Task Flow]
    R[Runtime]
    E[Execution]
    C[Context Service]
    W[Workspace Manager]
    M[Material]
    J[Judge]
    V[CheckResult]

    A -->|提出、认领、提交候选| T
    T -->|创建、恢复、结束责任| E
    R -->|启动、停止、等待、接手| E
    R -->|创建、保存、恢复| W
    W -->|私有 workspace| E
    E -->|读取和发布| C
    C -->|版本化输入| E
    E -->|产生候选| M
    M -->|提交检查| J
    J -->|返回依据| V
    V -->|解释完成合同| T
~~~

## 3. Task 状态机

Task 的状态描述任务责任本身，而不是某个 Process 是否存活。`Task.state` 是一个简单的任务生命周期状态；Task Flow 根据有效 Execution、等待条件和 `block_reason` 更新它。状态可以使用 PROPOSED、OPEN、BLOCKED、RUNNING、WAITING、SATISFIED、FAILED、CANCELLED 和 REJECTED。

`WAITING` 和 `BLOCKED` 不在同一个语义层面。`WAITING` 表示当前 Execution 已经保存 checkpoint 和 wait_condition，仍保留 Task 的逻辑责任但释放物理资源；`BLOCKED` 表示当前没有有效 Execution 可以认领 Task，`block_reason` 记录容量、准入条件或其他阻塞原因。`block_reason` 不能与 WAITING 的 Execution 同时生效，终态 Task 也不能保留有效 Execution。MVP 仍然持久化 `Task.state` 以便查询，但状态转换必须以这些底层事实为依据。

| 当前状态 | 触发条件 | 下一状态 | 语义 |
|---|---|---|---|
| PROPOSED | 通过准入 | OPEN 或 BLOCKED | 任务已经登记，等待直接子任务条件或执行机会 |
| PROPOSED | 不满足准入 | REJECTED | 提案不会进入运行 |
| OPEN | 直接子任务条件满足且创建 Execution | RUNNING | 有效执行责任已经建立 |
| OPEN | 直接子任务条件未满足或资源暂不可用 | BLOCKED | 任务仍存在，但暂不能运行 |
| BLOCKED | 直接子任务条件或资源满足 | OPEN | 可以重新调度 |
| RUNNING | 任务需要等待子任务、父 Task 审阅、外部结果、定时器或 CheckResult | WAITING | 逻辑责任保留，物理执行资源释放 |
| RUNNING | 可恢复执行失败 | OPEN | 本次 Execution 结束，Task 可重试或重新分解 |
| RUNNING | 不可恢复失败 | FAILED | completion_contract 已经无法满足或策略决定停止 |
| RUNNING | completion_contract 已满足 | SATISFIED | 任务正式完成；是否需要 CheckResult 由合同决定 |
| WAITING | 等待条件满足且 completion_contract 已满足 | SATISFIED | 任务正式完成 |
| WAITING | 等待条件满足但仍需继续工作 | OPEN 或 RUNNING | 重新获得执行机会 |
| WAITING | 父 Task 请求返工 | OPEN | 追加 steer，原 Execution 回到可恢复的 CREATED |
| WAITING | 超时或取消 | OPEN、FAILED 或 CANCELLED | 根据策略释放逻辑责任 |
| 任意非终态 | 用户或策略取消 | CANCELLED | 不再自动恢复 |

Execution 进入 WAITING 时，Task 投影为 WAITING，且不能设置 `block_reason`；如果等待条件满足，Task 重新进入 OPEN，Runtime 再创建唯一有效的恢复机会。也可以在实现中让 Task 直接回到 RUNNING，但必须保证 Task 和 Execution 的状态关系一致。v1 推荐使用 WAITING 表示“逻辑责任仍然存在但没有物理执行”。

根 Task 的 SATISFIED 需要满足自己的 completion_contract 和完整的直接子任务完成闭包；如果合同配置了 `required_check`，还必须有匹配的最终 CheckResult。每个子 Task 的闭包由它自己的 completion_contract 递归确定。子 Task 的 SATISFIED 只表示局部合同满足，它不会自动关闭父 Task。父 Task 必须重新评估自己的 completion_contract。

## 4. Execution 状态机

Execution 的状态是一个简单的生命周期状态，不再把 claim、进程、协议阶段拆成多个 MVP 领域轴。状态可以使用 CREATED、RUNNING、WAITING、SUCCEEDED、FAILED、EXPIRED、CANCELLED、FENCED 和 SUPERSEDED。Runtime 内部可以有启动、停止和清理阶段，但这些不是公共 Execution 状态。

`WAITING` 是通用等待状态：可以等待直接子任务、父 Task 的 `parent_review`、定时器、外部结果或匹配的 CheckResult。等待原因保存在 `wait_condition`，恢复所需内容保存在 checkpoint；不为“等待 Judge”再增加 VERIFYING 状态。Execution 的终态表示这次执行责任已经结束，Task Flow 再根据 Task 的 completion_contract 决定 Task 是否 SATISFIED。

| 当前状态 | 触发条件 | 下一状态 | 语义 |
|---|---|---|---|
| CREATED | Runtime 接受并准备启动 | RUNNING | 逻辑责任已经建立，Agent 即将或已经运行 |
| CREATED | 启动准备失败 | FAILED 或 CREATED | 根据策略重试或结束本次执行 |
| RUNNING | Agent 到达安全等待点 | WAITING | 保存恢复信息并释放物理资源 |
| RUNNING | 本次执行完成 | SUCCEEDED | 执行结果已持久化，Task Flow 重新评估 Task 合同 |
| RUNNING | 候选需要独立检查 | WAITING | 以 `check_result_arrived` 作为等待条件 |
| RUNNING | 可恢复异常 | FAILED | Task 可以重新创建 Execution |
| RUNNING | lease 过期 | EXPIRED | 旧执行权失效 |
| WAITING | 条件满足并取得恢复机会 | RUNNING 或 SUCCEEDED | 恢复执行，或在合同已满足时结束 |
| WAITING | 父 Task 接受交付 | SUCCEEDED | 结束 `parent_review`，交付可以满足合同 |
| WAITING | 父 Task 请求返工 | CREATED | 追加 steer，保留同一 workspace、context 和 checkpoint 后恢复 |
| WAITING | 等待超时或取消 | EXPIRED 或 CANCELLED | 释放逻辑责任 |
| 任意旧执行段 | 新 fence 生效 | FENCED 或 SUPERSEDED | 旧写入必须被拒绝 |

Agent 不能在尚未保存 Checkpoint 和 wait_condition 时直接声称自己处于 WAITING。`request_wait` 必须把恢复信息、等待条件、Execution 状态和资源释放标记放进同一个事务，或使用一个明确可恢复的提交协议。Runtime 负责启动和释放进程，Task Flow 负责确认 WAITING 的持久语义。

v1 的 WAITING 语义是：Execution 保留 Task 的逻辑 claim，但释放 Agent Core、Process、模型容量、Sandbox 和不必要的数据库连接。等待条件满足时，Runtime 必须以幂等方式只生成一个恢复机会。重复通知不能启动第二个 Process，也不能让两个 Execution 同时占用 quota=1 的 Task。

## 5. Material 和 CheckResult 的状态语义

Material 的正文不可原地修改。新内容必须创建新 Material，并通过 supersedes、source 和 version 说明与旧材料的关系。Material 的生命周期可以简单表示为 PUBLISHED、CHECKING、ACCEPTED、REJECTED、STALE 和 RETRACTED；但具体是否进入检查流程由 kind 和 scope 决定。

Conjecture、Experience 和 Failure 可以停留在 PUBLISHED 或 OBSERVED，不需要强行送入数学检查。Artifact 可以进入 CHECKING，并在得到匹配的 CheckResult 后变成 ACCEPTED 或 REJECTED。基础输入或定义修订后，原来仍然存在的 Material 可能变成 STALE；如果材料明确被授权主体撤回，则进入 RETRACTED。撤回和失效不会删除历史内容，后续任务需要根据 scope 和证据状态决定是否还能引用。

CheckResult 使用两条独立状态轴。status 描述检查请求的投递和应用阶段，verdict 描述检查结论。REQUESTED 或 RUNNING 的 CheckResult 不能推进 Task 完成；RECEIVED 但尚未 APPLIED 的结果不能被当作已经改变任务状态；只有匹配输入、目标、版本和 checker 的 PASS 结果，才可能由 Task Flow 应用到 completion_contract。FAIL 不能自动说明命题为假，INCONCLUSIVE 不能自动说明 Agent 忽略反馈，ERROR 也不能自动等同于候选失败。

## 6. 最小端到端协议

Agent Core 通过 propose_task 提出根 Task 或子 Task。Task Flow 记录提案、检查权限和预算、读取 `task_type` 注册表、分配 task_id 和 spec_version，并根据类型补全默认 completion contract。保存提案不代表获得执行资源，也不代表 Task 已经开始运行。

Runtime 或 Agent 请求 claim。Task Flow 检查 Task 是否可运行、当前 active Execution 数是否小于 parallel_quota、直接子任务条件是否满足、规格版本是否仍然有效，并创建 Execution。v1 的 quota=1 意味着同一个 Task 不能同时有两个有效 Execution，但不同子 Task 可以并行。

Runtime 启动 Execution，冻结 input_material_refs 和 input_snapshot_hash，并把对应 Material 交给 Agent。Agent 在私有工作区中进行推理和工具调用，可以发布经验、猜测、失败记录和候选 Artifact。发布 Material 与提交 proof candidate 是两个不同的动作；前者保存公共材料，后者请求某种完成合同的检查。

Agent 提交候选后，Task Flow 先读取 completion_contract。如果合同配置了 `required_check`，Task Flow 创建或调用对应 Judge，并把等待 CheckResult 作为一个普通 wait_condition；如果合同没有配置检查，则只验证要求的 Material、子 Task 和授权完成请求。Task Flow 按合同将任务置为 SATISFIED、OPEN、BLOCKED 或 FAILED。

对于默认采用父 Task 审阅的 `default`、`research` 和 `implementation`，Agent 提交必需 Material 或 Artifact 后不能直接关闭 Task。Task Flow 把 Task 和 Execution 放入 `parent_review` 等待，父 Task 使用 `accept_task` 或 `request_rework` 作出决定。`accept_task` 让当前 Execution 结束并按合同评估 Task；`request_rework` 写入一个追加的 steer Material，保留原 workspace、原 context 和 checkpoint，并让同一个 Execution 从可恢复的 `CREATED` 状态继续。父 Task 不需要创建一个新的“返工 Task”来表达这个动作。`proof` 默认由匹配的 CheckResult 完成，但也可以在合同中增加父 Task 审阅。

如果 Agent 需要等待，先到达安全边界，再把 checkpoint_ref、wait_condition、wait_deadline 和 resume_token 写入 Execution。Runtime 在这些信息和 WAITING 状态成功持久化后释放物理容量。外部结果、子 Task 完成或定时器触发时，Runtime 重新评估 wait_condition，只生成一个恢复机会。恢复后的 Agent 读取新的 Material 和旧 Execution 的 Checkpoint，不需要依赖原来的会话记忆。

为了避免各模块各自解释任意 JSON，MVP 只支持四类 wait_condition：当前 Task 的直接子任务上的 child_task_terminal(child_task_id, target_state)、父 Task 审阅上的 parent_review(parent_task_id)、check_result_arrived(check_result_id 或 target_task_id) 和 timer(deadline)。request_wait 必须把 checkpoint、checkpoint_hash、条件、期限、Execution→WAITING 和资源释放标记放进同一个事务，或使用一个明确可恢复的提交协议；没有 checkpoint 就不能出现 WAITING。外部副作用型等待暂不进入 MVP，相关请求只能归档为 UNKNOWN 或 UNCONFIRMED，不能因为超时而自动重试。

父 Task 的 `request_rework` 也必须是幂等的公共操作。它携带 operation_id、target_task_id、target_execution_id、当前 state_version 和 steer 内容；Task Flow 在一次事务中校验父子权限、保存 steer Material、递增 instruction_version、清除 parent_review 等待、把 Task 置为 OPEN 并把同一 Execution 置为 CREATED。重复提交返回第一次的结果，旧版本或旧 fence 的返工请求被拒绝。

## 7. 崩溃、接手、迟到结果和 Runtime 重启

如果 Agent 在 RUNNING 状态崩溃，Task 仍然存在，已发布的 Material 仍然存在，Execution 的 lease 最终过期。Runtime 通过 fencing_version 使旧 owner 的写入失效，然后优先从同一 Execution 的 workspace、input snapshot 和 checkpoint 恢复；只有原 Execution 已经被标记为 EXPIRED 或 FENCED、不能安全复用时，才为 Task 创建新的 Execution。新的执行者必须重新读取冻结的规格版本和输入快照，不能直接使用不兼容的新版本材料。

如果 Agent 在 `request_wait` 的持久化事务提交之前崩溃，系统不能假设等待已经成功；lease 过期后，Runtime 需要将旧 Execution 标记为 EXPIRED 或 FAILED，再为 Task 创建新的 Execution。如果 WAITING 状态已经连同 Checkpoint、workspace_ref 和 wait_condition 持久化，则 Runtime 可以直接恢复，不需要重新猜测 Agent 原来的意图。父 Task 的返工只增加 steer 指令，不覆盖原始输入快照；恢复时 Agent 读取“原始 context + 按顺序追加的 steer”以及最新 checkpoint。

如果外部结果先于等待登记到达，Runtime 必须把结果写入持久状态或内部日志，并在等待登记完成后重新评估。结果先到不应造成丢失，也不应同时恢复两个执行者。结果应用需要检查 target_task、execution_id、spec_version、input_snapshot_hash 和 fencing_version。

如果旧 Process 在新 Execution 已经接管后恢复，它的请求必须因为旧 fencing_version 被拒绝。旧结果可以作为历史 Material 保存，但不能覆盖新的 Task 责任、Execution 状态或当前输入。取消后的 Task 不会因为迟到结果自动恢复；已经被新版本取代的 Material 不会因为旧检查结果重新变成有效。

Runtime 重启时，首先使旧运行权失效，然后读取 Task、Execution、Material 和 CheckResult 的持久状态，检查 CREATED、RUNNING、WAITING 和未确认的执行。Runtime 应该先恢复等待条件和检查请求，再发放新的物理执行资源。它不能在尚未完成对账前，直接创建新的大量 Process。

## 8. 最小事件、幂等和版本机制

Event、Outbox、Inbox 和 Router 不作为核心领域对象，但异步运行仍需要最小的持久通信语义。所有外部结果、定时器、控制请求和恢复通知至少要带有 operation_id、target_task_id、target_execution_id、事件类型、payload 引用、创建时间和状态版本。实现可以先使用 Task 状态变化、数据库轮询或一个 append-only task log，不要求第一版立刻引入完整消息系统。

重复命令和重复通知必须幂等。同一个 operation_id 重复提交时，系统返回已有结果或已有状态，不能再次创建 Execution、再次应用 CheckResult、再次释放资源或再次恢复 Agent。事件至少一次投递时，消费方根据事件 ID、operation_id 和目标版本去重。事件乱序时，系统不能静默覆盖较新的状态。

所有修改 Task、Execution、Material 关系或应用 CheckResult 的公共写入都需要携带 operation_id、task_id、spec_version、execution_id、fencing_version 和 state_version。operation_id、request_key 和 child creation key 都建立唯一约束；同一个操作重放时返回原结果，版本不匹配时返回 STALE_VERSION 或 FENCED，而不是静默成功。quota=1 的 claim 必须是数据库事务内的原子检查与写入，不能先 count 再 insert。active Execution 由 `state` 属于 CREATED、RUNNING 或 WAITING 的记录决定；WAITING 仍然占住同一 Task 的逻辑 claim，只有 SUCCEEDED、FAILED、EXPIRED、CANCELLED、FENCED 或 SUPERSEDED 等终态才释放。这个机制提供了 Lease、Generation 和 CAS 所需的最小语义，不需要先把它们拆成多个独立对象。

单机 Runtime 维护 runtime_generation、内存 semaphore 和持久 Execution 状态。heartbeat 只有在 execution_id、fencing_version 和 state_version 同时匹配时才能续租；lease 过期由单一 sweeper 通过 CAS 标记 EXPIRED 并递增 fence。Runtime 重启时先递增 runtime_generation 并 fence 旧运行，再从数据库扫描非终态 Execution，按状态重建容量计数；不尝试无条件复活旧 PID。这样可以处理“Execution 已创建但进程未启动”和“进程已启动但 Runtime 尚未记录”两种悬挂情况。

## 9. 资源、停止和背压

v1 的 Runtime 至少维护一个总执行容量、每个 Task 的 parallel_quota、Judge 或公共服务的容量以及基本存储限制。等待中的 Execution 不能持续占用 Agent Core、模型容量、Sandbox 或不必要的数据库连接。Task 数量、Execution 数量、Material 写入速率、Judge 请求速率和 Checkpoint 存储都需要有上限或背压反馈。

没有容量或其他准入条件未满足时，Task 应进入 BLOCKED，并在 `block_reason` 字段记录 `direct_child_not_ready`、`runtime_capacity`、`judge_capacity`、`context_unavailable` 或 `store_budget`，而不是无限创建 Process。已经有 Execution 的主动等待仍然使用 WAITING，不改写成 BLOCKED。v1 不新增 DEFERRED 状态，以免状态机出现未定义分支；如果未来需要区分长时间延期，再把它作为正式状态加入状态机。父 Task 也不能因为持续产生子 Task 就绕过容量限制。子 Task 可以继承目标和输入范围，但不能自动复制父 Task 的全部预算。单机 MVP 用固定上限和 FIFO 即可，不提前实现复杂公平调度。

停止分为取消 Task、停止 Execution 和等待外部服务结果三种情况。取消 Task 后，所有相关 Execution 不再取得新的运行机会，迟到结果只能被归档。停止 Execution 需要尽可能保存当前 Checkpoint，并让旧 fencing_version 失效。外部请求如果已经产生不可逆副作用，超时不能简单等于失败；Runtime 必须把状态标记为 UNKNOWN 或 UNCONFIRMED，等待查询、对账或人工处理后才能决定是否重试。

## 10. 安全和信任边界

Agent Core 是受权限约束的执行者，不直接修改 Task、Execution、Material、CheckResult 或 Runtime 的私有状态。它只能通过公开操作提交意图、候选和材料。Material 的正文可能不可信，不能因为其中写着“已验证”就提升 evidence_state。只有受信任的 Judge 服务能够签发与 checker、目标、输入和环境绑定的 CheckResult。

用户给定的 Assumption、定理目标、定义和允许使用的公理拥有更高的来源权限。Agent 可以提出新的 Claim，但不能用同名 Claim 覆盖固定 Assumption。Context 检索需要区分可信元数据和不可信正文，防止材料中的提示注入、伪造路径、伪造 checker 结果和越权引用。

代码、Shell 和工具调用在 v1 中至少需要基本 Sandbox、工作目录隔离、输出大小限制和凭据隔离。秘密信息不能进入公共 Material、Checkpoint 或输入快照。不同 Execution 的私有工作区不能共享可写目录。一个 Execution 被 fencing 后，它的旧工具进程和文件写入必须被停止、拒绝或隔离。

## 11. 最小接口和模块边界

Agent Core 到 Task Flow 的最小操作包括 propose_task、claim、create_child_task、submit_material、submit_candidate、request_wait、abort 和 acknowledge_feedback。父 Task 到 Task Flow 的最小操作包括 accept_task 和 request_rework；后者追加 steer Material 并恢复已有 Execution。Task Flow 到 Runtime 的最小操作包括 start_execution、resume_execution、stop_execution、release_capacity 和 fence_execution。Runtime 到 Task Flow 的最小操作包括 heartbeat、report_process_exit 和 request_expire_or_fence；这些操作报告或请求运行变化，不直接签发 Task 完成结论。Agent Core 通过 Services SDK 到 Context Service 的最小操作包括 read_materials 和 publish_material；Task Service 到 Context Service 的最小操作包括 freeze_initial_context。Runtime 到 Workspace Manager 的最小操作包括 create_workspace、restore_workspace、save_workspace_revision、save_checkpoint、release_workspace 和 fence_workspace。Judge 到 Task Flow 的最小操作是 submit_check_result，但只有配置了 `required_check` 的 Task 才会调用它。

MVP 的每个修改性操作都使用统一的操作信封：`operation_id`、`actor_ref`、`task_id`（提案阶段可为空）、`execution_id`（任务级操作可为空）、`spec_version`、`state_version`，以及执行写入需要的 `fencing_version`。`propose_task` 和 `create_child_task` 还必须携带 `task_type`、`task_type_version`、目标、预期输出、验收条件和幂等键；`request_wait` 必须携带 checkpoint、workspace revision、wait_condition 和 deadline；`submit_check_result` 必须携带 request_key、candidate_material_id、target_spec_version、input_snapshot_hash 和 checker 版本。重复 operation_id 或 request_key 返回第一次的结果；版本不匹配返回 `STALE_VERSION`，旧执行权返回 `FENCED`，不满足类型或权限返回 `INVALID_CONTRACT` 或 `NOT_ALLOWED`。接口第一版使用进程内调用或本地 RPC 均可，但这些字段和错误语义必须保持稳定。

`accept_task` 是统一的接受操作：子 Task 的调用者必须是当前 Parent Task 的有效执行者；root Task 没有 Parent，调用者必须匹配 Task 的 `owner_ref`。`request_rework` 在 MVP 只用于有 Parent 的 `parent_review`；root proof Task 的失败恢复由匹配的 CheckResult 和 retry policy 驱动。所有接受、返工、检查应用和 Execution 状态改变都必须由 Task Flow 在权限和版本检查通过后写入，Agent 不能直接修改公共状态。

Task Flow 拥有 Task 和 Execution 的公共生命周期状态、fencing 和完成判断；Runtime 拥有进程的启动、停止、心跳和资源释放，但这些是 Runtime 内部事实。Runtime 可以报告崩溃、请求 fencing 或请求过期处理，但不能直接把 Task 判定为完成或失败。Context Service 拥有 Material 的内容和版本；Workspace Manager 拥有私有 Workspace 的目录、revision 和 checkpoint 文件，但不拥有 Task 的完成真值；Judge 只在任务合同要求时拥有 CheckResult 的检查依据。父 Task 是 research 交付的审阅主体；它只能通过 `accept_task` 或 `request_rework` 这种受权限和版本保护的操作作出决定。所有模块都通过明确的转换操作更新共享记录，不能创建第二套与这些事实竞争的完成真值。

## 12. MVP 实施路线和验收

第一阶段使用单机、多进程、单 Runtime 和简单 ScriptExecutor。先实现一个根 Task、一个或多个子 Task、parallel_quota=1、Task 类型注册、Material 发布、可选的简单 Judge、等待和恢复，并把 `default`、`research`、`proof`、`implementation` 四类注册到 Task 类型注册表。执行流程应当能够展示：Task 创建时根据类型得到明确的 completion contract；root Task 可以创建符合类型规则的 research 子 Task，research Task 交付研究材料并等待父 Task 接受或返工，proof Task 产生候选 Artifact 并在合同要求时等待 Judge 返回 CheckResult，implementation Task 按声明的检查和父 Task 验收关闭。

第二阶段接入真实数学证明任务和领域 Judge。系统需要把用户给定的定理、定义、公理和初始 Proof State 作为固定输入，把 Agent 发布的事实、猜测、经验和候选证明作为不同类型的 Material，并验证局部 accepted material 不会被错误地当作根 Task 已完成。

第三阶段加入故障注入和规模测试。至少需要测试 Agent 在运行中崩溃、等待登记前崩溃、Checkpoint 保存后崩溃、Runtime 重启、Judge 重复返回、结果先于等待登记到达、旧 Execution 迟到写入、Context 版本修订、外部服务超时、资源达到容量上限以及取消后的迟到结果。

验收标准包含四类。协议正确性要求 active Execution 数不超过 parallel_quota、公共写入受到版本和 fencing 保护、重复操作幂等、Material 不被原地覆盖、Task 只消费匹配的 CheckResult。恢复正确性要求任务和材料不会因为 Agent 或 Runtime 退出而消失、等待中的逻辑责任不会被重复接管、旧执行者不能覆盖新结果、迟到结果不会重新激活已取消任务。资源正确性要求等待不会泄漏 Core、模型、Sandbox 和数据库连接，容量不足时系统会背压而不是无限生成 Process。架构可替换性要求替换 Agent 策略、Context 检索、Executor 或 Judge 后，Task、Execution、Material 和 CheckResult 的核心语义保持不变。

### 12.1 实现就绪审查：可以从一个小而完整的切片开工

对当前方案进行状态机、实现可行性和 Agent Swarm 运行问题三方面的复核后，结论是没有结构性阻塞，可以开始实现；但开工的前提是把下面的边界当作 MVP 的硬约束。MVP 使用一个 SQLite 数据库（WAL 模式）、一个 Runtime、多个 worker 进程、严格 parent-child 树、同一 Task 的 parallel_quota=1、一个本机 NuRouter/Pi Agent Core Adapter、一个确定性 ScriptExecutor 测试替身和一个同步或可轮询的本地 Judge。SQLite 负责四张权威表、CAS、唯一约束和 claim 事务；workspace 与 checkpoint 使用本机隔离目录，数据库保存引用、revision 和 hash。它验证的是责任、交接、等待、恢复、证据和完成判断的公共语义，不先验证多机调度、模型质量或吞吐优化。

四张表是 MVP 的最小持久化真值。可以使用关系数据库，也可以使用能提供同等 CAS 和唯一约束语义的存储；关键是不要让内存队列或 Agent 会话成为事实来源。

| 权威记录 | MVP 必要字段 | 主要不变量 |
|---|---|---|
| `tasks` | `task_id, root_id, parent_id, owner_ref, task_type, task_type_version, state, block_reason, state_version, spec_version, spec_hash, completion_contract_json, parallel_quota, max_depth, max_children, max_attempts, retry_policy, root_deadline, cancelled_at` | 根任务不因直接子任务完成自动关闭；同一 Task 的有效 claim 不超过 quota；BLOCKED 才能有 block_reason；类型规则不能被 Agent 正文绕过；root 的 accept 必须匹配 owner_ref |
| `executions` | `execution_id, task_id, state, state_version, attempt_no, fencing_version, runtime_generation, owner_ref, lease_expires_at, heartbeat_at, launch_token, initial_context_ref, workspace_ref, workspace_revision, checkpoint_ref, checkpoint_hash, instruction_version, steer_material_refs, wait_condition_json, wait_deadline, input_snapshot_hash` | `state` 是唯一公共执行状态；旧 fence 的写入失败；WAITING 保留逻辑 claim；未终态必须有可恢复的 Initial Context、workspace 和 checkpoint；终态才释放 claim |
| `materials` | `material_id, kind, scope, evidence_state, content_ref, content_hash, source_task_id, source_execution_id, supersedes_id, created_at` | 内容不可变；修订创建新 `material_id`；Agent 材料不能直接成为 proof 真值 |
| `check_results` | `check_result_id, request_key, candidate_material_id, target_task_id, target_spec_version, input_snapshot_hash, checker_ref, checker_version, environment_ref, status, verdict, evidence_ref, applied_task_state_version` | request_key 唯一；只应用与目标、规格、输入和 checker 完全匹配的结果 |

`task_log` 或 `outbox` 可以作为内部机制，用于轮询和恢复，但不增加第五种领域真值。Material 正文可以先放在数据库 JSON 或对象存储中，并保存 content_hash；Initial Context manifest 必须由冻结的 Task 规格、初始 prompt、排序后的不可变 material_id、revision 和 hash、服务信息和 input snapshot hash 组成，不能依赖 Context Service 的当前查询结果。CheckResult 如果需要被 Context Service 检索，可以投影成 Material，但 `check_results` 仍然是唯一权威来源。Workspace Manager 只把 workspace、checkpoint 和大型 Artifact 的引用、revision 和 hash 写入权威记录，不把私有工作区内容当作第二套 Task 真值。

Task 与 Execution 的状态组合也必须有单一解释。Task 为 RUNNING 时必须存在一个处于 CREATED 或 RUNNING 的 active Execution；Task 为 WAITING 时必须存在带完整 checkpoint 和 wait_condition 的 WAITING Execution，且 `block_reason` 必须为空；Task 为 BLOCKED 时不能有 active Execution，且必须记录 `block_reason`；Task 为 OPEN 时可以没有 Execution，也可以有尚未启动且可被回收的 CREATED Execution，但不能有另一个仍可写入的旧 owner；Task 为 SATISFIED、FAILED、CANCELLED 或 REJECTED 时不再接受新的恢复机会。所有 Task、Execution 和相关 CheckResult 的状态更新都在同一事务中完成，避免两个模块各自推进后形成 split-brain。

第一批实现的调用顺序应当固定为 propose → claim(CAS) → freeze_initial_context → start/heartbeat → publish_material → submit_candidate（如有）→ request_wait（如需等待）→ submit_check_result/apply（仅在合同要求检查时）→ resume/recover/fence。所有修改性调用都带 operation_id；claim、child creation、check request 和 wake 都有唯一幂等键。claim 在一个事务中完成“检查 active Execution、递增 fencing_version、写入 Execution、更新 Task state_version”，不能实现成先 count 再 insert。Runtime 启动或恢复前必须让 Workspace Manager 创建或恢复对应 workspace，并将 Initial Context 与初始 prompt 写入其中；Runtime 重启先递增 runtime_generation 并 fence 旧运行，然后扫描数据库恢复；旧 worker 即使进程还活着也只能得到 FENCED。

MVP 只实现 `child_task_terminal`、`parent_review`、`check_result_arrived` 和 `timer` 四类等待条件。`request_wait` 必须保证 checkpoint、workspace、条件、期限、Execution→WAITING 和资源释放可以一起提交或被安全重试；任何时刻都不能出现“没有 checkpoint 却是 WAITING”。等待中的 Execution 不占 worker、模型、Sandbox 和数据库连接，但仍然占住同一 Task 的逻辑 claim，直到条件满足、父 Task 接受或返工、超时、取消或明确 fencing。这样既释放物理资源，也避免 quota=1 的同一 Task 被第二个执行者抢走。

completion_contract 在 MVP 中只接受可解释的 JSON 结构。`required_children` 只能列出当前 Task 的直接子 Task；`required_materials` 指定 default、research、implementation 或其他交付型 Task 必须留下的材料；`required_candidate` 和 `required_check` 只在 proof 或其他需要独立检查的 Task 中使用；`parent_review` 指定交付后必须由父 Task 接受。Task Flow 只有在交付条件满足、父 Task 已接受，或 CheckResult 已经 APPLIED 且 CAS 成功时，才把 Task 置为 SATISFIED。一个直接 child PASS 只触发父 Task 重新评估，不改变父 Task 的完成状态。

#### 12.1.1 首批实现合同

v1.2 是实现层的唯一规范来源。早期的架构汇报和旧版设计文档只保留在 `documents/archive/` 供回溯，不再作为实现依据。MVP 不要求先设计通用 HTTP、RPC 或消息队列；可以用进程内调用和数据库轮询实现，但必须遵守下面的公共操作和状态语义。

类型注册表在 MVP 中允许 `default`、`research`、`proof` 和 `implementation` 任意一种类型作为 root 或直接 child。第一版不维护复杂的 allowed-child matrix；类型限制只来自父子权限、深度、扇出、预算和该类型的 completion contract。这样可以先验证 Task 的责任和验收，不把任务分类扩展成新的调度图。

`completion_contract` 只接受以下字段，未知字段直接拒绝：

```json
{
  "required_children": ["direct-child-task-id"],
  "required_materials": [
    {"kind": "research_report", "scope": "operational", "min_count": 1}
  ],
  "required_candidate": {"kind": "artifact"},
  "required_check": {
    "checker_ref": "lean4",
    "checker_version": "locked-version",
    "environment_ref": "putnam-lean4-fixture"
  },
  "parent_review": true
}
```

`required_children` 只能引用当前 Task 的直接子 Task；`required_materials` 只检查不可变 Material 的 kind、scope 和最小数量；`required_candidate` 表示当前 Execution 必须提交指定种类的候选；`required_check` 出现时必须得到绑定目标、输入快照、checker 和环境的 PASS CheckResult；`parent_review` 只对有 Parent 的 Task 生效。root Task 由 `owner_ref` 代表的创建者或授权 owner 使用 `accept_task`，不伪造一个不存在的 Parent。MVP 的 `default`、`research` 和未配置检查的 `implementation` 默认使用 `parent_review`，`proof` 默认使用 `required_candidate + required_check`。

SQLite 使用 WAL 模式。claim、Execution 状态变化、等待登记、父 Task 接受或返工、CheckResult 应用以及 Task 状态投影必须在同一数据库事务中完成；claim 使用事务内的原子检查和写入，不能先 count 再 insert。对 `executions` 建立 active 状态的唯一约束或等价的事务保护，使同一个 Task 在 quota=1 时最多保留一个 CREATED、RUNNING 或 WAITING Execution。SQLite 只保存公共元数据和小型 Material 内容；workspace、checkpoint 和大型 Artifact 使用隔离的本地目录，并把 content hash、revision 和引用写入权威记录。

本地 ScriptExecutor 只作为协议 golden path 的确定性测试替身：它按冻结的 Initial Context 和 input snapshot 启动脚本，记录 stdout/stderr、退出码、workspace revision 和 checkpoint，但不代表另一种生产 Agent Core，也不修改 Task 状态。真实 Agent Core 通过本机 `nurouter pi --provider <provider> --model <model> --account <account> --group <group> -- --mode rpc --session-dir <dir> --session-id <execution_id>` 启动；具体 provider、account、group 和 model 从 Runtime 本机配置读取，凭据不能进入公共记录。Pi 使用的包是 `@earendil-works/pi-coding-agent`；每次构建或发布先解析 npm `latest` 到精确版本，记录 `pi_version`、NuRouter 版本、Node 版本和启动参数，单个 Execution 期间不得自动升级。Pi session 是 Execution 的恢复辅助物，不是 Task、Execution、Material 或 CheckResult 的真值；fencing 后新 Agent 必须以持久 checkpoint、Initial Context 和 steer 为准。Lean checker 作为 Judge Adapter 接收 candidate Artifact、input snapshot 和 fixture manifest，返回标准化的 CheckResult；fixture manifest 必须锁定 PutnamBench commit、题目文件 hash、Lean toolchain、Mathlib 版本、checker 版本和环境引用。第一条端到端测试先用 ScriptExecutor 验证责任链，再用同一个 fixture 运行 NuRouter/Pi Agent Core Adapter。

首批实现必须先完成 root proof golden path，再补充 parent review/rework、claim 竞争、崩溃恢复、Runtime 重启、重复通知、迟到 CheckResult、类型校验和 NuRouter/Pi 启动检查测试。没有必要在这条切片中实现多机调度、复杂公平策略、跨树依赖或外部不可逆副作用；真实 Agent 接入使用本机 NuRouter/Pi Adapter，确定性 ScriptExecutor 只用于隔离协议测试。

### 12.2 MVP 覆盖范围、非目标和故障验收

这个 MVP 能够解决 Agent Swarm 中最容易造成系统性损坏的几类问题：Agent 退出后任务责任不会消失，新的 Agent 可以按同一规格、输入快照和 checkpoint 接手；等待外部结果时不再长期占用运行资源；旧执行者的迟到写入、重复通知和重复检查不会覆盖当前责任；猜测、经验、失败记录和正式检查结果可以共存而不会自动污染证明真值；根 Task、子 Task、Execution 和 Material 的生命周期可以分离演进。它不能保证模型推理质量、最优任务拆解、跨任务的语义去重、任意外部副作用的 exactly-once、多机一致性或自动合并互相矛盾的猜测，这些应当保持为后续扩展或明确的上层策略。

MVP 必须先通过一条端到端 golden path，再补充局部协议测试。端到端 fixture 暂定选择 PutnamBench Lean 4 的 [`putnam_1966_a1`](https://github.com/trishullab/PutnamBench/blob/main/lean4/src/putnam_1966_a1.lean)。它的形式化声明短，适合作为第一条完整链路；实现时必须同时锁定 PutnamBench commit、Lean toolchain、Mathlib 版本、题目文件 hash 和 checker 版本，不能只依赖题目名称。

这条 golden path 使用一个 root `proof` Task，把四个 core 全部串起来；research 的 parent review/rework 作为第二条集成场景补充，不替代这条主链路：

| 步骤 | 运行过程 | 必须观察到的事实 |
|---|---|---|
| 1. 创建 root | 创建 `proof` Task，completion contract 要求一个 proof Artifact 和匹配的 `required_check` | Task、类型和完成合同已经持久化；Agent 还没有 Execution |
| 2. 认领并开放 | Task Flow 按类型规则允许 claim；创建 root Execution `E0`，冻结 input snapshot 和 workspace | Task 与 Execution 建立唯一责任关系；Task 仍未完成 |
| 3. 产生材料和候选 | `E0` 发布研究过程中的 experience/conjecture Material，再发布 proof Artifact，并保存 checkpoint | Material 和候选 Artifact 都持久化；Artifact 存在不等于 proof 完成 |
| 4. 第一次检查失败 | `E0` 以 `check_result_arrived` 等待；Judge 返回与候选和输入匹配的 FAIL CheckResult | CheckResult 已记录，但 root Task 不能 SATISFIED；原 Execution 可以从 checkpoint 恢复 |
| 5. 恢复并修复 | `E0` 在原 workspace、context 和 checkpoint 上恢复，发布 superseding proof Artifact，再次等待 checker | 旧 Artifact 保留为历史材料；恢复没有创建第二个并行 Execution |
| 6. Judge 返回并关闭 | Judge 产生与新 Artifact、root spec、input snapshot、checker 和环境完全匹配的 PASS CheckResult；Task Flow 应用它并结束 `E0` | CheckResult 成为第四个 core 的独立完成依据；root Task 只有此时才 SATISFIED |

这个场景用确定性的 ScriptExecutor 也可以先跑通，目的在于验证 SwarmEnv 的完整责任链，不把模型是否能解题混入第一条集成测试。真正接入 Agent 后，再把同一个 fixture 用于模型测试。PutnamBench 在这里是固定的 proof 输入和本地 checker 来源，不是要在 MVP 阶段跑完整 benchmark。第二条集成场景再创建 `research` child，验证 Material 交付后 parent review、steer 返工、原 Execution 恢复和父 Task 接受。

实现验收不以吞吐或模型分数为第一指标，而以状态不变量和故障注入通过率为第一指标。至少要覆盖下表中的场景：

| 故障或并发场景 | 必须成立的结果 |
|---|---|
| 两个 worker 同时 claim 同一 Task | 只有一个 claim 成功，active Execution 不超过 1 |
| Agent 在 CREATED、RUNNING 或等待提交前崩溃 | 不出现无 checkpoint 的 WAITING，不出现双恢复；旧责任最终 EXPIRED 或 FENCED |
| Agent A 退出后 Agent B 接手 | `task_id、spec_hash、input_snapshot_hash` 保持一致，只有 B 能写当前状态 |
| research child 交付后父 Task 请求返工 | 原 Task、原 workspace、原 context 和原 Execution 保留；只增加 steer，恢复后继续使用最新 checkpoint |
| research child 交付后父 Task 接受 | `parent_review` 结束，Execution 成功结束，child Task 才能按合同 SATISFIED |
| Agent 创建缺少类型或验收条件的子 Task | Task Flow 拒绝创建并返回缺失字段，不生成无法验收的 Task |
| 同一 propose、claim、check、wake 重复到达 | 返回既有结果，不增加 Execution、CheckResult 应用或资源释放副作用 |
| CheckResult 先于 wait 注册到达 | 结果持久化，wait 登记后只产生一个恢复机会 |
| 旧 fence、旧 checker、取消后的迟到 PASS | 写入被拒绝或仅归档，不能重新激活当前 Task |
| child Task PASS | 父 Task 只重新评估，root 不自动 SATISFIED |
| Agent 发布 fact、experience 或 conjecture | 即使 evidence_state 为 accepted，也不能推进 proof completion；只有受信任 checker 绑定的 artifact/check_result 可以 |
| WAITING 和容量达到上限 | WAITING 释放物理资源，同一 Task 仍不可被第二 Execution 接管；新任务被阻塞并记录原因，不能无限启动进程 |
| Material 修订或 Context 结果变化 | 旧 Material 不被覆盖，input_snapshot_hash 不变时读取到的内容仍然可复现 |

因此，开工顺序应当是先实现并跑通上述 golden path，再补充类型校验、claim、heartbeat、fence、wait、recover、幂等和迟到结果的局部测试；然后接入真实 Agent 和更多 PutnamBench fixture。只要完整链路和状态不变量都通过，Agent 策略、Context 检索和 Judge 实现就可以独立替换，系统已经具备继续迭代而不重新发明任务真值的基础。

## 13. 保证范围、非目标和后续扩展

v1.2 保证一个完整根 Task 可以在多个子 Task、多个 Execution 和多个 Agent 之间持续推进；保证材料可以带着来源、版本、类型和证据状态跨上下文复用；保证等待、崩溃、Runtime 重启和执行者替换不会自动丢失任务；保证每个未终态 Execution 都有可恢复的 workspace、context 和 checkpoint lineage；对于配置了 `required_check` 的 Task，保证完成需要与目标、输入、环境和 checker 匹配的 CheckResult，其他 Task 按自己的交付合同完成；research 的交付必须经过父 Task 的 accept 或 rework。

v1.2 不保证最优任务分解、不保证 Agent 一定采用了读到的材料、不保证所有外部请求恰好执行一次、不保证任意模型内部状态都可以无损恢复，也不保证多个互相矛盾的 conjecture 能自动合并。它首先提供一个可以分析和独立优化的公共运行基础。

后续扩展可以沿四条路径进行。提高 parallel_quota 可以支持同一 Task 的并行 Execution；把 Execution 拆成逻辑 Attempt 和物理 Process 可以支持更复杂的多机运行；增加 ServiceCall 和可靠事件机制可以支持长时外部服务；提取 Project、Lease、Resource、TaskVersion 和 Reconciler 可以支持多租户、复杂资源治理和大规模版本回溯。这些扩展都应建立在四个核心对象已经稳定的基础上，而不是在 v1 一开始就把所有机制提升成独立对象。

## 14. 设计总结

SwarmEnv 的最小核心可以归结为一句话：Task 表示要完成什么以及按哪种类型验收，Execution 表示当前谁在做和从哪里恢复，Material 表示公共环境中留下了什么，必要时由 CheckResult 提供独立的完成依据。

根 Task 保存完整数学问题，子 Task 承担局部责任；parallel_quota=1 限制同一个 Task 的竞争性执行，但不限制兄弟子 Task 并行；Agent 只能从注册的 `default`、`research`、`proof`、`implementation` 类型创建任务，并且必须提交对应的输出和验收条件；父 Task 可以接受 research 交付，也可以用 steer 要求在原 workspace、原 context 和 checkpoint 上返工；只有与任务目标、输入、假设、环境和 checker 匹配的 CheckResult 才能推进证明相关的完成状态。

系统的运行链条是：

~~~text
完整根 Task
    → 创建子 Task
    → 创建 Execution
    → 读取版本化 Material
    → Agent 产生新的 Material
    → 如果合同要求检查，则 Judge 产生 CheckResult；否则等待父 Task 接受或要求返工
    → Task 根据完成合同继续、等待、重试、分解或完成
    → Agent 崩溃或 Runtime 重启后恢复
    → 旧 Execution 被 fencing
    → 根 Task 通过最终检查后关闭
~~~

v1.2 的目标不是用最少的名词描述一个不完整的系统，而是用最少的核心对象保留完整的运行语义，并为并行执行、异步服务、多机 Runtime、复杂资源和更细的版本管理提供清晰的扩展入口。
