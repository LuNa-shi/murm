# Agent Swarm 实验分析 SOP

这份 SOP 用来分析一次真实 Agent Swarm 实验。它把系统是否正常运行、Agent 是否完成协作、题目是否取得数学或 Lean 进展、以及四个 Core 是否被有效利用分开判断。最终解题率只是其中一个结果，不能代替运行过程分析。

## 一、先固定证据边界

分析开始时记录以下事实：

- SwarmEnv commit、worktree 是否 dirty、PutnamBench commit、Lean toolchain、checker、provider、model、Core 数、项目并行度和 timebox。
- 每个项目的 sanitized report.json、aggregate report、experiment metadata 和本地 Observability 数据库位置。
- 是否导出了 raw transcript、candidate source 或 proof contents。报告分析只能引用允许导出的字段；原始本地日志可以用于诊断，但不应写入 Git 或公开报告。

每个结论都要指向一类可重算证据：Task/Execution 状态、claim、Workspace revision、Material 发布或读取、candidate submission、Judge CheckResult、parent review、wake/resume、Core 状态和 Agent turn。不要把模型文字中的自我描述当成完成证据。

## 二、用四层标准判断“正在推进”

### 1. 协议层：系统有没有正常运行

协议层只问生命周期是否连通：

Task 创建 → Worker 发现 → claim → Runtime handoff → Workspace/Material 操作 → candidate/Judge → parent review → accept/rework → wake/resume → Root 读取结果

下面这些事实可以证明链路的相应部分已经发生：

- 子任务被真实创建，并由非固定角色的 Core claim。
- Worker 在自己的 Execution 中读到 Task、Execution 和 Workspace。
- Child 发布 Material 或 candidate，Root 随后的 Execution 读取了它。
- parent_review、accept_task、request_rework、wake_execution 和同一 Execution/Workspace lineage 的继续执行都能在持久化记录中对上。
- Tool error 被返回给 Agent 并记录，但后续仍有新的 turn、claim 或 work unit。

协议层不能证明结果有用，也不能证明题目已经接近解出。它只证明系统把责任、结果和反馈交付到了正确的边界。

### 2. 进展层：有没有产生外部可观察的新状态

把工作分成三类：

| 类别 | 例子 | 解释 |
| --- | --- | --- |
| 强进展 | 新 Task、Workspace 新 revision、Material、candidate check、Task terminal state、parent accept/rework、Root 读取 child result | 持久化状态发生了可审计变化 |
| 反馈进展 | Judge FAIL 的新 diagnostic、Tool error 返回后继续执行、child 被重新唤醒 | 不一定接近证明，但改变了后续决策空间 |
| 活动 | list/read、heartbeat、scheduler poll、重复读取同一结果、等待没有新事件 | 只能说明进程活着，不能当作推进 |

一个项目“正在推进”需要在 timebox 内反复出现强进展或反馈进展，并且这些进展要改变 Task、Workspace、Material、candidate 或 Judge 的状态。只统计 turn 数、token 数、文件访问次数或模型声称“完成”会把忙碌误判成进展。

### 3. 题目层：证明数据是否朝完成移动

对于 Lean 题目，按 candidate 顺序记录：

- FAIL/PASS 和诊断类别；
- candidate submission 到 CheckResult 的用时；
- 是否从 checker/placeholder 错误转向具体 proof error，再转向 PASS；
- 新 candidate 是否来自新 Workspace revision，是否读过最新 Judge feedback；
- root/child Task 是否因为实际 Judge 结果达到 contract 而进入 terminal state。

“Try 是否缩短”要拆成两个指标。Lean checker 的 check_elapsed_ms 只表示检查时间；模型从上一次反馈到下一次候选的间隔还包括 Agent turn、读取材料和等待。两者必须分别报告。一次更快的失败不是效率提升，一次更慢但诊断更具体的失败可能是有效反馈。

### 4. 效率层：时间是否被用在应该做的地方

至少报告以下时间：

- Agent turn time；
- Judge time；
- IDLE、WAITING、scheduler poll 和 Core 传输时间；
- ready work 时间以及 ready 但没有 owner 的时间；
- candidate 之间的间隔；
- 没有任何强进展的连续区间。

agent_time_utilization_v0 的定义是显式 Agent turn 时间除以 Core 数 × 实验 elapsed time。它不是解题进度，也不是“系统效率”的单一答案。当前 eligible_window_ms 是供给诊断：只有同时存在足够多的独立、未完成工作时才计入；它不是 hard gate，也没有固定的 3.0 门槛。若它是零，先报告独立工作供给不足，再看是否有 ready-unassigned、claim 冲突或 wake 失败。

## 三、用什么标准判断 Agent Swarm 是否具有优势

一次真实运行只能证明能力是否存在，不能单独证明相对优势。优势必须在同一题目、同一输入、同一模型和同一 timebox 下做配对比较：

1. 单 Agent/root-only baseline：一个 Core，不创建或消费 child。
2. Swarm：当前四个可复用 Core、共享 Task queue、Material handoff、parent review 和 rework。
3. 必要时增加调度对照：四个 Core 但关闭跨 Agent handoff，用来区分“更多并行尝试”和“真正协作”。

比较以下轨迹，而不是只比较最终 solved：

