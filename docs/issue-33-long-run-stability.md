# Issue #33 follow-up: 8 小时长时程运行的稳定性与有效进展

## 标题

修复长时程运行中的 Root 进展停滞、等待占用和调度证据缺口

## 背景

本 Issue 只分析 `issue-33-long-8h-20261022-b` 中已经完整结束的三个 8 小时项目：

- `putnam_2025_b1`
- `putnam_2025_b4`
- `putnam_2024_b4`

固定条件为 SwarmEnv commit `1e8df5eb067001dd72bd8b1fd4e478b229d4150d`、4 个 Core、项目并行度 3、`openai/gpt-6.1-sol`、8 小时时间窗和锁定的 PutnamBench 输入。分析依据是每个项目的 sanitized `report.json`、项目 SQLite 和本地 Observability 记录；没有导出 transcript、candidate source 或 proof contents。

## 事实结论

三项运行都达到 deadline，`protocol_valid=true`，`made_progress=true`，`ended_early=false`，清理耗时小于 1 秒，heartbeat error 为 0。因此没有证据表明进程在 8 小时内崩溃、Workspace fencing 失效或责任丢失。

但三项运行的 Root PASS 和 Root completion 均为 0：

| 项目 | elapsed ms | Root PASS | child tasks | candidate checks | tool errors | claim conflicts | agent utilization | mean active cores | max active cores | ready-unassigned ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `putnam_2025_b1` | 28,804,715 | 0 | 6 | 1 | 4 | 4 | 0.214 | 0.856 | 3 | 276,848 |
| `putnam_2025_b4` | 28,804,197 | 0 | 3 | 8 | 14 | 11 | 0.217 | 0.866 | 2 | 257,632 |
| `putnam_2024_b4` | 28,803,315 | 0 | 1 | 7 | 7 | 6 | 0.221 | 0.884 | 2 | 201,076 |

另外：

- `putnam_2025_b1` 的 1 次候选检查为 FAIL；6 个 child task、11 次 workspace write 和 11 个 meaningful materials 没有转化为 Root 候选进展。
- `putnam_2025_b4` 的 8 次候选检查全部为 FAIL；失败后发生了 3 次 rework，但没有 PASS。工具错误类别包含 `STALE_VERSION`、`CONFLICT`、`INVALID_CONTRACT` 和 `NOT_ALLOWED`。
- `putnam_2024_b4` 的 7 次候选检查全部为 FAIL；只有 1 个 child task，Root 仍保持 OPEN。
- 三题的大量 Core 时间处于 WAITING：每题各 Core 的等待时间大多约为 26–28 百万毫秒，远高于实际 Agent turn 时间。
- 三题 `ready_unassigned_ms` 为 201–277 秒，但分类覆盖率为 0，最终只能记为 `unclassified`。因此当前报告无法回答这些 ready work 是 discovery 延迟、长 Agent turn、可调度 Core 未派发、缺失 wake/resume，还是任务供给不足。
- `heartbeat_error_count=0` 只证明租约保活正常，不能证明 Agent 在有效推进。

## 问题定义

长时程系统当前具有“生命周期稳定性”，但不具有“有效进展稳定性”：它可以保持 Execution、Workspace、Material 和 heartbeat 合法运行数小时，却允许 Root 长时间等待、重复处理失败路线、低并发占用和未分类 ready work，而没有可审计的停滞检测、路线切换或终止策略。

## 根因假设

### A. Root 等待后的进展门槛不足

Root 可以在 child 完成、parent review 或 timer 条件下反复 wake，但没有明确的停滞窗口和下一动作 contract。child 已经被 accept 或 rework，并不保证 Root 获得了新的可检查候选。长时间等待因此被记录为合法 WAITING，而不是“等待条件已满足但没有产生 Root 进展”的诊断。

### B. 失败反馈没有形成强制的路线新颖性约束

`putnam_2025_b4` 有 8 次 applied FAIL 和 3 次 rework，`putnam_2024_b4` 有 7 次 applied FAIL，但现有报告没有证明每次失败后都产生了新的、可区分的证明路线。当前系统能记录失败与 rework，却没有以候选 snapshot、Workspace revision、诊断类别和后续路线组成可执行的重复失败 gate。

### C. 四个 Core 的容量没有转化为独立有效工作

三题的最大活跃 Core 数为 2，平均活跃 Core 数小于 0.9；其余 Core 长时间 WAITING 或 IDLE。`eligible_window_ms=0` 不能直接解释为调度失败，因为当前还没有足够的独立供给分类证据；但它明确说明系统尚未证明四核并行在长时程阶段有可供执行的独立工作。

### D. ready work 的调度归因不可审计

`ready_unassigned_ms` 非零但分类覆盖率为 0。没有原因时间线，就无法区分调度器漏派、Agent 长 turn、claim 冲突、wake 失败和确实没有合适的独立工作。这会阻止后续迭代进行因果判断。

### E. 工具错误虽可恢复，但恢复成本没有进入 Root 进展判据

