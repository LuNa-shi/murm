# SwarmEnv Agent-driven Task model

本文档描述当前 MVP 的实现契约。

## 领域模型

一个项目从一个 Root Task 开始。Root Task 的 goal 只有一个：证明选定的题目。Root Task 的 Workspace 保存题目形式化代码、环境元数据和任务要求，不保存答案。

Agent Core 启动时收到同一份可复用 Agent prompt。这个 prompt 只说明如何发现 Service、浏览 Task、选择并 claim Task、读取 Workspace、协作和提交结果。题目的证明路线、候选格式、完成条件和禁止事项属于具体 Task 的 goal、expected_output、acceptance_conditions、completion_contract 和 Workspace 描述。

Agent 先调用 task_list 浏览当前 root tree 中优先级最高的 Task，再调用 task_claim 明确选择一个 Task。claim 在 Task Service 的事务中创建该 Task 的 Execution；一个 Task 可以按 parallel_quota 拥有多个并行 Execution。没有固定的四个 proof child。Agent 需要拆解时，由当前 Execution 调用 task_create_child，子 Task 进入同一个 root tree。

Execution 是 Task 上的租约和一次执行尝试。它记录 owner、lease、fencing version、Workspace selection、Workspace revision、checkpoint、candidate 和 state。首次 claim 默认创建 Execution；后续 claim 可以选择 clean Workspace，或选择已有 Execution 的 Workspace revision 继续工作。

## Workspace

Workspace 是统一概念。Task 初始化的题目代码库、Agent 修改、候选文件、checkpoint 和 revision 都属于同一条 Workspace lineage。Runtime 负责把 Workspace 物化到文件系统，并记录 workspace-manifest.json、revision metadata 和 checkpoint。resume 会把选定 revision 复制到新的可写目录并保留父 Workspace 引用；clean 从 Task 的初始 Workspace 文件开始。

Pi 的初始 prompt 通过 Agent Core adapter 的启动参数传递，Runtime 不再写 prompt 文本文件。Workspace 中不创建独立的 context snapshot 或 prompt 文件。Workspace snapshot hash 绑定 Judge 输入。

## Services

Agent 能力以 Service 为边界组织：

- Task Service：task_list、task_get、task_list_executions、task_claim、task_create_child。
- Execution Service：execution_get、execution_heartbeat、execution_wait。
- Workspace Service：workspace_get、workspace_revisions。
- Context Service：context_read、context_publish。
- Judge Service：judge_submit_candidate。

Catalog 提供 list_services、get_service_metadata 和 list_tools。Pi extension 为每个 catalog tool 注册单独的 swarmenv_* 工具；swarmenv_call 只作为旧会话的兼容传输。

## Runtime 顺序

实际路径是：

1. 创建一个 Root Task 和 Root Workspace。
2. 启动 unbound Agent worker，并传入通用 Agent prompt。
3. Agent 查询 Services 和 Task list。
4. Agent 明确 claim 选中的 Task，Task Service 创建 Execution。
5. Runtime 根据 Workspace selection 创建或恢复 Workspace。
6. Agent 读取 Task、Execution、Workspace 和 shared Materials。
7. Agent 需要拆分时创建 child Task，需要协作时发布 Material。
8. Agent 提交候选，Judge 返回 CheckResult，Agent 读取 feedback 并继续工作。
9. Execution 完成、等待、释放或因租约失效而被 fence；core slot 可以重新使用。

## 验收

验收至少包括 Task/Execution 的显式 claim、动态 child creation、Workspace clean/resume lineage、Service catalog、named Pi tools、candidate provenance、fencing、checkpoint、Judge feedback 和报告脱敏。PutnamBench 的短测用于发现协议问题，最终使用此前未证明的题目执行连续一小时，并保存原始审计证据和脱敏报告。
