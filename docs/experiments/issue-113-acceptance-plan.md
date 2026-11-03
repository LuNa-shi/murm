# Issue 113 验收计划

> **r5 复核校正（2026-11-03）**：r5 运行提前因 Pi `agent_settled` timeout 结束，full analysis 已写入实验目录，判定为 INCONCLUSIVE。当前 Task contract 为 `max_children=0/max_depth=0`，因此不能用“child Task 数为 0”直接判定 prompt FAIL；后续验证必须针对 flat ordinary Task proposal。

> 日期：2026-11-03  
> 状态：Ready for final validation (r5)

## 目标

验证 Issue 113 的 P0 和 P1 修复，并确认 Agent 任务分解能力。

---

## 已完成的验证

### ✅ r4: P0/P1 基础设施修复验证

**实现 commit**: `a95563851aa3dae0685b493e78bf2d53378ea9b2`

**验收结果**：**PASS**

#### P0：Owner Identity 边界
- ✅ 32 次成功的 `block_task_semantic`（r3 是 0 次）
- ✅ 零 owner identity mismatch 错误
- ✅ 所有 handoff/block 工具正常工作

#### P1：能力阻塞和材料闭环
- ✅ **P1a - Typed Capability Blocks**：所有 32 次 block 返回结构化依赖
- ⚠️ **P1b - 跨 Task Material 通知**：跨 Execution 流动已确认，但单 Task 实验无法验证真正的跨 Task 通知
- ✅ **P1c - 重复 Candidate 防护**：37 Execution 只产生 3 个唯一 candidate

#### 系统健康
- 无崩溃、死锁或损坏
- 所有生命周期转换正常
- Judge 基础设施健康

**报告**: `experiments/issue-113-1h-20261103-r4/analysis/experiment-analysis.md`

---

### ⚠️ r4 发现的剩余问题

尽管 P0/P1 基础设施通过验收，但协作模式仍有问题：

**观察到的行为**：
- 37 个 Execution 全部在同一个 Mission Task 上
- **0 个 Agent 创建的子任务**
- 32 次成功的 `block_task_semantic`，但未转化为子任务创建

**根因分析**：
- 现有 prompt 有分解引导，但触发条件不够明确
- Block 结果返回了 typed capability，但 Agent 未将其转化为子任务
- 缺少"首次 claim Mission 时评估分解"的显式提示

**影响**：
- 无并行分工（串行执行）
- 低材料复用率
- 无协作增益

---

## 当前验证：r5 任务分解增强

### 修复内容

**实现 commit**: `3614598f012cd28caeb8af6192be124c7bcd1574`

**修改文件**: `src/agent/agent-prompt.js` (第 20 行)

**新增引导（r5 原始版本）**：
```
When you claim a shared Mission Task for the first time and identify
multiple independent proof approaches or separable subproblems, make an
explicit decision and register bounded ordinary Mission Tasks through
task_register/task_create when the routes are genuinely independent. The
flat Task model does not assume a parent/child tree.

When block_task_semantic reports a missing capability or prerequisite
that represents separable work, consider registering an independent Task
rather than repeated claims of the same blocked responsibility.
```

**设计原理**：
1. **首次 Mission claim 触发器**：明确要求评估是否需要分解
2. **Block 转化触发器**：将 block 结果与子任务创建决策关联
3. **最小化改动**：只增加两句，不改变其他 prompt 逻辑

### r5 实验设计

**目标**: 验证增强 prompt 能触发 flat Mission 中的普通独立 Task proposal

**配置**:
```
Implementation: 3614598 (prompt enhancement on top of a955638)
Problem: putnam_2025_b1
Cores: 4
Timebox: 3600000ms (1h)
Model: gpt-6.1-sol (openai-codex)
Task model: flat
Parallel mode: semantic
```

**对照**: r4 实验（相同配置，旧 prompt）

**主要判据**：
- **定性**：观察到 Agent 创建的普通独立 Mission Task（Agent provenance、责任键和契约明确）
- **定量**：Agent-created ordinary Task 数 > 0（r4 是 0）

**次要观察**：
- 新 Task 的质量（是否有明确的 goal, expected_output, acceptance_condition）
- 是否有不同 Core 在不同 Task 上并行工作
- 材料在不同 Task 间的流动

### 验收标准

#### 最低要求（PASS 门槛）
- [x] P0/P1 基础设施继续工作（无回归）
- [ ] Agent 创建的 ordinary Mission Task 数 ≥ 1
- [ ] 新 Task 有明确的契约（goal, expected_output, completion_contract）

#### 理想目标（超出 PASS）
- [ ] Agent 创建的 ordinary Mission Task 数 ≥ 3
- [ ] 观察到跨 Task 的材料流动
- [ ] 观察到不同 Core 在不同 Task 上并行工作（时间重叠 > 0）

#### 失败条件（FAIL）
- [ ] P0/P1 功能回归（handoff/block 失败，owner mismatch）
- [ ] ordinary Task proposal 数仍为 0（仅当存在明确独立责任机会且 flat registration 可用时判 FAIL）
- [ ] 系统崩溃或死锁

