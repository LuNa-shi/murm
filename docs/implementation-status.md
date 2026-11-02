# 目标与实现状态

代码核对基线仍为`75fca5aa647154a642d676c639c8770d1f7eb90a`，PR #110只修订文档。本轮设计来源是用户对共同Mission、无任务数量配额、identity与保存失败的澄清，不能当作新运行已验证的结论。

| 目标 | 已有情况/尚待实现 | 归属与验收 |
| --- | --- | --- |
| 同Execution直接检查与修正 | runner的自动任务/Response gate、研究合同限制待清除 | S1，J1–J5，A01–A05 |
| 完整候选不绑定初始身份 | rootTaskId验收耦合待修；原题/环境/版本验证保留 | S1 |
| 多identity共同推进Mission、普通Task独占 | 新契约；旧modern Task默认单执行，不能直接满足共享入口 | S2，B01/B02/B07 |
| identity复用自己Core并连续工作 | 当前独立Selection/CoreDaemon路径待改，完整主动认领/上下文准备未交付 | S2，B03/B04 |
| 没有任务数量配额 | 旧累计动态2/3限制仍在；本轮明确删除，不替换为在制cap | S2，T2/T6、B05 |
| 同权威身份、幂等、分页和创建来源 | #107服务分裂风险及T3–T7问题待修 | S2，B06 |
| 最小Progress/本地Git/主动handoff | 现有Workspace与checkpoint不等于新commit/worktree契约；共享Mission各分支需独立来源 | S2，B08–B10 |
| 保存失败有界丢弃并继续 | 新要求；不建设无限恢复/分布式快照事务 | S2基本路径，S3轮换路径 |
| 实时反馈和分支级处理 | 已有followUp基础，缺已投递未处理接续及共享Mission各接收者状态 | S3，F1–F6、C01/C02 |
| 三次compaction后80%轮换 | 新目标，当前计数/阈值/adapter阻止第四次尚未实现 | S3，C03/C04 |
| 新identity继承有效成果和消息 | 基本保存由S2完成；自动轮换/异常身份接续由S3扩展 | S3，C05/C06 |
| 每项实现有可观察证据 | 保留已有trace，新增关键关联；共享Mission并发不得计作多Task分工 | 各Issue逐行更新行为表 |

具体旧代码证据在[符合性核对表](reviews/phase-1-conformance-audit.md)，新增目标见[运行契约](20261102-agent-task-runtime-contract.md)，逐项结果见[行为验收表](validation/20261102-phase-1-behavior-acceptance.md)。本表没有任何一行因文档修改而自动标记已实现。

S1/S2/S3尚为计划代号。#107中的门禁加固要求后续由删除门禁替代，任务数量额度加固不再建设；服务一致性、幂等与材料/反馈问题仍须承接。旧Issue、历史实验及归档不在本次改写范围。
