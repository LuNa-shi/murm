# SwarmEnv 术语表

领域定义以本表为准，行为见[目标架构](docs/architecture.md)与[运行契约](docs/20261102-agent-task-runtime-contract.md)。

| 术语 | 含义 |
| --- | --- |
| Mission | 用户的共同目标、原始验收条件和资源范围；不对应永久管理Agent。 |
| Mission Task | 表达共同问题的共享Task；可以由多个Execution同时推进。它是任务协作入口，不是审批子任务的领导节点。 |
| 独立Task / 子任务 | 从共同问题或已有成果中提出的明确分工；有自己的交付边界，通常只有一个有效执行者。子任务称呼不赋予父级审批权。 |
| Task contract | 当前责任的目标、交付范围和验收要求。 |
| Execution | 某个identity对一个Task的一次执行授权；Mission Task可有多项并发授权，每项各有来源、工作面和执行权。 |
| Agent identity / Session | 可轮换的Pi会话身份，可顺序承担多个Execution，同一时刻只持有一个有效Execution。 |
| Core / Core lane | Runtime提供的模型与工具执行容量及其时间线；活动identity使用自己的lane，认领Task不申请第二个Core。 |
| Material | 带有生产来源、版本与证据的共享成果。 |
| Progress Material | 已完成工作、发现、开放问题、下一步及可选Git快照引用；用于checkpoint或handoff。 |
| Checkpoint | 保存当前Execution进度但不结束执行。 |
| Handoff | 结束当前执行授权并留下接续记录；任务本身仍未完成。保存失败可以结束执行，但必须标明状态丢失。 |
| Session rotation | 旧identity结束、新identity接续；不创建新的研究任务，也不构成新增并行。 |
| Compaction次数 | 一个identity已完成的上下文压缩次数，跨其先后执行的Tasks累计。 |
| 上下文窗口使用率 | 当前模型输入上下文token估计数除以该模型可用上下文窗口大小；不是累计费用或剩余任务预算。 |
| Workspace / worktree | 某个Execution的私有文件工作面；同一Mission的执行者也不共用可写目录。 |
| Workspace lineage | 具体执行的输入commit、成功快照和接续执行之间的来源关系。 |
| Response / Experience | 面向接收者交付或供后续检索使用的Material用途；不改变内容的原始生产来源。 |
| Feedback | 面向Task或其具体执行分支的信息和调整建议；不是直接改写他人责任的授权。 |
| Candidate | 待检查内容的确定版本，不是一种必须另建的Task。 |
| CheckResult / Judge | 指定目标与内容版本的检查结果／提供检查的工具服务。 |
| spawned_from | 提案来源，不表示管理或调度权。 |
| depends_on | 真正影响独立Task可执行性的前置条件。 |
| 未完成任务数 | 尚未完成或取消的责任数量，只用于观察；本阶段没有数量配额。handoff不会减少它。 |
| Safe point / 安全点 | 模型/工具执行能有序处理反馈、保存或停止的边界。 |
| Fencing | 撤销具体Execution旧写入资格；对共享Mission不能同时撤销无关执行者。 |
| Claim / task_take | identity主动取得工作责任、关联上下文和私有工作面，在自己的lane内开始Execution。 |
| Controller / Daemon | 物理运行监督的实现名称，不是语义领导者或研究路线生成者。 |

共享Mission的某次执行完成、独立Task完成、消费者接受材料、局部检查通过和Mission最终成功分别记录。Task状态枚举与“当前是否仍可认领”不必等价。
