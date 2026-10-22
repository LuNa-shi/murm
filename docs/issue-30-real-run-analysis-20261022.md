# Issue 30：12 个一小时真实实验分析

## 结论

这次运行支持一个谨慎的乐观结论：Agent 之间的任务分解、claim、独立 Workspace、Material/candidate 交付、parent review、wait/wake/resume 和 Core 复用已经在真实运行中出现，系统没有退回到单一 Root Agent 的模式。另一方面，协作还没有稳定地转化成更快的解题进展。12 个项目中，4 个通过了 Judge，8 个没有通过；旧报告把其中 2 个项目标成 invalid，但这两个 invalid 的原因是 Agent 调用了返回普通 Service 错误的工具，不是 SwarmEnv 协议被破坏。按修复后的审计语义，这类错误应作为 Agent feedback，而不是整题 invalid。

因此，这次实验可以证明“协作链路在工作”和“Benchmark 表现没有退步”，不能证明“当前 Swarm 已经比单 Agent 更高效”。后者需要配对 baseline 和同题复现实验。

## 实验边界和证据

- Run：`issue-30-real-1h-20261022T031501Z`
- SwarmEnv commit：`d4e9ed218b12bead0606a572e281ef3c61a6dc23`
- 12 题，4 个 Core，项目并行度 3，每题 timebox 1 小时。
- PutnamBench commit：`a635813f5edf297d928f9bd5ef8324a26bdde09c`
- Lean toolchain：`leanprover/lean4:v4.33.1`；完整 Lake build 通过。
- Provider/model：`openai` / `openai/gpt-6-luna`。
- 原始 transcript 和 proof contents 没有导出；分析使用 sanitized reports、Experiment metadata、Task Service 数据和允许的 Observability 字段。
- 证据目录：`experiments/issue-30-real-1h-20261022T031501Z` 和 `reports/issue-30-real-1h-20261022T031501Z`。

旧报告的结果是 4 solved、2 invalid、6 unsolved。2 个 invalid 是 2021 B5 和 2022 B5，旧规则把不可重试的 Service tool error 直接计入 invalid。2022 B5 的最终 Task/Execution 记录已经是 Root SATISFIED、Child SATISFIED，且有 PASS candidate；它应在重新审计后按成功处理。2021 B5 仍有 3 次 FAIL，Root 最后在 timer wait，不能按成功处理。

## 这一小时 Agent 实际做了什么

所有题目都执行了同一类可观察循环：发现 Service、Task 和工具，读取 Root/Child Task、Execution、Workspace 和已有 Material，claim 工作，读写自己的 Workspace，发布 Material 或提交 candidate，读取 Judge CheckResult，再根据结果继续、创建 child、等待、接受或要求返工，并在必要时 wake/resume。

简单题主要由 Root 直接探索并提交候选。需要分解的题目出现了真实 child Task 和独立 Execution；child 产生研究材料、候选或失败诊断后，Root 或 parent review 继续处理。2024 B4 是最清楚的停滞样本：child Workspace 中留下了关于 uniform independence 的研究材料，指出 h1/h3 没有立即矛盾、n=1 的 one-point law 一致，但还缺少 distributional/a.e. 解释、积分和可测性条件。这是有内容的数学 context，却还没有转化成可检查 proof。该题还发生了大量重复 scheduler/list/claim 操作，最终 Root 为 WAITING、Child Task 为 RUNNING，而 Child Execution 仍为 CREATED，显示交接末状态需要继续修复和审计。

2023 B1 是协作活动最完整的例子：2 个 child、5 次 wake、6 次 Root claim、6 次 FAIL。Child 都完成了 SAT，但 Root 没有拿到 PASS，因此它证明了协作闭环能运行，不能证明协作已经找到数学路线。2024 B5 有 3 个 SAT child 和 8 次候选检查，但 8 次都 FAIL，Root 仍 OPEN。这些运行不是空转；问题在于得到的研究和反馈还不足以收敛到可验证证明。

## 12 个项目逐项结果