- time_to_first_checked_candidate 和 time_to_first_pass；
- 在相同时间内产生的独立路线、Workspace revision、Material 和 Judge feedback；
- Root 是否读到 child result，并能据此 accept、rework 或改变后续路线；
- wait/resume 是否释放并复用了 Core；
- tool error、claim conflict、重复 discovery 和无进展区间；
- 失败项目距离成功的最后可验证状态。

如果 Swarm 只产生更多失败候选，不能称为优势。如果它让更多独立路线被真实执行、让反馈被交付并用于下一轮、让等待责任被恢复，同时在相同题目上取得更好的 time-to-pass 或最终结果，才有证据支持协作优势。这个标准不要求系统自动判断研究 Material 的语义价值；研究结果是否有用由 Root Agent 和 Task contract 决定。

## 四、单个实验的固定分析顺序

### A. 环境和审计

先检查 commit、输入 hash、版本、timebox、报告 schema、protocol_valid、made_progress、audit.invalid_reasons 和 worktree 状态。Tool error 要单独列出，不能直接等同于 protocol invalid。

### B. 重建 Task/Execution 图

列出 Root、Child、每个 Execution 的 attempt、owner、state、wait condition、candidate 和 Workspace lineage。检查 Task 状态与 Execution 状态是否相容，例如 Task=RUNNING 但唯一 Execution 仍为 CREATED 就是诊断信号。

### C. 重建时间线

按时间分成：

1. 启动和初始 discovery；
2. Root 探索和分解；
3. Child 执行；
4. candidate/check/feedback；
5. parent review、accept/rework、wake/resume；
6. 最后的继续推进或停滞。

每一段都回答“谁 claim 了什么、做了什么有状态变化的工作、把结果交给了谁、下一步为什么开始或没有开始”。

### D. 检查协作闭环

用如下矩阵逐项填充：

| 环节 | 证据 | 结论 |
| --- | --- | --- |
| Decomposition | child task count、goal、contract | Root 是否产生了真实独立工作 |
| Queue/claim | child claim、Core、Execution | 生产 queue 是否消费了 child |
| Delivery | Material、candidate、Workspace revision | Child 是否交付结果 |
| Root read | material_reads.source_task_ids、Root turn | Root 是否读到每个预期 child |
| Review | accept/rework、target state version | Parent 是否做出 review 决策 |
| Recovery | wait/wake/resume、lineage | 等待是否释放容量并恢复责任 |
| Completion | CheckResult、Task terminal state | 协作是否转化成 contract 完成 |

“链路打通”要求前六项能对上；“协作有效”还要求交付后的 Root 或 sibling 产生了新的强进展。

### E. 分析调度和浪费

同时查看 ready_work_ms、ready_unassigned_ms、mean_active_core_count、max_active_core_count、concurrency histogram、eligible window、claim conflicts、tool errors、turn durations 和 no-progress intervals。

将停滞归入一个主要类别：

- 没有可独立拆分的工作；
- 有 ready work 但没有被 claim；
- claim/wake/release 生命周期故障；
- Tool error 后 Agent 没有继续；
- Judge feedback 没有被读取或没有改变候选；
- 题目本身仍然没有可验证的数学路线；
- cleanup 或 timebox 截断了最后状态。

### F. 分析题目数据和距离

用 candidate/diagnostic 序列、Workspace revisions、Materials、Task terminal states 和最后一个未完成依赖回答：

- 最后一次真实有效工作是什么；
- 距离 root contract 还差哪个必要条件；
- 是否有更具体或更接近的 Judge feedback；
- 反复尝试是在修正同一个错误，还是一直提交同一类错误；
- 如果是协作题，未完成的是数学证明，还是交付/审查/唤醒。

不要用“child 结果有用/没用”的自动语义判断替代 Root 的读取和决策证据。

## 五、如何衡量一次优化确实提升了协作能力

优化前后必须保持输入、模型路由、版本和 timebox 可比，并记录 prompt hash 和代码 commit。先做短 pilot 观察事件链是否改变，再做配对运行观察题目轨迹。

一个优化只有在至少改善一类可重算事实，并且没有把另一类事实明显变坏时才值得保留。例如：

- Tool error 后仍能出现后续 turn、claim 或 candidate；
- child 交付后 Root 更快读取并做 accept/rework；
- wait 释放的 Core 被另一项真正独立工作复用；
- claim conflict、重复 discovery 或 ready-unassigned 时间下降；
- 同一题的 Judge diagnostic 从泛化错误变成具体 proof error，或最终出现 PASS；
- cleanup 后所有 Agent session 和子进程都能在报告写完后退出。

最终优势仍应使用 paired baseline 的 time_to_pass、结果质量和协作闭环覆盖来判断。单个 pilot 的新 Material 或一次更快 FAIL 只能证明方向值得继续验证。

## 六、标准输出模板

每个项目至少输出：

project:
audit:
environment:
task_graph:
collaboration:
progress:
candidate_sequence:
try_duration:
parallelism:
tool_errors:
blocking_reason:
distance_to_success:
operator_action:

整批实验最后输出：

1. 协议层通过、部分通过、失败的项目数；
2. 协作闭环覆盖情况；
3. 有强进展但未解出的项目及其最后状态；
4. 题目供给不足、调度故障、工具恢复故障和数学路线故障的分布；
5. 与 baseline 的可比指标；
6. 需要修复的代码问题和下一轮针对性 pilot。