#### 不确定（INCONCLUSIVE）
- [ ] 新 Task 创建了但质量差（重复、无用、空契约）
- [ ] 创建了新 Task 但无 Core 认领（任务孤立）

### 运行命令

```bash
cd /home/ubuntu/SwarmEnv/.worktrees/issue-113-lifecycle-blocker
/tmp/run-issue-113-r5-task-decomposition.sh
```

运行完成后：
```bash
# Run experiment-analysis skill
/experiment-analysis experiments/issue-113-1h-20261103-r5-decomposition
```

---

## 如果 r5 PASS

### Issue 113 可以关闭

**证据链**：
1. ✅ **r4**: P0/P1 基础设施修复验证通过
2. ✅ **r5**: Agent 任务分解能力验证通过
3. ✅ **综合**: 生命周期工具 + 协作模式 均可工作

**合并内容**：
- P0/P1 修复 (commit a955638)
- Prompt 增强 (commit 3614598)

**文档更新**：
- 更新 `docs/implementation-status.md`
- 更新 `AGENTS.md` 如果需要
- 发布 r4/r5 分析报告到 `docs/experiments/`

### 后续工作（新 Issue）

即使 r5 通过，以下仍需改进（但不阻塞 Issue 113）：

1. **真正的跨 Task Material 通知验证**
   - 需要多 Task 实验
   - 验证 Experience 通知到达和处理

2. **材料复用率优化**
   - r4: 55.8% 材料无消费者
   - 目标: ≤ 30% 无消费

3. **并行度优化**
   - r4: 推测 < 20% 并行时间
   - 目标: ≥ 20% 4-Core 同时工作

4. **Scheduler 智能介入**
   - 检测过度 claim 单 Task
   - 建议或强制分解

---

## 如果 r5 FAIL 或 INCONCLUSIVE

### 诊断路径

#### 场景 A：仍然 0 个子任务
**可能原因**：
- Prompt 改进不够强
- Model 理解问题（需要更明确的示例）
- 任务分解判断逻辑需要外部触发

**下一步**：
- 分析 r5 日志，查看 Agent 是否读取了新 prompt
- 检查是否有"考虑分解"的推理，但未执行 create_task
- 考虑更激进的 prompt 或在工具返回值中注入建议

#### 场景 B：创建了子任务但质量差
**可能原因**：
- 子任务定义不清晰（目标重叠、契约缺失）
- 分解粒度不合理（太细或太粗）

**下一步**：
- 分析子任务的 goal, expected_output, completion_contract
- 评估是否需要更详细的"好子任务"示例

#### 场景 C：P0/P1 回归
**可能原因**：
- Prompt 改动干扰了现有逻辑
- 未预见的副作用

**下一步**：
- 回滚 prompt 改动
- 分离 P0/P1 验收和任务分解改进

---

## 时间线

| 日期 | 里程碑 | 状态 |
|------|--------|------|
| 2026-11-02 | r2: 首次 P0/P1 pilot | ✅ 完成 |
| 2026-11-03 08:39 | r4: P0/P1 验收实验 | ✅ PASS |
| 2026-11-03 分析 | 发现任务分解问题 | ✅ 完成 |
| 2026-11-03 改进 | Prompt 增强 (3614598) | ✅ 完成 |
| 2026-11-03 待运行 | r5: 任务分解验证 | 🔄 Ready to run |
| 待定 | Issue 113 关闭或迭代 | ⏳ 取决于 r5 |

---

## 相关文档

- Issue 描述: `gh issue view 113`
- r4 分析报告: `experiments/issue-113-1h-20261103-r4/analysis/experiment-analysis.md`
- 问题定位报告: `docs/research/issue-113-experiment-analysis-report.md`
- 第一阶段验收: `docs/validation/phase-1-acceptance.md`
- Agent 契约: `docs/20261102-agent-task-runtime-contract.md`

---

## 执行清单

### 运行 r5 之前
- [x] P0/P1 修复已在 r4 验证通过
- [x] Prompt 改进已提交 (3614598)
- [x] 工作目录 clean
- [x] .env 准备好
- [ ] Observability 服务运行中（如需要）

### 运行 r5
- [ ] 执行 `/tmp/run-issue-113-r5-task-decomposition.sh`
- [ ] 等待 1 小时（或提前完成）
- [ ] 无崩溃或错误

### r5 完成后
- [ ] 运行 `/experiment-analysis` 生成报告
- [ ] 检查关键指标：
  - [ ] Agent 创建的子任务数
  - [ ] 子任务质量
  - [ ] P0/P1 无回归
- [ ] 根据结果决定 PASS/FAIL/INCONCLUSIVE
- [ ] 更新本文档的结论

### 如果 PASS
- [ ] 准备 PR 描述
- [ ] 更新 `docs/implementation-status.md`
- [ ] 发布实验报告
- [ ] 请求 code review
- [ ] 关闭 Issue 113

### 如果需要迭代
- [ ] 记录具体失败模式
- [ ] 提出下一轮改进方案
- [ ] 更新验收计划
- [ ] 重新运行实验

---

**准备就绪，可以运行 r5 实验。**