| 题目 | Judge/报告结果 | 协作事实 | 最后进展和距离 | 主要阻塞 |
| --- | --- | --- | --- | --- |
| 2019 B6 | PASS；3 checks | 无 child，Root 直接完成 | FAIL → FAIL → PASS；距离为 0 | 无明显阻塞 |
| 2020 B4 | PASS；2 checks | 无 child，Root 直接完成 | FAIL → PASS；距离为 0 | 无明显阻塞 |
| 2021 B3 | PASS；2 checks | 无 child，Root 直接完成 | FAIL → PASS；距离为 0 | 无明显阻塞 |
| 2021 B5 | FAIL；旧报告 invalid；2 child、4 claims、3 FAIL | Child 均 SAT，发生 accept、wake、resume | Root 最后 timer WAITING；还缺少通过 Judge 的 proof | 数学路线未收敛，且有旧的过严 invalid 规则 |
| 2022 B5 | PASS；旧报告 invalid；1 child、7 checks | Child/Root 最终均 SATISFIED，发生 review、wake、resume | 已有 PASS；应重新审计为成功 | 旧规则把普通 tool error 当成 protocol invalid |
| 2022 B6 | PASS；1 check | 无 child，Root 直接完成 | 单次 PASS；距离为 0 | 无明显阻塞 |
| 2023 B1 | FAIL；6 checks | 2 child、2 child claims、5 wake、6 Root claims | 6 次都 FAIL，Root OPEN；child 已 SAT | 交付发生，但 Root 没有形成 PASS 路线 |
| 2023 B4 | FAIL；12 checks | 2 child；1 child SAT、另一个仍 OPEN；Root WAITING | 12 次都 FAIL；Root 等 child terminal | 还有 child 未完成，且候选没有变得更接近 |
| 2024 B4 | FAIL；2 checks | 1 child、2 claims、2 rework、4 wait、1 wake | 一个约 34.7s 的检查和一个约 6s 的 FAIL；child 有研究材料但无 proof | ready work 长时间无人接手，末状态出现 Task/Execution 不一致 |
| 2024 B5 | FAIL；8 checks | 3 child、3 child claims，均完成 SAT | 8 次都 FAIL；Root OPEN | 协作供给充分，但证明路线没有收敛 |
| 2025 B1 | FAIL；4 checks | 1 child SAT、3 wake、4 Root claims | 4 次都 FAIL；Root OPEN | 有交付和恢复，但没有通过候选 |
| 2025 B4 | FAIL；4 checks | 1 child，1 rework；child WAITING parent_review | 4 次都 FAIL；Root OPEN | review/rework 尚未转化成新候选 |

全批次共有 54 次 candidate check 和 13 个 child Task。多数未解项目有实际 Workspace/Task 状态变化，但未出现 PASS；这正是“实验在推进”和“题目已接近成功”必须分开报告的原因。

## 协作是否打通

可以确认已经打通的环节包括：

1. Root 能创建有目标和交付路径的 direct child Task。
2. Child 被不同 Core claim，并进入自己的 Execution/Workspace。
3. Child 能读写 Workspace，发布 Material 或 candidate。
4. Root/parent 能看到 child 的状态，并出现 accept、rework、wake 和 resume。
5. WAITING 的责任可以被唤醒，Core 可以被重新利用。
6. Tool error 会被记录在 turn 中，运行还可以继续产生后续事件。

尚未证明的环节包括：每个 child 的结果都被 Root 读取并用于下一条数学路线；Material 的内容足以缩短 proof distance；多个 Core 的并发让 time-to-pass 变短。当前报告能证明事件链存在，不能自动判断一段研究材料对证明是否有用；应由 Root Agent 根据 Task contract 决定。

## eligible window 为什么是 0

`eligible_window_ms` 是一个供给诊断，不是成功门槛。当前实现只有在同一时刻存在至少 `coreCount` 个独立、未完成且可运行的 child work 时才计入 eligible interval。本次使用 4 个 Core，但任何项目同时存在的独立 child work 都没有达到 4 个；最高只达到 3 个。因此 12 个项目全部是 0。

这说明本次题目分解没有提供足够的四路独立工作，不能说明 scheduler 没有能力，也不能把它当作 bug。后续应同时报告 `ready_work_ms` 和 `ready_unassigned_ms`：前者说明有多少时间存在可做工作，后者说明这些工作有没有 owner。本次部分项目的 ready-unassigned 很大，尤其 2024 B4；这比 eligible=0 更直接地指出了调度和 handoff 的问题。

## 11.76% 是什么

全批次平均 `agent_time_utilization_v0` 为 11.76%。它的定义是：显式记录的 Agent turn 时间除以 `Core 数 × 实验 elapsed time`。它不包括 IDLE、semantic WAITING、scheduler polling、Judge 检查、Core 传输和 turn 占用以外的时间。因此它只能回答“Core 有多少时间在执行 Agent turn”，不能回答“有多少时间在有效解题”。

低比例同时受到题目本身不可并行、Agent 经常等待 Judge、项目并行度和一小时内 child 供给不足的影响。要判断浪费，必须结合强进展事件、ready-unassigned、无进展区间、candidate/check 序列和最终状态；不能把 11.76% 单独作为系统质量分数。

## Try 是否变短

目前报告有可靠的 Judge `check_elapsed_ms`，但没有完整记录“上一轮 Judge feedback 到下一次 candidate”的端到端间隔，因此不能声称 Agent Try 总用时普遍缩短。

可见的 Judge 检查大多稳定在约 6–10 秒。2019 B6 的检查为约 10.4s、9.7s、5.9s，最后一次变短且 PASS；这是一个局部成功样本。2024 B4 有约 34.7s 的异常长检查后又回到约 6s，但两次都 FAIL；这不能算效率提升。2022 B5 中有一次约 17s 的 child 检查，也没有足够证据证明它改变了路线。后续需要补充 candidate-to-candidate interval、turn duration、feedback read 和 candidate lineage，才能回答 Try 是否真正缩短。

