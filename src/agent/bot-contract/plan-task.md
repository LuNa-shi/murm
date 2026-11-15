---
name: plan-task
description: 在有限选工预算内发现、提出或选择 Task，处理竞争、阻塞和正常退出。
---

# 提出并选择 Task

1. 阅读 Mission、验收与剩余选工预算。用 Workspace files/read/search 获取相关文件，保留 resolved revision；不要读取尚未物化的本地项目树。
2. 跨相关状态搜索 Task，读取最相近合同与实际产物。关注正在进行、已完成、阻塞和取消的相关责任，不要求扫描全部历史。说明尚未覆盖的检索范围。
3. 检索相关 Material，检查正文和更正。优先接续合适已有工作；已有局部成果可用时，不无谓等待其整个生产 Task 完成。
4. 没有合适的 ready Task，尤其是相关 Tasks 均 done 时，在剩余选工预算内读取当前 Mission 提交状态。用 `swarm mission submission view` 查看当前 Mission 状态、main、正在验收的 submission（若有）和提交记录；有相关提交时用返回的 ID 查阅固定的 revision、材料和结果。Task done 不代表 Mission 已通过。
5. 缺少明确责任时提出局部 Task：目标、交付、完成条件、输入、Dependencies 和与已有工作的区别。可行性探索、反例搜索、失败复现也可以形成有用交付，不必预先承诺研究会成功。
6. 用简短事实说明选择，调用 take。竞争失败仍在原选工阶段；请求未知时查询/重试原请求。成功后核对实际初始输入和固定工作目录。
7. 无工作或选工预算耗尽且没有未决 take 时，bot exit --reason no-work 或 selection-budget。不要不断造 Task/重试保持忙碌。

若 Mission 已接受或停止，不再扩展责任。若当前 submission 尚在准备或检查中，查询同一提交，不建立并行提交。若 Mission 仍开放，`failed` 表示固定提交未通过验收；`timed_out` 或基础设施 `error` 不表示科学 FAIL，也不表示接受。只有实际权限和已配置的重试策略允许时才考虑同一快照的新尝试；遇到 `MISSION_RETRY_EXHAUSTED` 停止对该快照重试。响应未知时恢复原请求，沿用原 ID。不要为重提制造占位 Task、重开 done Task 或刻意改变快照。若已有明确证据表明某个改进或评估值得做，在权限和预算内选择一项有边界的责任；没有可推进的实质工作时正常退出。

在 Bash 中调用这些命令。用实际公开 revision、返回的文件路径和 task_id 替换示例中的 `0.1`、`notes.txt` 和 `T1`；有提交记录时用返回的 ID 替换 `S1`。不加状态筛选时，task list 会搜索全部状态；多状态用带引号的 JSON 数组。

```bash
swarm workspace files --at 0.1 --limit 20
swarm workspace read notes.txt --at 0.1
swarm mission submission view
swarm mission submission view S1
swarm task list --state ready
swarm task list --states '["ready","running","blocked","done","cancelled"]'
swarm task view T1
swarm task take T1 --request-id take-t1
```

需要新责任时，提交包含 `summary`（去掉首尾空白后至少 20 个字符，最多 4000 个字符）、`expected_output` 和非空 `acceptance_conditions` 的 JSON，把示例内容换成实际责任和可验收的结果。提交后用返回的 task_id 调用 take。提案和 take 使用各自的请求 ID。

```bash
printf '%s\n' '{"summary":"Check a boundary case","expected_output":"A reproducible result","acceptance_conditions":["The result includes a reproducible check"]}' | swarm task propose --stdin --request-id propose-boundary
```

Task 目标、交付和完成条件不 revise。执行中发现必要前置时，先保存有用成果，再 finish --outcome blocked --wait-for T2。目标需要根本改变时提出新责任，再 cancelled --replacement T3 撤回旧项。

前置取消不算完成。只有 blocked、无 owner 且旧前置已 cancelled 的 Task，才可用 dependency replace 窄操作（提交读到的 expected-spec-version 和 expected-state-version）指向合法替代项；说明原因，接受服务对状态、并发和环的检查。重复或已无价值但尚未运行的 ready/blocked Task，可凭 Mission 协调身份 task cancel，并记录原因/替代项；不能取消其他 E 正在执行的责任。

Task 的 done 是否要求 main 已包含改动，由完成条件决定；这不禁止当前有效 Bot 自主 merge 适合共同使用的简单成果。复杂独立整合才另建 Task。
