# 第一阶段：三个完整修复 Issue 草案

状态：PR #110 中的更新草案；尚未创建正式Issues或标记ready-for-agent。文档PR不改变运行代码。仅安排第一阶段，不开展prompt、价值评分和高级调度优化。

## 范围和最新决定

[AGENTS](../../../AGENTS.md)与[运行契约](../../20261102-agent-task-runtime-contract.md)是依据。用户举例和[已有审计](../../reviews/phase-1-conformance-audit.md)不是范围上限；沿真实调用链修复确定偏差，并明确新问题归属。

本轮取消所有任务数量配额设计，不做累计新增上限、在制上限或额度回收。共同Mission Task允许多个Execution，普通子任务保持清晰独占分工。identity认领Task复用自己的Core。最多三次compaction，第三次后继续工作，下一轮窗口达到80%时轮换。Git仅实现本地commit/worktree接续，保存失败允许丢弃本次未保存状态并停止。

## 三个Issue的边界

| 草案 | 本项完整交付 | 不依赖后项的验收对象 |
| --- | --- | --- |
| [S1](01-iterative-judge.md) | 检查权限、直接检查、诊断修正、版本绑定及严格最终验收 | 同一Execution实际失败—修正—重检，不等待新Task/Response |
| [S2](02-autonomous-task-supply.md) | 共享Mission与独立子任务、主动登记/认领、identity复用自己的Core、去除任务配额、基本Progress/Git保存和主动接续 | 多个identity可共同推进Mission；真实子任务分工；完成后继续Mission；保存成果可被下一Execution恢复 |
| [S3](03-feedback-and-continuity.md) | 运行中反馈、共享Mission各执行者分别处理、compaction计数与80%轮换、消息跨identity保留、异常接续 | 证据及时改变工作；第三次compact后仍可工作、第四次前交接；新identity实际继承成果 |

顺序为S1→S2→S3。S2交付基本checkpoint/handoff和Git恢复，S3使用它们实现自动轮换和反馈接续；不再要求S2先通过S3的compaction轮换测试。每项同步自己的工具说明、状态、测试和报告，不另拆schema/接口/观察票。

三个Issue少，不代表实现范围小。每项内部可以用多个小提交或顺序PR展开，但主Issue只有在自身完整路径可运行且验证完成后关闭。不为减少票数把尚未决定的高级功能塞进本阶段。

## 减少本轮复杂度

保留一个可工作方案：Runtime本地Git快照、每Execution私有worktree、失败即记录并放弃未保存变化；无分布式快照事务、跨Task自动merge和无限重试。无普通工作时直接继续共享Mission，不增加一个周期生成任务的中央planner。任务范围变化先使用结束旧责任并关联后续Task，不建设任意在线合同编辑器。

现有不一致仍须修复，包括别名/Bridge绕过、幂等错误、列表遗漏、多接收者状态、旧执行写入和误报。符合性修复可以修改必需的工具帮助和错误旧指令，但不进行prompt搜索。

## 验收组织

每个Issue同时提交：其审计项的处理结论；[逐项行为表](../../validation/20261102-phase-1-behavior-acceptance.md)中对应行的代码/测试/观察证据；[两小时匹配实验](../../validation/phase-1-acceptance.md)中的主要改善现象。

每项功能都需要可观察结果，但不要求单次自然运行碰到所有稀有失败。正常研究、真实受控probe和确定性故障测试分别报告；有预期事件却失败为FAIL，没有覆盖为INCONCLUSIVE。总利用率提升不能掩盖handoff、Git或反馈失败。

共同Mission的并发与不同子任务的分工分开统计。没有子任务时回到Mission可以说明活性恢复，不能单凭Core变忙声称协作效率提高。两小时指标事前登记，阈值不写入Agent prompt，任务数量不是阶段目标。

## 旧工作承接

S1承接J1–J5，删除#107的Response门禁加固要求。S2承接T1–T8和本轮共享Mission、Core绑定、基本Progress/Git接续；T2/T6不再建设任务额度系统。S3承接F1–F10中反馈/接续问题及compaction轮换，基本身份/截止修复与S2共用，不重复实现。现有Issues及历史报告保持不变，正式发布时再明确承接关系。

工程方法仍采用Matt Pocock的纵向完整切片、显式依赖和Spec/Standards双重审阅。这里是计划草案，不是代码已实现或验收已通过的声明。