三题工具错误共 25 次，claim conflict 共 21 次。错误没有使运行失效，但 `STALE_VERSION`、`INVALID_CONTRACT`、`NOT_ALLOWED` 和冲突可能消耗了长时程预算。当前系统只证明“错误后仍能继续”，没有证明恢复后能降低失败重复率或改善 Root candidate 轨迹。

## 迭代范围

### 1. 增加 Root 停滞检测和可恢复策略

为每个 Root 维护最后一次 Root-relevant progress：新的 Root candidate、Root Workspace revision 被使用、parent review 后的路线改变、或新的 Judge evidence 被 Root 消费。若在配置窗口内只有 heartbeat、list/read、timer wake 或重复等待，则生成 typed `stagnation` 事实，并要求下一次 Root turn 选择以下之一：

- 提交新的 candidate snapshot；
- 创建具有新路线指纹的 bounded child；
- 明确 request rework 并引用失败证据；
- 在证据表明没有独立工作时结束当前分解并回收 Core。

停滞事实不能自动宣称数学失败，也不能把 WAITING 改成语义 WAITING；它是可审计的调度/进展诊断。

### 2. 建立失败路线新颖性与重复失败 gate

对每次 candidate 保存非内容性的 snapshot fingerprint、Workspace revision、父任务、失败诊断类别和路线标签。连续失败只有在至少一个维度变化时才算新的 attempt；如果同一 snapshot 或同一失败类别在限定窗口内重复，系统应向 Agent 返回 recoverable feedback，并要求 route change 或 bounded stop。

验收重点是减少 `repeated_failed_snapshot_count`，并缩短 `failure_to_route_change_ms`；不能只追求更多 candidate。

### 3. 完成 ready-unassigned 分类

在 ready sample 产生时持久化：ready task ids、idle Core ids、active turn ids、claim attempts、wake condition、sample reason 和下一次状态变化。保证每个 `ready_unassigned_ms` 区间都能归入既定 reason，或明确标记为可解释的 `insufficient_decomposition`。分析器必须报告分类覆盖率，不能把总时长默认为 `unclassified`。

### 4. 将协作进展与容量指标分离

保留 Agent utilization、WAITING、Judge、scheduler 和 coordination time 的独立计量。新增长时程 progress curve，至少按 15 分钟、1 小时、4 小时和 8 小时记录：Root PASS、Root completion、new Judge evidence、converted handoffs、route changes、repeated failures、Root last-progress timestamp 和 active responsibility count。

任何“稳定性改善”必须同时报告：

- lifecycle validity；
- Root verified progress；
- failure/recovery trajectory；
- waiting and dispatch cost；
- total Agent/Judge/coordination cost。

单独提高 heartbeat 数、Core utilization、child 数或 Material 数不算改善。

## 验收标准

1. 在确定性测试中，Root 在指定停滞窗口内没有新的 Root-relevant progress 时产生一条可重算的 `stagnation` 事实，并能触发一次 bounded route decision。
2. 在重复失败 fixture 中，系统识别重复 snapshot/路线，阻止无限重复提交，并记录 route-change 或 bounded-stop 证据；现有正常 FAIL→修订→PASS 路径不能回归。
3. 在调度测试中，所有 ready-unassigned 区间都能得到原因分类；`classification_coverage` 达到 1，且 claim conflict、wake/resume 和 discovery latency 各有独立计量。
4. `analyze-putnambench-run.mjs` 对单个实验只分析该实验的 project facts，不混入其他 run；报告 15m/1h/4h/8h checkpoint 或明确缺失原因。
5. 在短时程回归中，现有 100 个测试继续通过，并覆盖 WAITING、wake/resume、parent review、rework、重复失败和 cleanup。
6. 下一次长时程实验的成功判据预先固定为：三项核心指标中至少两项改善且 `valid_run_rate` 不下降：
   - `repeated_failed_snapshot_count` 和 failure-to-route-change latency；
   - Root verified progress / Agent-hour；
   - opportunity-conditioned ready-to-assigned latency 与分类覆盖率。
   Root PASS 仍是最终结果指标，不能被中间指标替代。

## 不在本 Issue 内解决

- 不通过增加总 token、延长 timebox 或增加 Core 数来掩盖协作策略问题。
- 不把三题没有 PASS 解释为单纯模型数学能力不足；当前轨迹同时显示等待、错误恢复和调度证据缺口。
- 不用单一 swarm score 合并正确性、进展、成本和可靠性。
- 不继续启动新的 8 小时实验，直到本 Issue 的停滞、重复失败和 ready-work 分类验收标准完成。

## 证据位置

- `reports/issue-33-long-8h-20261022-b/putnam_2025_b1/report.json`
- `reports/issue-33-long-8h-20261022-b/putnam_2025_b4/report.json`
- `reports/issue-33-long-8h-20261022-b/putnam_2024_b4/report.json`
- `experiments/issue-33-long-8h-20261022-b/run/state/projects/*/project.sqlite`
- `docs/benchmark-analysis-sop.md`
- `docs/issue-33-analysis-framework.md`
