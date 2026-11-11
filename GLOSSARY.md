# SwarmEnv 领域术语

> Type: Vocabulary · Status: Active · 2026-11-11
>
> 本表只解释领域名词；**不定义具体状态机、默认数值、审批权限或实验判据**。运行机制见 [architecture/INDEX.md](docs/architecture/INDEX.md)，研究实验相关的章节名和操作流程见 [实验工作流](docs/workflows/experiment.md)。

| 术语 | 定义 |
|---|---|
| Mission | 用户提出的共同研究目标及其最终验收范围；不代表永久管理者 Agent |
| Mission Task | 多个 Execution 可以分别参与的共享研究责任 |
| Ordinary / independent Task | 有独立目标、交付和验收边界的工作责任；通常只有一个有效执行者 |
| Task contract | 该项责任的目标、输出和验收要求 |
| Agent identity | 可持续工作的 Agent 身份，可先后承担不同 Task Execution |
| Session | 一段模型交互会话；Session 与研究责任并非同一对象 |
| Core / Core lane | Runtime 可复用的模型/工具执行容量和对应时间线 |
| Execution | 一个身份在某个 Task 上的具体执行授权与记录 |
| Claim / `task_take` | Agent 在自己的 lane 取得 Task 的有效 Execution |
| Material | 有来源、内容版本和用途的可共享成果或证据 |
| Progress Material | 描述已完成工作、发现、开放问题、下一步及可选 Workspace 快照的 Material |
| Workspace | 一个 Execution 独立的可写工作区 |
| Workspace lineage | 工作区输入版本、保存版本与接续执行之间的来源关系 |
| Checkpoint | 保存当前 Execution 的进度而不结束它 |
| Handoff | 结束一项 Execution 的授权，责任可以被其他 Execution 接续 |
| Session rotation | 更换 Agent identity/Session，不直接创建一项新的研究责任 |
| Feedback | 面向 Task 或其具体执行的纠错、信息和调整建议 |
| Candidate | 被提交检查的确定内容版本 |
| Judge / CheckResult | 执行检查的服务 / 与输入版本和环境绑定的检查结果 |
| Fencing | 使一个已终止 Execution 的旧权限和写入失效 |
| `spawned_from` / `depends_on` | 分别表示提案来源 / 实际前置依赖；来源不代表管理权 |

项目研发阶段的批准范围、实验 ID 和报告结构不在领域术语表中另设一套定义。新增术语先与负责人明确确认后才进入本表及 API/正式报告。
