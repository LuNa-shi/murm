# Task flow

Task Service 负责 Task list、显式 claim、Execution 状态、lease、checkpoint 引用、wait/wake、fencing 和 parent review。Agent 从 Task list 选择目标并 claim；Task Service 不为 runner 预创建固定 child，也不把 core slot 绑定到永久 Task。

当前 Execution 需要等待时，Runtime 保存 Workspace revision 和 checkpoint，再调用 `request_wait`。WAITING 保留 Task 的逻辑责任但释放物理进程容量。唤醒会恢复同一 Workspace lineage；过期或 fence 后的新 Execution 可以选择 clean 或已有 revision。

父 Execution 需要单独研究、lemma 分解或实现路径时调用 `create_child_task`。child 创建不要求当前存在空闲 Core，child 进入共享 root queue；父 Execution 默认继续自己的独立工作。child 的 completion contract 决定它是发布 Material、提交 candidate、等待父审查还是接受 Judge CheckResult。child 结果通过持久化 Task/Material 记录供 parent 后续 turn 消费；只有 parent 无法继续时才请求真实依赖等待。所有写操作都带 operation ID、版本和 fencing 信息。
