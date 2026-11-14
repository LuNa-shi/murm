---
name: plan-task
description: 在有限选工预算内发现、提出或选择 Task，处理竞争、阻塞和正常退出。
---

# 提出并选择 Task

1. 阅读 Mission、验收与剩余选工预算。用 Workspace files/read/search 获取相关文件，保留 resolved revision；不要读取尚未物化的本地项目树。
2. 跨相关状态搜索 Task，读取最相近合同与实际产物。关注正在进行、已完成、阻塞和取消的相关责任，不要求扫描全部历史。说明尚未覆盖的检索范围。
3. 检索相关 Material，检查正文和更正。优先接续合适已有工作；已有局部成果可用时，不无谓等待其整个生产 Task 完成。
4. 缺少明确责任时提出局部 Task：目标、交付、完成条件、输入、Dependencies 和与已有工作的区别。可行性探索、反例搜索、失败复现也可以形成有用交付，不必预先承诺研究会成功。
5. 用简短事实说明选择，调用 take。竞争失败仍在原选工阶段；请求未知时查询/重试原请求。成功后核对实际初始输入和固定工作目录。
6. 无工作或选工预算耗尽且没有未决 take 时，bot exit --reason no-work 或 selection-budget。不要不断造 Task/重试保持忙碌。

Task 目标、交付和完成条件不 revise。执行中发现必要前置时，先保存有用成果，再 finish --outcome blocked --wait-for T2。目标需要根本改变时提出新责任，再 cancelled --replacement T3 撤回旧项。

前置取消不算完成。只有 blocked、无 owner 且旧前置已 cancelled 的 Task，才可用 dependency replace 窄操作指向合法替代项；说明原因，接受服务对状态、并发和环的检查。重复或已无价值但尚未运行的 ready/blocked Task，可凭 Mission 协调身份 task cancel，并记录原因/替代项；不能取消其他 E 正在执行的责任。

Task 的 done 是否要求 main 已包含改动，由完成条件决定；这不禁止当前有效 Bot 自主 merge 适合共同使用的简单成果。复杂独立整合才另建 Task。
