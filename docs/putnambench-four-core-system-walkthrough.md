# PutnamBench runner workflow

每个问题只创建一个 Root Task。Root Task 的 goal 是证明该问题，Workspace 包含题目形式化代码和锁定的环境元数据。

四个 Core 是可复用的 worker slot。Runner 启动四个 unbound Agent，向每个 Pi 传入同一份通用 Agent prompt。Agent 先查询 Service catalog 和 root Task 的高优先级 Task list，再用明确的 Task ID 调用 `task_claim`。

Claim 会在 Task Service 事务中创建一个 Execution。Runtime 根据 Execution 的 Workspace selection 准备统一 Workspace：`clean` 从 Root/Task 初始代码库开始，`resume` 从指定的历史 revision 复制到新的可写目录并保存 lineage。Pi 的 prompt 由 adapter 传入，初始 Workspace 包含 `workspace-manifest.json`、题目代码和 revision/checkpoint metadata。

Workspace 也是 Agent 的真实项目工作目录。Agent 可以通过 Workspace Service 列出和读取项目文件、创建或修改文件、查看 diff；每次写入都会生成新的 revision 和文件 hash。`.swarm` 下的 Runtime metadata、父目录和其他 Execution Workspace 不属于 Agent 的可访问范围。

Agent 读取所 claim 的 Task、Execution 和 Workspace。Task 描述自身的 goal、expected output、completion contract 和约束。Agent 需要并行研究时主动调用 `task_create_child`；子 Task 进入同一个 root tree，其他 worker 可以从 Task list 选择它。child 创建不等待 Core capacity，队列可以暂时堆积。除非 parent 没有可继续的独立工作，否则 parent 创建 child 后继续自己的主线。Agent 通过 Context Service 发布和读取 shared Materials，通过 Judge Service 提交候选。

Runner 只负责项目隔离、Runtime、Judge 调度、heartbeat、审计和报告。它只创建 Root Task，不预先创建 proof child，也不代替 Agent claim。没有可领取 Task 的 worker slot 保持 IDLE；当新的 child 进入队列时，Scheduler 为可用 slot 安排 discovery turn。

报告记录 Task/Execution ID、Workspace revision、Material provenance、候选 hash、工具事件、版本、资源和脱敏审计结果。候选源码、原始 transcript 和 checker 输出留在实验目录，不进入脱敏报告。
