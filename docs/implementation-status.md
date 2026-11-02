# 目标与实现状态

代码核对基线为 Issue #111 实现提交 `d20363c6f1814e09615402d369abbfb2e176cbb6`（PR #112；随后只有证据文档提交）。`npm test` 在该实现上为 301/301。最终真实 Agent probe 的 preflight 为 `READY_TO_LAUNCH`，但在可用 Agent turn 前以 `RPC_ERROR / timeout` 结束，因此真实长跑仍为 BLOCKED；不能把确定性测试写成真实验收结论。

| 目标 | 已有情况/尚待实现 | 归属与验收 |
| --- | --- | --- |
| 同Execution直接检查与修正 | 已移除研究 Task 的 Judge 合同门禁；FAIL 反馈在同一 Task/Execution 内继续迭代，确定性回归覆盖 | S1，J1–J5，A01–A05；真实 A 证据仍 BLOCKED |
| 完整候选不绑定初始身份 | 非 root 候选入口已保留；原题、环境和版本绑定仍保留 | S1；真实 A04 尚无长跑证据 |
| 多identity共同推进Mission、普通Task独占 | 共享 Mission Task 与普通 Task 的并发语义已有确定性覆盖；四 Core 的真实并发尚未验收 | S2，B01/B02/B07；真实 B01 INCONCLUSIVE |
| identity复用自己Core并连续工作 | 当前 runner 仍有独立 Selection Session，尚未满足同一 Core/identity 直接 `task_take` 的权威边界 | S2，B03/B04；SPEC blocker |
| 没有任务数量配额 | 已删除固定研究路线、初始任务数和动态任务预算；资源容量与工具超时仍保留 | S2，T2/T6、B05 |
| 同权威身份、幂等、分页和创建来源 | 注册 provenance、协作原因、同键不同内容冲突和 available-after-filter 分页已实现 | S2，B06；仍需完整真实轨迹 |
| 最小Progress/本地Git/主动handoff | checkpoint、handoff 和 Workspace 恢复路径已有；WorkspaceManager 尚非 Git worktree/commit，因此 B08 未完成 | S2，B08–B10；SPEC blocker |
| 保存失败有界丢弃并继续 | compaction checkpoint 排队、shutdown drain、旧 fence 写入拒绝和等待后 matching wake 已覆盖 | S2基本路径，S3轮换路径；确定性通过 |
| 实时反馈和分支级处理 | 同 Execution 反馈与跨 Execution receipt 的确定性路径已覆盖；真实 Agent 反馈闭环尚未取得 | S3，F1–F6、C01/C02 |
| 三次compaction后80%轮换 | 计数、80%阈值、未知值保守轮换和阻止第四次已有确定性覆盖；真实 Pi 阈值 probe 尚未完成 | S3，C03/C04；真实 C04 BLOCKED |
| 新identity继承有效成果和消息 | 轮换/恢复保留 Execution、Workspace 与消息边界；真实接续证据待长跑 | S3，C05/C06 |
| 每项实现有可观察证据 | [Issue #111 脱敏证据](issue-111-real-agent-evidence-20261102.md) 固定实现提交、环境和 probe；未把阻塞结果写成 PASS | 各 Issue 行为表；D03 已同步，D04 部分完成 |

具体旧代码证据在[符合性核对表](reviews/phase-1-conformance-audit.md)，新增目标见[运行契约](20261102-agent-task-runtime-contract.md)，逐项结果见[行为验收表](validation/20261102-phase-1-behavior-acceptance.md)。本表没有任何一行因文档修改而自动标记已实现。

S1/S2/S3仍是 Issue #111 的验收分组，不代表整体完成。当前 PR 保持 draft；Selection identity、Git-backed Workspace，以及四 Core 两小时处理/基线对照完成前，Issue 不能关闭。#107中的门禁加固由删除门禁替代，任务数量额度加固不再建设；服务一致性、幂等与材料/反馈问题仍须承接。旧 Issue、历史实验及归档不在本次改写范围。