## 已调研并修复的两个问题

### 1. 实验结束后 Agent 子进程可能残留

原因是 `stopCore` 过去只停止当前或 released session，没有遍历 Core 的历史 handoff session；`AgentCoreSession.stop()` 发送 SIGTERM 后也不等待 child 的 close。旧 session 可以因此继续持有子进程。

修复内容：停止 Core 时收集 session history、current、released 和 active session，逐一等待退出；SIGTERM 超时后升级为 SIGKILL，并继续清理剩余 session。新增测试覆盖忽略 SIGTERM、等待 close 和升级 SIGKILL 的路径。Observability daemon 本身是独立的长期服务，不把它误判为本次实验残留。

代码 review 又发现同一生命周期边界：Runtime 的 wait、terminal stop、fence、expire 和 restart 路径曾经在发送 stop 后立即释放 active ownership。现在这些路径先从 active map 摘除，再等待 Agent 退出，避免 close 回调与 Task terminal transition 竞争造成 stale version；新增 Runtime 测试验证 wait 会在释放容量前等待 Agent close。

### 2. 普通 Agent Tool Error 会把实验标成 invalid

Service tool 返回 `NOT_ALLOWED`、`STALE_VERSION`、`CONFLICT` 或其他边界反馈时，Bridge 已经把错误返回给 Agent；这类错误可能只是 Agent 参数过期或调用顺序不对。旧 runner 用 `!recoverable` 推导 protocol error，导致普通 Service error 被升级为 `agent_tool_error`，从而把项目 invalid，阻断了正确的实验分析。

修复内容：只有明确标记为 protocol error 的事件才能产生 `agent_tool_protocol_error`；普通 Service error 会保留在 tool error 统计中，作为 Agent feedback，不再使整个项目 invalid。Prompt 也改为要求 Agent 读取错误、修正并重试，或结束当前 turn 交给 Runtime 后续调度。新增回归测试验证普通错误后仍可完成 run，真正的 INVALID_CONTRACT 仍按协议错误处理。

## 评价 Swarm 是否有优势

本次运行之后，结论应分为三层：

- **运行能力**：已证明 child、Workspace、Material、review、wake/resume 和 Core 复用可发生。
- **解题结果**：相对之前 4 题结果没有退步；不重跑全量 Benchmark。
- **相对效率**：尚未证明优于单 Agent。需要对典型未解题做同模型、同 timebox 的 root-only baseline 和修复后的 Swarm 配对运行，比较 time-to-first-check、time-to-first-pass、独立路线数量、feedback 是否被读取、ready-unassigned、无进展区间和 cleanup 可靠性。

下一步选择 2024 B4 和 2025 B4 做短时 targeted pilot。选择它们是因为前者暴露 ready/handoff 停滞和状态不一致，后者有 child review/rework 但未形成 PASS；它们可以分别验证生命周期修复和 Tool Error/Agent feedback 修复是否带来可观察进展。pilot 的目标是比较协作轨迹和阻塞类型，不把一次短时运行宣称为 Benchmark 提升。

## 修复后的 targeted pilot

两个 pilot 都在干净 commit `27116559ac258c91e6f8d15baff5b9fa2d84aacc` 上运行，使用相同的 4 Core、单项目并行、`openai/gpt-6-luna`，每题 10 分钟；没有重跑 12 题 Benchmark。

| Pilot | 可观察进展 | Tool/调度事实 | 结论 |
| --- | --- | --- | --- |
| 2024 B4 | `protocol_valid=true`、`made_progress=true`；1 child、1 Workspace write、1 meaningful Material；0 candidate | 1 次普通 `CONFLICT`，protocol error 为 0；ready-unassigned 约 69.7s；cleanup 159ms | 生命周期和普通错误审计修复生效，child 产生了研究 context，但没有进入 proof/check |
| 2025 B4 | `protocol_valid=true`、`made_progress=true`；1 Workspace write；0 child、0 Material、0 candidate | 3 次普通 `CONFLICT`，protocol error 为 0；ready-unassigned 约 118.6s；cleanup 120ms | 错误没有阻断项目，但没有形成 decomposition 或 dispatch；下一步应优化 work discovery/停滞恢复 |

两个 pilot 都在报告写出后正常退出，没有残留 benchmark runner 或 Agent/NuRouter 子进程。8790/8791 上留下的是每个 pilot 独立的 Observability daemon，它是报告查询服务，不是实验 Agent 残留。pilot 没有证明题目更接近 PASS，但 2024 B4 的 Material 交付和两题的 `made_progress` 证明修复后的审计能够把“运行过”和“产生了什么”区分开。

本次的标准分析方法已单独整理在 [`benchmark-analysis-sop.md`](benchmark-analysis-sop.md)。
