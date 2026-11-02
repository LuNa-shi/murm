# S2｜共享Mission上的主动工作、独立分工与基本接续

状态：Issue草案，未发布。前置：S1实现合并。依据：[运行契约](../../20261102-agent-task-runtime-contract.md)、P1–P3、P6–P7、P9–P11。负责T1–T8及新发现的同类偏差，基本保存/执行绑定在本项完成。

## 完整交付

四Core对应四个可工作的identity，它们可以同时取得共享Mission Task的各自Execution，在独立worktree中研究原题。Agent发现独立问题时登记普通子任务，可以留给他人；普通子任务只允许一个有效执行者。identity完成或交接该责任后，在自己的Core lane继续其他任务或共同Mission，无须第二Core、独立selection session或新的中心planner。

所有文件研究可保存最小Progress Material及Git快照，并由后续Execution从指定前驱继续。本项交付主动handoff和基础保存；compaction驱动的自动identity轮换与丰富反馈处理属于S3，不作为本项前置。

## 实现范围

删除固定领域路线、累计动态任务2/3限制及相关隐藏别名。不要以在制上限、OPEN上限、N–2N或名额回收代替。原题、工具说明、总预算、Execution时间盒和Core容量保持明确。

task_status展示共享Mission、普通队列、权威计数/分页和lane状态。共享Mission RUNNING时仍允许另一个identity认领。task_register记录提案目标、交付、验收、理由与真实创建身份，重放幂等但同键不同内容显式冲突。

task_take复用调用者lane，以明确Execution身份取得私有工作面和相关上下文。每identity同时一项Execution；普通Task独占，共享Mission多Execution。准备Git/context失败则清除未生效绑定，不阻塞未来认领。新调用不能使用上一个Task的权限，旧调用不能写入新Task。

普通Task handoff返回OPEN且仍未完成；共享Mission单个Execution交接不结束其他人，也不把全Mission标OPEN/DONE覆盖其他状态。共享数据更新通过服务，执行私有工作面独立。最终Mission完成仍由原题验收负责。

实现一次有界本地Git保存与Progress链接：允许的文件形成commit，成功时发布对应接续引用，继任从指定commit建立新worktree。保存失败如实记录并允许handoff结束，使用最后成功快照或原始输入恢复，不引入无限重试、远程同步和自动跨任务merge。文本任务可只保存Material。

统一支持配置中的Agent/Service/Runtime/报告身份，修正任务筛选截断与来源丢失；不支持的混合本地/远程组合启动前拒绝。基本Execution前驱、累计费用、时间盒提醒和退出原因与本行为一起实现，不延迟到最后的报告Issue。

## 两小时真实验收

对照是S1的clean实现，处理是本项clean实现；原题、模型、工具和资源一致。需同时展示：共享Mission多Execution实际研究且工作面隔离；Agent提出并实际执行独立任务；同一identity在任务间切换后继续工作；至少一条正常Progress/Git接续确实利用已有成果。主现象选择对照中可定位的共同Mission单人瓶颈、认领阻断或工作接续中断，并证明处理路径消除了相应阻断。不得把更多活动Session直接解释为更好分工。

报告共同Mission并发区间、独立Task并行区间、提案到执行/切换延迟、有效工作证据、总消耗和最终结果。任务数不上硬门槛，任务质量有未知则单列。不以微任务、内容复制、空材料或规定数量提示填满Core。

每项实现具体的正面现象、反例与测试模式见[行为表B01–B10](../../validation/20261102-phase-1-behavior-acceptance.md)。实际有触发但失败即FAIL；未覆盖不能记PASS。没有触发compaction轮换不阻塞本项关闭，因为该功能属于S3。

## 回归和范围收束

测试多identity同Mission、普通Task认领竞争、handoff后其他Mission执行继续、任务完成后同Session/Core再认领、创建超过旧累计上限且handoff不消除责任、权威计数与分页、请求重放、准备失败回滚、私有Git恢复、保存失败后释放、短窗口提醒与旧写入拒绝。不能只用新前端掩盖旧服务行为。

T1–T8与新增相关确定偏差、对应行为表和两小时现象都完成后关闭。无任务配额、语义去重、中心审批、prompt调优或高级Git事务。S3能力不能以未经验证的占位实现列为本项已完成。
