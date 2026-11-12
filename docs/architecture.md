# Task-oriented Swarm：第一阶段目标架构

状态：PR #110 设计草案，尚非已实现能力。本文说明整体流程，详细契约见[Agent Task运行契约](20261102-agent-task-runtime-contract.md)，约束见[AGENTS](../AGENTS.md)，差距见[实现状态](implementation-status.md)。本次根据用户澄清修订，不再采用单一执行者的Mission入口或任务数量配额。

## 1. 同一个目标，两种工作范围

所有Agent共同面对Mission。Mission保存原题、初始材料、最终验收和运行资源；一个共享Mission Task使所有身份的整体研究都有显式归属。多个Execution可以同时推进它，实际数量由Core和总预算限制，不额外设任务级并行上限。

具体问题适合独立推进时，Agent登记普通Task，说明目标、交付、验收和分工理由。普通Task保持一个有效执行者，已有参与者继续其他工作。来源关系只追溯问题从哪里产生，不授予父级调度或审批权。

因此，默认启动无需预置领域路线，也无需先让一个planner为所有人生成任务。没有普通Task可领时，Agent继续共享Mission；不把队列空当作Mission完成或identity退休。继续整体研究、尝试集成成果和提出具体问题，都可以在Mission Execution中进行，不强制拆成微任务。

## 2. Agent的连续工作循环

```text
同一个identity、自己的Core lane
  → 读取Mission目标和工作状态
  → task_take：共享Mission或已有独立Task
  → 得到该Execution的Workspace与相关context，按需读取更多Material
  → 研究、检查、保存阶段结果
  → 需要分工时task_register，当前Execution可以继续
  → 处理新反馈、完成或handoff
  → 继续认领普通Task；无合适分工则回到共享Mission
```

Agent不需要每轮先注册任务，直接认领已有任务即可。认领不申请第二个Core；释放Execution后identity可留在原lane继续。短暂任务发现与切换记录成本，正式研究绑定到Mission或普通Task。

task_take保证责任与执行资格不冲突，工作面准备失败时撤销该次未完成绑定。Runtime仍维护物理进程、lease、fencing和工具调用次序，不负责数学方向选择。多个执行者的Workspace独立；不因共享Mission而共用可写目录。

## 3. 任务创建、反馈与handoff

新的独立Task增加明确分工。发布Material积累知识，反馈可以在当前执行结束前影响研究。Handoff结束当前Execution但不完成责任；普通Task回到OPEN，共享Mission还有其他执行者时保持RUNNING并继续可认领。

本阶段没有累计新增、在制或OPEN队列数量上限，也不存在任务名额回收。任务数仍然记录，分页和请求幂等仍然正确。资源只约束实际计算：总预算、Core/模型并发、工具调用及Execution窗口。是否需要任务数量策略留到后续，不在本轮偷偷换一个上限。

共享Mission的局部handoff只撤销当前Execution，其他人继续。一个人完成阶段研究不代表原题完成；普通Task完成也不自动取消它派生的工作。

## 4. Judge和最终验收

Agent直接检查当前版本，读取诊断，修正后在同一Execution再次检查。`judge.submit_candidate`从当前Execution的私有Workspace提交相对文件路径，经Bridge读取并附带路径、revision和content hash的内部attestation，再由Registry直接送入Judge；不要求先发布Candidate Material，也不经过Task Service或Benchmark Runner callback。Judge保存CheckResult、区分源码失败与checker故障并提供幂等重放。PASS不会自动完成Task或Mission；需要完成责任时，Agent显式调用Task completion并引用CheckResult。

局部引理、编译检查和完整原题结果分别报告。最终成功必须由固定原题与环境对确定候选版本验收；任一有权限的执行者可以提交，不限于最初身份。服务错误与数学失败分开，旧PASS不能验收新内容。

## 5. 阶段成果与简单接续

Material保留生产来源、版本、证据和适用条件。相同内容可以用于自用接续和多个接收者，不为流程复制。接收、阅读、实际使用和结论可信度分别表达；不建立在线全局共识或价值评分。

Progress Material记录已完成工作、发现、开放问题和下一步。有文件工作时，Runtime将允许的文件保存为本地Git commit，Material引用该commit；下一Execution从对应快照创建新worktree。文本任务直接保存Material。共享Mission按Execution保存快照和来源，禁止全体覆盖一个最新指针。

保存失败允许丢弃本次未保存状态并继续结束旧执行；最后成功的材料和commit仍保留。记录失败阶段与恢复来源，不假报成功，不引入无限重试或通用分布式快照协议。普通checkpoint失败可以返回错误并继续工作，handoff失败不阻塞释放。

## 6. 上下文保存与identity轮换

采用明确的计数和比例，不使用未定义的形容词。identity最多完成三次compaction；第三次完成后可继续研究，当前上下文token/模型窗口再次达到80%时handoff并结束旧identity，不允许第四次compaction。具体事件、数值不可用和超限保护按运行契约处理。

Runtime在compaction后有序提醒保存checkpoint，不能并发发送Agent turn。轮换后新identity从最后成功的Material/commit接着做，Task和Mission费用继续累计。没有普通Task时继续Mission，不因任务队列空而退休；满足轮换条件时换掉旧Session并补充新Session，研究责任保留。

## 7. 运行中反馈与权限

反馈属于任务而非易消失的Session。普通Task在接续后仍能处理已投递未处理的证据；Execution截止提醒过期即失效。共享Mission的相关反馈对每个受影响Execution分别记录投递和决定，一人处理不替全体确认。

收到证据后，当前执行者改变方法、核验质疑或说明不适用；范围显著变化时可结束原独立Task并关联后续Task，不先建设复杂合同编辑器。同伴没有任意取消他人或Mission的权限。撤销一个Execution只使其旧写入失效。

## 8. 可观察性、验收与收束

从Task看来源、全部Execution、Progress/Material和反馈，再按identity/Core展开执行时间。共享Mission多Execution与普通Task分工分别展示；多个Agent执行同一任务不自动被报告为非重复分工。活动时间不直接等同有效研究，未知证据不补零。

每项实现对应正常路径、可失败的反例和证据，见[行为验收表](validation/20261102-phase-1-behavior-acceptance.md)。每个Issue既有真实两小时的主要改善现象，也有逐项回归/受控验证，不能只验一个总指标。

Mission成功、总时间/资源耗尽、授权停止或环境不可用分别记录。结束时停止新工作，尽力保存已有成果，有界释放资源；保存失败不无限拖延收束。排队任务未完成如实保留，不能因收束被解释为数学上无价值。

## 9. 第一阶段范围和来源

S1恢复直接检查。S2交付共享Mission、主动认领/分工及最小可用Git/Progress接续。S3增加执行中反馈、三次compaction后80%轮换和异常恢复。每项在前项上独立验收，不将S3作为S2的隐藏前置。

近期继续数学环境，不做prompt调优、任务配额、语义去重、智能调度、万级部署和复杂Git同步。既有23项代码核对不是范围上限，但新增工作必须解释对应哪条约定、如何观察；不以审计为由无限扩大实现。

来源：[Notion目标架构](https://app.notion.com/p/40b4e07aa023819e9c19f077205f8cd5)、[Notion架构复盘](https://app.notion.com/p/40b4e07aa023818f97ade56d43c32c8f)，以及用户对Judge、共同Mission、无任务配额、identity和保存失败的后续决定。本文重组为仓库约定，不是私人语料导出。
