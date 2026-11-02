# S3｜让证据改变当前工作，并在接续后继续有效

状态：Issue草案，未发布。依赖：S2。规范：P1、P6–P11。负责[核对表](../../reviews/phase-1-conformance-audit.md)F1–F10及新增同类偏差。

## 交付行为

任务A仍执行时收到相关结果，核对证据后改变下一步或有依据地拒绝质疑。A交接或被中断后，新的 Agent identity 从 Progress Material、未处理反馈和 Git Workspace commit 继续工作，资源账目与执行权保持正确。消息、材料用途、责任调整、compaction 轮换和接续必须共同交付。

## 必须完成的修复

Task收件箱区分投递与处理。已投递但未处理的研究反馈仍可接续；旧Execution截止提醒失效。compaction结束后，Runtime 必须在当前 turn settled 后要求 Agent 保存 Checkpoint Material；达到 Agent identity 的 compaction 上限且上下文压力达到登记阈值时，必须保存 Handoff Material、提交 Git Workspace lineage 并轮换到新的 Pi identity。投递失败、重放和重启具备明确结果，安全点可处理重要反馈，必要时对长工具调用提供有限等待/中断边界。

当前负责人可依据反馈改变方法或明确调整/结束自己的责任；同伴不能任意取消他人。范围实质变化可采用结束原Task并关联后续Task，避免构建任意在线合同编辑器。取消前置责任须通知受影响Task，由其选择修改或结束，不能伪造依赖成功或无限无解释阻塞。

Material生产来源保持不可变，引用用途按接收关系表达。继任执行者可引用旧材料，不冒充原生产者、不必复制内容；多个接收者分别保存接受/质疑结果，旧CLOSED保留迁移说明。

统一Task内执行序列和前驱、Agent identity/Session边界、Execution 时间盒、Git Workspace 接续及累计消耗；修正短窗口提醒提前量。有效handoff、identity rotation、强制超时和实验清理分别记录，不用定时换人代替运行中反馈。Checkpoint 与 Handoff 可共享同一 Progress Material 格式，但释放 Execution 的状态转换必须显式记录。

## 两小时真实验收

与S2父实现按[共同协议](../../validation/phase-1-acceptance.md)匹配。至少两条不同的相关反馈形成完整链：一条在原Execution结束前处理；另一条跨Execution处理，覆盖已投递未处理或交接前待投递情形。至少一条带来可验证的内容、假设或任务范围变化，或通过新检查可靠说明质疑不适用。仅已读/同意不算。

暂定处理门槛：正常provider下，从有效反馈发布开始不超过两个可处理安全点且120秒内给出明确决定。长工具等待仍计墙钟，异常按预登记规则报告，不事后排除。

至少一次真实接续在恢复资格具备后300秒内开展依赖旧成果的实际工作，保存消息身份、有效材料和累计消耗。可按预登记规则在成果持久化后中断一次真实执行，双侧采用同样触发规则并单独标记受控干预，不能将它冒充自然handoff。

对照需存在漏处理、迟处理或重复恢复中的至少一种可定位现象；处理运行消除对应缺陷并达到上述绝对门槛。逐事件列出反馈闭环比例、失效方向继续消耗时间和恢复成本；没有可靠的事实依据不能判定工作已失效。无目标事件为INCONCLUSIVE，真实触发仍丢失/错误则FAIL。

## 回归与关闭条件

覆盖投递后处理状态、未投递转投、旧截止提醒不转投、失败重试、取消与晚到写入、前置取消、短窗口提醒、同材料多用途/继任者引用、多接收者接受及单一有效执行权。补充 compaction 后 checkpoint follow-up、identity compaction 上限、Handoff Material、Git commit/worktree 接续和无 Workspace 任务的进度保存。每个已确认偏差都要有可重复回归；不要求所有竞态在同一两小时中自然发生。

F1–F10及新增同类问题完成归属处理，真实反馈确实改变工作且接续使用既有成果，安全/资源回归通过，Task报告可解释全过程，才能关闭。不开展全局共识、自动争议裁判、复杂检索或更优prompt研究。
