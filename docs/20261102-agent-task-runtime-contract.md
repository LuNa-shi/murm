# Agent Task 生命周期与上下文接续契约

本文件接续20261102草案，依据用户最新决定修订：不设置任务数量上限；共同Mission可并行；identity认领时复用自身Core；最多compact三次，之后窗口再次达到80%时交接；保存失败允许丢弃本次未保存工作。实现状态见[实现状态](implementation-status.md)和[Issue #111证据索引](issue-111-evidence-index-20261102.md)：确定性路径与受控真实 probe 已覆盖，两小时四 Core 验收与真实 compaction 阈值 probe 仍未完成。原则见[AGENTS](../AGENTS.md)，验收见[逐项行为表](validation/20261102-phase-1-behavior-acceptance.md)。

## 1. 共同Mission与独立分工

Mission保存用户目标和不可被局部任务降低的最终验收要求。启动时建立一个共享Mission Task；四Core实验的四个identity都能获取原题，并在同一个Mission Task下各自开展Execution，不预置四条研究路线。

共享Mission Task不设额外的任务级并行上限，实际并发仍受Core容量、工具资源与总预算限制。各执行者可以研究整体问题、整理现有成果、组织完整候选，发现值得独立推进的问题时再登记子任务。独立子任务通常只有一个有效Execution，避免已明确的分工被重复占用。创建来源不带审批权。

这个差异只影响认领与聚合状态，不新增manager、warm-up planner或子任务审批流程。同一identity同一时刻只能执行一项责任。可以在执行当前Task时登记新任务留给别人；若要自己执行自己选定的方向，使用`task_register`的`take: true`：先为当前Execution保存checkpoint，再在同一个Task Service事务中以`task_switch`结束当前Execution并在同一Core lane上认领新Task。新Task从创建起就有执行者，别人无法抢先认领，也不存在保留/预约状态。（2026-11-05用户决定，r15修订。）

预期工作周期：先在共享Mission上只读研究，可发布研究Material；开始具体实施和测试时登记并切换到自己的Task；在该Task内反复尝试、发布Material、登记子任务和Judge检查；完成后再认领下一项。Execution只在生命周期边界结束（见§3）。

没有可认领子任务时，Agent继续共享Mission Task，而不因普通队列空而结束identity。若正在切换，可以短暂处于无Execution状态；实际继续研究Mission前要取得它的Execution，使工作与成本有归属。全Mission只因成功、总预算/时间到期、授权停止或明确环境故障收束，不因子任务队列空自动宣布结束。

## 2. identity、Core与工具边界

活动identity使用已有Core lane。task_take获得任务资料、私有工作面和执行授权，不申请另一个Core，不让一个独立Selection Session替它决定。正常完成/交接后解除的是Execution绑定，identity可在同一lane继续工作；identity轮换才结束旧Session并补充新的Session。

| 工具 | 约定 |
| --- | --- |
| task_status | 返回Mission目标、共享Mission Task、普通任务的状态/可认领计数和分页，以及各lane当前状态。计数来自权威状态并带观察时间/版本，不从截断列表推算。 |
| task_register | 登记有目标、交付边界、验收条件和分工理由的独立工作；服务补齐Mission、identity和提出时的Execution身份。不设置任务数量准入门槛。 |
| task_take | 指定共享Mission或普通Task，在调用者lane准备一个Execution及其上下文。普通Task检查独占，Mission允许多个执行。失败明确返回并撤销未生效绑定。 |
| execution_progress | kind=checkpoint保存并继续；kind=handoff尝试保存后结束当前Execution。具体保存失败不阻止交接，返回明确的失败/损失标记。 |
| task_complete | 普通Task依自身合同完成；共享Mission只有原题验收通过才整体完成，单个执行者的阶段成果不能把整个Mission标DONE。 |

注册与认领并非每次都要依次调用：可以直接认领已有Task；回到Mission也不创建新Task。collaboration_reason说明独立分工的意义，不要求所有工作都必须等待另一个Agent协助。

task_take在服务内部先取得有效执行资格，再准备worktree/context，准备成功才进入研究。Git或进程失败时撤销该次准备绑定，重试不生成重复有效Execution。使用现有事务/恢复边界，不建设分布式事务系统。并发返回或旧工具调用必须绑定原Execution，不能因Session切换而落到新Task。

Core的发现、上下文准备、研究、工具等待和收束分别记录。active/idle计数说明口径，不把Session活着当作有效研究，也不把认领所需的发现成本排除出预算。共享Mission Task即使RUNNING仍可被其他identity认领，open_task_count不等于claimable_task_count；共享入口只计一个Task。

## 3. handoff、状态与没有配额的任务池

普通子任务handoff后仍未完成，回到OPEN；block只用于明确前置条件。两者都不减少未完成责任数量。本阶段不存在动态新增上限、在制上限或任务名额回收操作；删除原2/3累计上限后不要换一种配额替代。计数和分页仍保留，便于观察。

共享Mission某个Execution交接时，只撤销它自己的执行权，记录它自己的Progress/Workspace来源。其他执行者继续，聚合Task状态仍可为RUNNING；没有执行者时为OPEN，只要Mission未结束就仍可认领。一个执行者的handoff、局部失败或轮换不能关闭Mission，不能撤销其他执行者的权限。

Execution只在以下边界结束：Task完成；明确前置条件阻塞（block）；Runtime截止提醒；compaction轮换（§5）；明确要求handoff的通知。只读研究阶段是正常工作，Judge FAIL也不是结束理由；prompt不鼓励Agent主动handoff。

每个Execution都有独立worktree和快照引用。共享Task不使用一个可被所有人覆盖的“最新工作目录/commit”。恢复指定前驱Execution/Progress Material所指的commit；其他路线结果通过Material按需读取。最终候选由任一有权限的执行者提交，按固定原题验收。

## 4. Progress Material与最小Git接续

Progress Material包含completed_work、findings、open_questions、next_step，以及有文件工作时的workspace_commit和来源Execution。Checkpoint与handoff使用同一内容格式；工具内部完成Material、来源、Task链接和进度指针，Agent不用逐项调用低层接口。

文件路径只做最小本地实现：为Execution从输入或指定快照commit创建独立worktree；保存时提交允许的工作文件，再发布引用该commit的Progress Material；恢复从最后一次成功记录的对应commit创建新的worktree。无文件的研究直接保存Material，不要求Git目录。对文件工作不保留非Git fallback。

只提交明确允许的tracked/untracked工作文件，排除凭据、原始对话、运行数据库、构建缓存和不属于成果的元数据。快照留在Runtime本地仓库，以普通本地引用保留；不修改/推送项目主分支，不自动跨Task merge，不建立远程同步、通用快照事务或高级垃圾回收框架。

保存采取一次有界尝试。成功保存才更新有效接续指针。commit或Material保存失败，记录save_failed、失败阶段、最后有效快照和本次未保存状态可能丢失；随后照常停止、解除绑定或轮换。不要求Agent无限重试，也不需要保存所有失败的脏工作面。之前已成功的commit/Material保留；不得把失败标成成功handoff。

checkpoint保存失败可返回错误并继续当前Execution；到handoff/rotation时失败则允许丢弃本次未保存状态。新执行优先恢复最后成功快照；没有快照时从输入材料重启，并明确说明从哪里恢复。正常实验应展示保存与接续成功；故障注入只证明失败不把系统卡住，不能代替正常路径的成功证据。

## 5. compaction：三次以后，下一轮达到80%再交接

flat模型下单个Execution的时间盒等于运行总时长（1h/2h），截止时间为全运行截止时间；截止提醒在全运行截止前min(5分钟, 时长/10)发送。identity寿命由compaction次数与80%窗口决定。（r15修订，原为30/25分钟。）

配置默认max_compactions=3、handoff_window_ratio=0.8。计数属于identity，跨其连续认领的Tasks累计；完成一个Task不重置计数。window_ratio指当前上下文token估计数除以模型上下文窗口，不是运行累计token。

```text
已完成compaction次数 < 3：可按正常规则compact，成功后计数+1并保存checkpoint。
刚完成第3次：允许继续研究，不立即退休。
已完成3次，当前window_ratio < 0.8：继续研究。
已完成3次，window_ratio >= 0.8：进入handoff，旧identity不再开始普通研究调用；保存后停止。
第4次compaction：不允许发生；必要时先停止旧执行，按保存失败/强制停止路径处理。
```

Runtime在新模型调用前及使用量更新时检查比例，记录计数、估计来源和触发值。第三次以后必须在自动compaction入口阻止第四次，而非等compaction_end发生才发现超限。窗口数值不可取得时不能按0%继续；第一阶段采用显式记录原因并提前交接的保守路径，实际模型/SDK支持情况在实现probe中验证。

compaction_end后的checkpoint提醒排在当前turn settled之后，不启动并发turn；若此时已应handoff，则合并成一次handoff保存，不连续制造两次同内容保存。首次、第二次compaction不会仅因其压缩前超过80%就触发这里的identity轮换。

没有普通Task时继续Mission，与达到轮换条件后结束旧identity不冲突：轮换替换的是Session，Mission研究由新identity接着做。空队列不是轮换原因；触发阈值时即使处于短暂任务切换，也要结束旧identity并补充新identity，不创建虚假的handoff任务。旧identity无当前Execution时，不伪造新的Progress Material。

保存失败不阻止停止，费用、已完成compaction、最后有效快照和轮换原因如实保留。新identity计数从0开始，Task/Mission累计消耗不归零。

## 6. 反馈与写入隔离

反馈保持Task身份，必要时指明source/recipient Execution和Material。普通Task反馈由当前或后续执行者处理。共享Mission有多个有效Execution时，对实际受影响或明确订阅的执行者分别投递并记录处理；一个分支的确认不能清空所有人的待办。

普通消息排队，有效纠正在安全点处理；过期的Execution截止提醒不转投。处理结果指向相关证据和后续动作，不把delivered当作已改变行为。公共材料不自动要求所有人读全部历史。

撤销执行权以具体Execution为边界。旧分支无法写入自己或别人的新工作面；另一个共享Mission执行者仍能工作。Mission成功或全局授权停止才由运行机制收束全体，不允许普通同伴任意取消整体目标。

## 7. 实现归属与不做的内容

S1继续负责Judge工具迭代与严格验收。

S2负责共享Mission/普通分工差异、identity复用自身Core的主动工作循环、无任务配额、权威状态，以及最低可用Progress/本地Git checkpoint和主动handoff。普通任务结束后回到Mission，同一identity可以继续下一项。基本时间盒、截止提醒和失败不阻塞也在此交付。

S3在S2基础上负责运行中反馈、分支级处理状态、compaction计数/80%轮换、已投递未处理反馈的接续和异常恢复。S2不要求S3自动compaction轮换通过才能验收；S2测试若因旧行为越界，必须如实暴露，不能伪称阶段功能已具备。

不引入任务配额、复杂状态机框架、任意合同编辑器、全局语义去重、智能调度、Git跨Task自动合并或prompt调优。各项实现对应的正常、竞争和失败现象见逐项行为验收表。
