---
name: plan-task
description: 在有限选工预算内发现、提出或选择 Task，处理竞争、阻塞和正常退出。
---

# 提出并选择 Task

1. 阅读 Mission、验收与剩余选工预算。用 Workspace files/read/search 获取相关文件，保留 resolved revision；不要读取尚未物化的本地项目树。
2. 跨相关状态搜索 Task，读取最相近合同与实际产物。关注正在进行、已完成、阻塞和取消的相关责任，不要求扫描全部历史。说明尚未覆盖的检索范围。
3. 检索相关 Material，检查正文和更正。优先接续合适已有工作；已有局部成果可用时，不无谓等待其整个生产 Task 完成。
4. 没有合适的 ready Task，尤其是相关 Tasks 均 done 时，在剩余选工预算内读取当前 Mission 提交状态。用 `swarm mission submission view` 查看当前 Mission 状态、main、正在验收的 submission（若有）和提交记录；有相关提交时用返回的 ID 查阅固定的 revision、材料和结果。Task done 不代表 Mission 已通过。
5. Mission 仍开放且有选工预算时，如果没有合适可领 Task，结合验收条件、当前 main、相关 Task 交付与 Material，定位一个具体缺口并主动提出局部 Task。写清目标、可验证交付、完成条件、固定输入及与已有工作的区别。如果还没有修复方向，就选择能缩小某个已知不确定性的有界调查，例如核对某验收条件在当前 revision 的证据，或独立复现有迹象的问题。
6. 提案前立即刷新最相关的 Task 查询；take 前再检查一次，尤其是 take 自己刚提出的 Task 时。查刚出现的相关责任和交付，避免重扫历史。优先选已有合适的责任；发现重叠时，只有确实有独立价值的验证、补充或整合才继续作为新责任。未认领的重复项由有效 UNBOUND Bot 附原因和观察到的版本用 task cancel 撤回；已认领后发现自己的责任应撤回，则由当前 E 用 task finish --outcome cancelled 如实结束。两个 Bot 仍可能在最后一次查询后同时提案。用简短事实说明选择，调用 take。竞争失败仍在原选工阶段；请求未知时查询/重试原请求。成功后核对实际初始输入和固定工作目录。
7. 开放 Mission 仍有选工预算时，继续有界诊断和提案，不能以 no-work 退出。实际选工预算耗尽且没有未决 take 时，用 bot exit --reason selection-budget；Mission 已接受或停止时停止扩展责任。

若 Mission 已接受或停止，不再扩展责任。若当前 submission 尚在准备或检查中，查询同一提交，不建立并行提交。若 Mission 仍开放，`failed` 表示固定提交未通过验收；`timed_out` 或基础设施 `error` 不表示科学 FAIL，也不表示接受。只有实际权限和已配置的重试策略允许时才考虑同一快照的新尝试；遇到 `MISSION_RETRY_EXHAUSTED` 停止对该快照重试。响应未知时恢复原请求，沿用原 ID。不要为重提制造占位 Task、重开 done Task 或刻意改变快照。已有 E 无法完成原责任且没有必要等待项或撤回理由时，先保存有用成果，再用 task finish --outcome incomplete 如实结束；后续由新 Bot 依据公开成果重新选工。

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

需要新责任时，提交包含 `summary`（短标题，去掉首尾空白后 1–240 字符）、`gap`（1–4000 字符，具体局部问题与 Mission 用途）、`expected_output`（1–4000 字符）、非空 `acceptance_conditions` 和显式 `priority`（high/medium/low） 的 JSON，把示例内容换成实际责任和可验收的结果。可以在一次选工期提出多个独立责任，也可在 ACTIVE 执行中提案；不要求自己执行自己的提案。已有合适 Task 时直接 take。提案和 take 使用各自的请求 ID。

```bash
printf '%s\n' '{"summary":"Check boundary case","gap":"The current argument leaves the boundary case undecided","priority":"medium","expected_output":"A reproducible result","acceptance_conditions":["The result includes a reproducible check"]}' | swarm task propose --stdin --request-id propose-boundary
```

priority 只是建议：high 有具体优先投入依据，medium 有明确用途但无更高紧迫性，low 是较远或暂不急的备选。选工不被最高档限制。当前责任内的小步骤直接处理；有独立交付和完成条件、值得接续的工作才另提，允许有界调查。Dependency 只表示必须等待的前提，一般关联在 gap 中说明即可。

UNBOUND Bot 可以修改本 Mission 开放且非 RUNNING、没有准备/清理中执行者的 Task；曾执行过并不阻止修改。ACTIVE Bot 可提案，但不能修订既有合同。先 task view 获取 spec_version/state_version，附一句原因：

```bash
swarm task revise T1 --expected-spec-version 1 --expected-state-version 2 --reason "New evidence makes this prerequisite urgent" --changes '{"priority":"high"}' --request-id revise-t1
```

替换版本号和理由为实际观察。changes 可含 summary/gap/expected_output/acceptance_conditions/priority/depends_on/input_material_refs/base_revision 等；完整参数见 CLI help 和 service metadata。服务原子检查版本和状态，旧 Execution 与成果保留原合同。task view 的 contract_history_page 给出继续历史的 after-version 游标，不将第一页当成全部历史。

执行中发现必要前置时，先保存有用成果，再 finish --outcome blocked --wait-for T2。目标需要根本改变时提出新责任，再 cancelled --replacement T3 撤回旧项。

前置取消不算完成。只有 blocked、无 owner 且旧前置已 cancelled 的 Task，才可用 dependency-replace 窄操作（提交读到的 expected-spec-version 和 expected-state-version）指向合法替代项；说明原因，接受服务对状态、并发和环的检查。重复或已无价值但尚未运行的 ready/blocked Task，可由有效 UNBOUND Bot 用 task cancel，并记录原因/替代项；不能取消其他 E 正在执行的责任。

Task 的 done 是否要求 main 已包含改动，由完成条件决定；这不禁止当前有效 Bot 自主 merge 适合共同使用的简单成果。复杂独立整合才另建 Task。
