# 目标与实现状态

代码核对基线为 Issue #111 后续实现提交 `f359e4f45cd52868d4d7ee11cba5077069401b5d`（基于 PR #112 的 `1aca2651cda88926f2d4732ad769c7ba1bda242c`）。完整确定性回归为 315/315。真实 Agent 受控 probe 在同一 clean 实现上返回 **SUCCEEDED**：同一 Session/Execution 内完成 source-level FAIL → 读取诊断 → 修订并 supersede → 第二次检查 PASS。两小时四 Core 对照运行尚未执行，仍是本阶段关闭前的缺口；不能用受控 probe 替代。

| 目标 | 已有情况/尚待实现 | 归属与验收 |
| --- | --- | --- |
| 稳定身份契约经 system 角色注入 | `AgentCoreAdapter` 使用 Pi 的 `--append-system-prompt` 文件注入；真实 Pi 1.4.0 session 的首个 system 消息含 `addendum` 段。动态任务上下文留在 user turn；prompt snapshot 分别记录 system/dynamic hash 与 service-doc hash | S1/S2；真实 probe 已验证注入，长跑仍待 |
| 同Execution直接检查与修正 | 已移除研究 Task 的 Judge 合同门禁；FAIL 反馈在同一 Task/Execution 内继续迭代。真实 probe 展示一次完整 FAIL→修订→PASS 同 Session 链 | S1，J1–J5，A01–A05；真实单 Execution 证据已取得 |
| 完整候选不绑定初始身份 | 非 root 候选入口已保留；原题、环境和版本绑定仍保留 | S1；真实 A04 尚无长跑证据 |
| 多identity共同推进Mission、普通Task独占 | 共享 Mission Task 与普通 Task 的并发语义已有确定性覆盖；`task_complete` 对声明了 Mission-level final-candidate acceptance 的共享入口会再次核对原题级条件 | S2，B01/B02/B07；四 Core 的真实并发尚未验收 |
| identity复用自己Core并连续工作 | 生产 runner 每个 Core 一个可复用 Bound identity；同一 Session 在 Execution 完成/交接后保留并通过 canonical `task_take` 取得下一责任；Runtime 只在显式 rotation、恢复失败或 shutdown 时停止它。独立 Selection Session 与 `claim`/`select_task` 生产分支已删除 | S2，B03/B04；确定性路径已覆盖，真实长跑仍待 |
| 没有任务数量配额 | 已删除固定研究路线、初始任务数和动态任务预算；资源容量与工具超时仍保留 | S2，T2/T6、B05 |
| 同权威身份、幂等、分页和创建来源 | 注册 provenance、协作原因、同键不同内容冲突和 available-after-filter 分页已实现 | S2，B06；仍需完整真实轨迹 |
| Service bundle 与使用文档 | `service.json` + `SKILL.md` + `references/` 加载/校验；`service://` 受限资源解析；必需文档 hash 绑定 manifest；Registry profile 注入初始上下文；mathlib-search 已有真实 bundle | 新增范围；确定性测试覆盖，真实 provider 响应仍待长跑 |
| 最小Progress/本地Git/主动handoff | 每 Execution 独立 Git worktree；checkpoint/handoff 使用同一 commit 引用；Progress Material 现记录实际 `workspace_commit` 与 revision；保存失败从最后有效快照有界结束 | S2，B08–B10；确定性回归通过，真实长跑仍待 |
| 保存失败有界丢弃并继续 | `execution_progress` 与直接 handoff 均记录 `save_failed`/损失并解除绑定；compaction checkpoint 排队、shutdown drain、旧 fence 写入拒绝已覆盖 | S2 基本路径，S3 轮换路径；确定性通过 |
| Sandbox 命令执行 | 本地容器后端：私有 `/workspace`、非 root、只读 rootfs、无宿主敏感挂载、CPU/内存/进程/超时/输出限制、后台 job 查询/取消、handoff/release 清理；`sandbox_exec`/`sandbox_job` 经 Runtime 与 Bridge 绑定门禁 | 新增范围；确定性 fake-docker 测试覆盖，真实镜像长跑尚未执行 |
| 实时反馈和分支级处理 | 同 Execution 反馈与跨 Execution receipt 的确定性路径已覆盖；旧 Execution 的 handoff 截止提醒不再转投继任者 | S3，F1–F6、C01/C02；真实反馈闭环待长跑 |
| 三次compaction后80%轮换 | 计数按 identity lane 跨 Task 保留；80%阈值、未知值保守轮换和阻止第四次已有确定性覆盖；真实 Pi 阈值 probe 尚未完成 | S3，C03/C04；真实 C04 仍未覆盖 |
| 新identity继承有效成果和消息 | 轮换/恢复保留 Execution、Workspace 与消息边界；真实接续证据待长跑 | S3，C05/C06 |
| 每项实现有可观察证据 | [Issue #111 脱敏证据](issue-111-real-agent-evidence-20261102.md) 固定 clean 实现提交、环境、受控 probe 和结果；未把未执行的 2h 运行写成 PASS | 各 Issue 行为表；D03 已同步，D04 部分完成 |

具体旧代码证据在[符合性核对表](reviews/phase-1-conformance-audit.md)，新增目标见[运行契约](20261102-agent-task-runtime-contract.md)，逐项结果见[行为验收表](validation/20261102-phase-1-behavior-acceptance.md)。本表没有任何一行因文档修改而自动标记为完整验收。

S1/S2/S3仍是 Issue #111 的验收分组，不代表整体完成。当前 PR 保持 draft；两小时四 Core 匹配运行、真实 Sandbox 运行、真实 compaction 阈值 probe 完成前，Issue 不能关闭。#107 中的门禁加固由删除门禁替代；任务数量额度加固不再建设。
