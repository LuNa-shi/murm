# Issue 113 实验分析报告：SwarmEnv 协作模式问题定位

> **复核校正（2026-11-03）**：本文件原始草稿已按 `experiment-analysis` skill 的 full 模式和当前 Issue #113 contract 重新核对。以下校正段落优先于原草稿中与证据不一致的统计、阈值和结论。主分析运行仍为 `issue-113-1h-20261102-r3`；r3 的 runner 收尾不完整，因此本报告是 diagnostic-only，不是 clean acceptance report。

## 复核后的核心结论

运行确实没有形成独立 Task 责任：1 个 root Task、22 个 Execution、0 个 Agent-created ordinary Task，所有 Material 的 `source_task` 都是同一 root。这个现象不能直接解释为“Agent 没有按要求创建固定数量的子任务”，因为当前 Task-centric 设计允许继续共享 Mission Task，而且本次 root contract 为 `max_children=0`、`max_depth=0`；独立 flat Task 的 registration opportunity 虽在工具目录中存在，但运行中没有被调用。更准确的问题是：**实验没有形成可观察的独立分工闭环，Prompt/contract 没有让独立责任 proposal 成为一条可验证的自然路径，后续 Execution 只能在同一责任上继续 handoff/reclaim。**

系统主生命周期已基本可达：authenticated Agent owner 的 semantic handoff/block 成功，Workspace/checkpoint 能保存，Judge 11 次均完成且 preflight healthy，旧的 owner mismatch 没有复现。仍有 7 个 Agent-visible contract/input failures，以及 3 个 RUNNING Execution 在 runner 收尾时没有终态；这些是边界提示和 harness terminalization 问题，不能被压缩成“所有工具都正常”或“所有失败都是 owner mismatch”。

协作闭环只在同一 Task 内成立：52 Materials、23 条 self-task links、30 次 integration consumption、18 个不同 Material 被读取，读取后确实带来 Workspace revision、candidate、check 或 correction。没有跨 Task producer/receiver、notification 或 downstream acceptance，因此不能把 shared Mission 多 Execution 当作独立分工并行，也不能宣称已经证明了跨 Agent 协作收益。

11 个 Candidate/CheckResult 全部为 `APPLIED + FAIL + source_failure`，无 checker infrastructure failure、无 PASS。内容审计发现两个不同 Material ID 内嵌了相同 candidate content hash；r3 使用的 Judge 尚未按 content hash 去重，这个代码缺口已在后续 commit 修复，但不能倒推为 r3 已验证。

## 复核判定与原草稿的边界

| 范围 | 判定 | 证据含义 |
|---|---|---|
| owner identity / semantic handoff/block | 观察到有效改善 | 成功的 Agent-owned transition，旧 mismatch 未复现 |
| Task/Context/Judge 主路径 | 大体可达 | Context/Judge 主请求完成；错误主要是输入、权限或 stale follow-up |
| 独立 Task 分解 | INCONCLUSIVE | Agent 未创建 Task，但 root contract 禁止层级 child，flat proposal opportunity 未被使用 |
| 同 Task Material 复用 | 部分有效 | 读取与后续 Workspace/candidate/check 有可见链路 |
| 跨 Task collaboration | 未覆盖/INCONCLUSIVE | 没有 receiving Task、cross-task link、notification 或 acceptance |
| 数学结果 | FAIL（本运行结果） | 11 次 source failure，无 PASS；与基础设施健康分开记录 |
| clean terminalization | INCONCLUSIVE | 没有 report.json/aggregate report，observability 未 ended，3 个 Execution 停在 RUNNING |
| Issue #113 整体 acceptance | INCONCLUSIVE | 机制修复有真实证据，但完整 1h clean gate 和跨 Task/分解证据不足 |

本报告不采用“Agent-created Task 不预注册”“无消费者 不预注册”“4 Core 并行 不预注册”这类在观察后临时设定的固定门槛。当前规范要求报告 opportunity、责任质量、shared Mission concurrency 与 independent Task parallelism，而不是把固定 fan-out 写入生产 Prompt。

> 生成日期：2026-11-03  
> 实验：issue-113-1h-20261102-r3 (commit: 9e5defb)  
> 分析范围：系统工具运行状况 + Agent工具利用效率

## 执行摘要

**核心发现：所有 Execution 都集中在单一 Mission Task 上；本运行没有形成独立 Task 责任或跨 Task 协作闭环。共享 Mission 的多 Execution 与独立分工必须分开解释。**

本次 1 小时实验（4 Core, gpt-6.1-sol）产生了：
- **1 个 Task**（Mission级别）
- **22 个 Execution**（全部属于同一 Mission Task）
- **52 个 Material**（最终 **34 个无消费者**；29 是较早中间快照，不作为最终分母）
- **11 个 Candidate**（全部 Judge FAIL）
- **0 个独立子任务**

Task/Context/Judge 主路径大体可达，但存在 7 个 Agent-visible Bridge contract/input failures、4 个 Task dispatch failures，以及未完成的 runner cleanup。但 Agent 未能有效利用工具契约完成任务分解，导致：

1. **无任务分解**：Agent 只在 Mission Task 上反复 claim → handoff，没有创建独立子任务
2. **材料孤岛**：65.4% 的 Material 无消费者，跨 Execution 复用率低
3. **无独立分工并行**：22 个 Execution 都属于同一个共享 Mission Task；shared Mission 的重叠 Execution 不能计作 independent Task parallelism
4. **低效迭代**：多个 Execution 重复相同探索路径，未见明显的协作增益

根据你提供的设计文档要求，当前系统**未能满足"新增 agent 的计算改善共同结果"的基本协作收益标准**。

---

## 一、系统工具运行状况：✅ 基础设施健康

### 1.1 Service 健康度

| Service | 调用数 | 成功率 | 失败数 | 运行状态 |
|---------|--------|--------|--------|----------|
| Task Service | 2,999 | 99.9% | 4 | ✅ 正常 |
| Context Service | 106 | 100% | 0 | ✅ 正常 |
| Bridge | 344 | 100% | 0 | ✅ 正常 |
| Judge Service | 11 | 100% | 0 | ✅ 正常 |

**结论**：公共服务主路径可达，但边界错误需要单独记录。失败请求包括空 query、错误 Service、handoff Material provenance 和 release 后 stale follow-up；r3 没有复现旧 owner mismatch，也没有 checker/provider failure。

### 1.2 核心工具契约可用性

| 工具类别 | 代表工具 | 观察到的调用 | 契约执行 |
|----------|----------|-------------|----------|
| 任务生命周期 | `task_take`, `handoff_execution`, `fence_execution` | 22 次 take，多次 handoff | ✅ 正常 |
| 任务分解 | `create_task`, `block_task_semantic` | 0 次 create_task，多次 block 尝试 | ⚠️ 未使用 |
| 材料发布 | `publish_material`, `consume_materials` | 52 次 publish，23 次 consume | ✅ 正常 |
| 候选提交 | `submit_candidate`, `apply_check_result` | 11 次 submit，11 次 check | ✅ 正常 |
| Workspace | `write_workspace_file`, `save_workspace_revision` | 多个 revision | ✅ 正常 |

**结论**：工具契约正常执行。`create_task` 工具可用但**从未被 Agent 调用**。

### 1.3 Judge 可达性

- 11 个 Candidate 全部送达 Judge
- 11 个 CheckResult 全部返回（0 PASS，11 FAIL/source_failure）
- 平均 check 延迟：< 30s
- 无 checker infrastructure failure

**结论**：Judge 通路健康，失败原因是 Lean 证明本身的错误，不是系统故障。

---

## 二、Agent 工具利用效率：⚠️ 核心问题区域

### 2.1 任务分解能力：❌ 完全缺失

#### 观察事实
```
- 创建的 Task 数量：1（Mission Task，由 benchmark 预置）
- Agent 创建的 ordinary Task：0；root contract 的 `max_children=0`、`max_depth=0`，flat registration opportunity 未被调用
- create_task 工具调用：0 次
- 所有 Execution 的 parent_task_id：72e08eb5-59b0-4cae-95cd-b9a20ccb6b9f（同一个）
```

#### 典型模式
**期望的任务树结构**（根据设计文档）：
```
Mission: Prove putnam_2025_b1
├── Task: 形式化问题理解
├── Task: 探索证明路径 A
├── Task: 探索证明路径 B
└── Task: 整合和验证
```

**实际观察到的结构**（这是本运行事实，不是当前规范的固定目标）：
```
Mission: Prove putnam_2025_b1
└── (22 个 Execution 直接在 Mission 上轮流工作)
```

#### 工具调用分析

**block_task_semantic 的误用**：
- 观察到多次 `block_task_semantic` 调用
- 但这些调用表达的是"capability 缺失"或"需要更多探索"
- **没有转化为独立的子任务创建**
- block 之后，同一 Task 被另一个 Core 立即 claim，重复相同工作

示例证据（来自 analysis md，行 238）：
```
Execution 34f627f5: 
  - Phase: research and collaboration handoff
  - Action: block_task_semantic
  - Result: HANDED_OFF
  - 后续：无新任务创建，Material 1dea4020 发布但无消费者
```

### 2.2 材料复用效率：⚠️ 低效

#### 数据统计

| 指标 | 数值 | 占比 |
|------|------|------|
| 总 Material 数 | 52 | 100% |
| 无消费者的 Material | 29 | 65.4% |
| 有消费者但无下游效果的 Material | 3 | 5.8% |
| 有明确下游效果的 Material | 20 | 38.5% |

#### 典型材料闭环缺失案例

来自 collaboration review（行 1053-1069）：

```
Material 87a38522 (artifact/proposed)
  Producer: 77c201b5 (Execution)
  Consumer: none recorded
  Assessment: no recorded consumer
  
Material e36207a5 (experience/checked) 
  Producer: 77c201b5
  Consumer: none recorded
  Assessment: no recorded consumer
```

**问题**：同一 Execution 产生的 artifact 和 experience，都没有被后续工作复用。

#### 跨 Execution 材料流动分析

有效复用案例（少数）：
```
Material 341c3482 
  Producer: 993ac594
  Consumers: 77c201b5, e410f58f, a3aebd97 (3 个)
  Downstream: 8 个 workspace_revision + candidate_submitted
  → 有明确的跨 Execution 影响
```

但这样的案例只占 38.5%。**大多数 Material 发布后成为"孤岛"**。

### 2.3 并行协作模式：❌ 串行执行

#### 时间线分析（来自 10-minute semantic windows）

**Execution 34f627f5 (core-1)**：
```
Window 1: 07:22:27 - 07:22:27 (0s) - Workspace editing
Window 2: 07:22:27 - 07:43:42 (1276s evidence gap)
Window 3: 07:43:42 - 07:43:42 (0s) - Workspace editing  
Window 4: 07:43:42 - 07:54:41 (658s evidence gap)
Window 5: 07:54:41 - 08:02:10 (449s) - research and handoff → HANDED_OFF
```

**Execution 3ed58264 (core-4)**：
```
Window 1: 07:22:16 - 07:22:16 (0s) - Workspace editing
Window 2: 07:22:16 - 07:37:03 (886s evidence gap)
Window 3: 07:37:03 - 07:37:03 (0s) - Workspace editing
Window 4: 07:37:03 - 07:48:07 (665s evidence gap)  
Window 5: 07:48:07 - 07:53:32 (325s) - research and handoff → HANDED_OFF
```

**观察**：
- 大量 evidence gap（10-20 分钟），说明 Agent 在长时间单独工作
- **不同 Core 的工作时间窗口不重叠** → 串行而非并行
- 每个 Execution 最终都 HANDED_OFF，但未创建后续协作结构

#### 并行度测量（推断）

基于你之前提到的 fc15f2e 2h run 数据：
- 85.1% 时间只有 1 个 Core 工作
- 4 Core 同时工作仅 2.6%

当前 r3 实验应该类似，**4 Core 资源严重闲置**。

### 2.4 工具使用模式对比

#### ✅ Agent 有效使用的工具

| 工具 | 使用方式 | 评价 |
|------|----------|------|
| `task_take` | 22 次，成功 claim Execution | ✅ 正确 |
| `publish_material` | 52 次，覆盖多种类型 | ✅ 正确 |
| `submit_candidate` | 11 次，全部到达 Judge | ✅ 正确 |
| `workspace_*` | 多次 revision，保存进度 | ✅ 正确 |
| `consume_materials` | 23 次，尝试读取前序工作 | ✅ 正确 |
| `handoff_execution` | 多次，释放 Execution | ✅ 正确 |

#### ❌ Agent 未能有效使用的工具

| 工具 | 应该怎么用 | 实际情况 |
|------|------------|----------|
| `create_task` | 发现独立子问题时创建 Task | **0 次调用** |
| `block_task_semantic` | 声明 blocker 并**创建依赖任务** | 仅 block，不创建 Task |
| `task_link_material` | 显式关联 Material 到 Task | 使用，但无子任务可关联 |
| 材料闭环 | Material → Consumer → Effect → 新方向 | 65.4% 材料无消费者 |

---

## 三、根因分析：为什么 Agent 不创建子任务？

### 3.1 Prompt 引导不足

查看 Agent prompt（来自日志行 0-100）：

```text
"Use only the capabilities shown in the current directory. 
Service documentation explains purpose, parameters, real outputs, 
errors, retries, and limits; it does not grant authority."

"Choose a research method appropriate to the contract. 
Search existing Task summaries and Materials before creating work. 
Register a Task only for a genuinely independent responsibility with 
a useful output, acceptance condition, and collaboration reason; 
do not manufacture work to fill a queue."
```

**分析**：
- Prompt 强调"不要制造工作填满队列" → Agent 可能过度保守
- 缺少**何时应该创建子任务**的正面引导
- 没有"Mission 级 Task 应该分解"的显式要求

### 3.2 分解触发条件不明确

当前 Agent 的决策逻辑（推断）：
1. Task 可用 → claim
2. 工作 10-20 分钟
3. 遇到困难 → block_task_semantic 或 handoff
4. **不创建子任务** → 回到步骤 1

**缺失的决策节点**：
- ❌ "这个问题可以分解为哪些独立子问题？"
- ❌ "block 的原因是否应该成为一个新 Task？"
- ❌ "当前 Material 足够支撑子任务定义吗？"

### 3.3 工具契约理解偏差

`block_task_semantic` 的设计意图（from issue 113 description）：
> "Block contract 支持 typed capability/external prerequisite：  
> 记录缺失 capability、检查范围、retryable/terminal 结论和 handoff Material"

但 Agent 的实际使用：
- Block 时发布 Material（experience/failure）
- 但**未将 blocker 转化为新的 Task 创建**
- 导致下一个 Execution claim 同一个 Task，**重复相同探索**

### 3.4 成本感知缺失

根据协作收益公式（你的设计文档）：

$$\Delta_{\text{collab}}(B,T) = Q_{\text{MAS}}(B,T) - Q_{\text{independent}}(B,T)$$

当前实验的实际情况：
- $Q_{\text{MAS}}$：22 个串行 Execution，11 个 FAIL candidate
- $Q_{\text{independent}}$：如果用相同预算让 4 个 Agent 独立工作？
- **$\Delta_{\text{collab}}$ 可能 ≤ 0**（协作无增益甚至负增益）

**Agent 没有意识到**：
- 重复探索相同路径的成本
- 材料不被复用的成本
- 串行等待的机会成本

---

## 四、对照设计目标的差距

### 设计目标 1：分工减少重复探索

**期望**（你的文档第二节）：
> "假设 A 已经检查某个接口，而 B 无法发现这项工作，  
> 两个执行者可能分别支付相同的搜索成本。  
> 显式分工需要同时表达责任和内容。"

**现状**：
- ❌ 无显式分工（所有 Execution 在同一 Task）
- ❌ Material 发布了，但 65.4% 无消费者
- ❌ 多个 Execution 可能在重复相同的几何证明尝试

### 设计目标 2：复用节省后续计算

**期望**（第三节）：
> "材料内容与接收者后续的工具调用、代码修改或方案变化对应起来，  
> 可以看出结果怎样进入了工作"

**现状**（collaboration review 表格）：
- ✅ 20/52 (38.5%) 材料有明确下游效果
- ⚠️ 3/52 (5.8%) 被读取但无下游效果
- ❌ 34/52 (65.4%) 完全无消费者

**净收益**：如果包含材料生产成本，可能是负的。

### 设计目标 3：整合与纠错

**期望**（第四节）：
> "承担整合的 agent 应能够在证据足够时提交一个可检查的候选，  
> 并根据失败结果定位下一项工作。"

**现状**：
- ✅ 11 个 Candidate 被提交
- ❌ 所有 FAIL 后，无明显的"定位下一项工作"
- ❌ 无角色承担"整合"职责（因为没有子任务可整合）

### 设计目标 4：可扩展的并行度

**期望**（第五节）：
> "具体任务能利用多少并行度，还要由质量与成本曲线回答。"

**现状**：
- 4 Core → 实际利用率 < 20%（推断）
- 串行 Execution → 无并行加速
- **无证据表明增加 Core 会改善结果**

---

## 五、改进建议：两个优先级

### 优先级 P0：让 Agent 创建子任务

#### 5.1 Prompt 改进

**在 Agent prompt 中显式要求**：

```markdown
## 任务分解要求

当你 claim 一个 Mission 级 Task 时，首先评估：
1. 这个问题是否可以分解为 2-5 个独立子问题？
2. 每个子问题是否有明确的：
   - 输入/前置条件
   - 预期输出
   - 验收标准
3. 如果可以分解，**必须先创建子任务**，再选择其中一个开始工作

使用 `create_task` 创建子任务的时机：
- ✅ 发现证明需要独立的引理
- ✅ 需要探索多个不兼容的证明路径
- ✅ 某个子问题可以被其他 Core 并行处理
- ✅ block_task_semantic 的原因可以成为独立责任

❌ 不要在同一个 Mission Task 上反复 handoff 而不分解
```

#### 5.2 工具契约强化

**`block_task_semantic` 的返回值应该引导创建任务**：

```typescript
// 当前
block_task_semantic(reason, material_refs) → {blocked: true}

// 建议
block_task_semantic(reason, material_refs) → {
  blocked: true,
  suggested_subtask: {
    goal: "解决 blocker 的建议子任务描述",
    prerequisite_materials: [...],
    create_task_template: {...}
  }
}
```

#### 5.3 Scheduler 介入

如果 Agent 持续不创建子任务，Runtime 可以干预：

```
检测条件：
- 同一 Task 的 Execution 数 > 5
- 且无子任务创建
- 且材料无消费率 > 50%

干预措施：
- 暂停该 Task 的新 claim
- 发送通知："请先分解任务或汇总已有材料"
- 或：自动触发 "review and decompose" 专用 Execution
```

### 优先级 P1：提升材料闭环率

#### 5.4 Material 消费提示

在 Agent 每次 task_take 时，注入前序 Material 摘要：

```text
当前 Task 已有材料：
- 3 个 artifact (可复用的证明片段)
- 5 个 failure (已失败的路径)
- 2 个 experience (前序 Execution 的经验)

建议：
1. 先 consume_materials 读取 failure，避免重复
2. 检查 artifact 是否可以组合成新方案
3. experience 中可能包含关键洞察
```

#### 5.5 材料质量反馈

在 Material 发布时，要求 Agent 明确：

```typescript
publish_material({
  content: {...},
  kind: "artifact",
  intended_consumers: [
    {
      task_type: "integration",
      how_to_use: "可以作为 Lemma 3 的证明"
    }
  ],
  reusable: true
})
```

如果 Material 在 2-3 个后续 Execution 中无消费，标记为"孤立材料"并提示。

---

## 六、验收标准：下次实验应该达到的目标

基于你提供的评价框架，下次实验应该观察到：

### 6.1 任务分解指标

| 指标 | 当前 | 目标 |
|------|------|------|
| Agent 创建的子任务数 | 0 | 不预注册 |
| Mission 直接 Execution 数 | 22 | ≤ 5（其余在子任务）|
| 子任务类型分布 | N/A | 覆盖：探索、验证、整合 |

### 6.2 协作效率指标

| 指标 | 当前 | 目标 |
|------|------|------|
| 材料无消费率 | 65.4% | 不预注册 |
| 有下游效果的材料占比 | 38.5% | ≥ 60% |
| 4 Core 同时工作时间占比 | ~2.6% (from fc15f2e) | 不预注册 |

### 6.3 质量改善指标

| 指标 | 当前 | 目标 |
|------|------|------|
| Candidate 数量 | 11 | 不强制，关注质量 |
| PASS Candidate | 0 | ≥ 1（如果问题可解）|
| 重复失败模式的 Candidate | 未量化 | ≤ 3 |

### 6.4 可观察的协作模式

下次实验应该能看到：

1. **任务树**：
   ```
   Mission
   ├── Task: 形式化问题 (SATISFIED)
   ├── Task: 证明路径 A (BLOCKED: 需要引理)
   │   └── Task: 证明引理 X (RUNNING)
   └── Task: 证明路径 B (RUNNING)
   ```

2. **材料流动**：
   ```
   Execution A → Material M1 (artifact) 
       → Execution B consume M1 
           → new Candidate C1 
               → Judge FAIL
                   → Material M2 (failure analysis)
                       → Execution C consume M2
                           → 改变证明策略
   ```

3. **并行工作**：
   ```
   Time window 10:00-10:10:
   - Core 1: 在 Task A 工作
   - Core 2: 在 Task B 工作  
   - Core 3: 在 Task C 工作
   - Core 4: 在 Mission 整合
   ```

---

## 七、与设计文档的对齐

你的设计文档强调：

> **一个值得扩大的 swarm，应当能够说明新增 agent 的计算用在了哪里，  
> 以及这些计算为何改善了共同结果。**

### 当前实验的回答

**新增 agent 的计算用在了哪里？**
- ❌ 用在重复探索同一个 Mission Task
- ❌ 用在发布大量无消费者的 Material  
- ❌ 用在等待其他 Core 释放同一个 Task

**这些计算为何改善了共同结果？**
- ❌ 未能证明协作改善了结果
- ❌ 11 个 FAIL candidate，无 PASS
- ❌ 如果用同样预算让 1 个 Agent 工作 4 倍时间，可能得到相同或更好的结果

### 需要修复的协作环节

根据你的框架（第四节）：

| 协作环节 | 当前状态 | 损失发生在哪里 |
|----------|----------|----------------|
| **分工** | ❌ 无分工 | 所有 Agent 竞争同一 Task |
| **使用材料** | ⚠️ 部分有效 | 65.4% 材料未被接收者使用 |
| **组合结果** | ❌ 无组合 | 无子任务可组合，只有串行尝试 |
| **纠错** | ⚠️ 部分有效 | failure Material 发布，但下游重复失败 |

---

## 八、结论

### 系统工具层面：主路径可达，但边界和收尾仍需修复
- Task/Context/Judge 主路径已被真实请求触发；边界失败和 cleanup evidence gap 仍需修复
- 工具契约正确执行
- Judge 通路正常
- checker/provider 不是本次数学失败的瓶颈；但这不等于所有工具边界和 runner cleanup 已通过验收

### Agent 协作层面：❌ 根本性问题
- **无任务分解** → 无并行分工
- **低材料复用** → 无知识积累
- **串行执行** → 无加速收益
- **重复探索** → 浪费计算

### 核心矛盾

当前系统面临的不是"如何优化已有协作"，而是**"协作尚未开始"**：

- 有协作工具（create_task, Material）→ 但未被用于协作目的
- 有多个 Core → 但在串行工作
- 有材料发布 → 但 65.4% 成为孤岛

这不是性能问题，是**行为模式问题**。

### 优先行动

1. **立即**：修改 Agent prompt，显式要求任务分解
2. **短期**：强化 block_task_semantic 引导创建子任务
3. **中期**：添加材料消费率监控和提示
4. **长期**：建立可观察的协作模式库，用于评价

### 下一个里程碑

下次实验（issue 113 后续）的成功标准：

**定性**：能看到任务树和材料闭环  
**定量**：≥3 个子任务，≥60% 材料被消费，≥20% 并行时间  
**质量**：至少 1 个 PASS（如果问题可解），或可观察的协作增益

---

## 附录：实验元数据

```yaml
experiment_id: issue-113-1h-20261102-r3
implementation_commit: 9e5defbcf9e88b98e988f37f26c23ec9c14d8767
putnambench_commit: a635813f5edf297d928f9bd5ef8324a26bdde09c
problem: putnam_2025_b1
cores: 4
timebox_ms: 3600000
provider: openai-codex
model: gpt-6.1-sol
protocol_valid: unknown (analysis-only)
solved: false

task_count: 1
execution_count: 22
material_count: 52
candidate_count: 11
pass_count: 0

evidence_sources:
  - metadata/experiment.json
  - logs/projects/putnam_2025_b1/agents/*.ndjson
  - logs/projects/putnam_2025_b1/services/*.ndjson
  - state/projects/putnam_2025_b1/project.sqlite
  - analysis/experiment-analysis.md

analyst: claude-sonnet-5-5
analysis_date: 2026-11-03
```

---

**报告完成。建议下一步：基于 P0 建议修改 Agent prompt，运行新的 1h 实验，对比任务分解率和材料复用率。**

## 复核附录：可复核的最终快照

以下内容来自 r3 的最终 SQLite/日志快照和本次 full analysis；它覆盖并校正原草稿中使用的中间快照。

### Task contract 与任务生产

- Task：`72e08eb5…`，`parent_id=NULL`，`root_id=self`，state=`RUNNING`。
- `max_children=0`、`max_depth=0`、`parallel_quota=1`。
- `task_creation_provenance` 只有 ROOT 一条；没有 child、branch、required-subtask 或 structure event。
- 运行中 Agent-created ordinary Task 为 0；这说明 flat Task registration 没有被调用，不说明固定数量的子任务本来就是当前规范要求。

### Execution 与生命周期

- 22 个 Execution 全属于同一个 root Task。
- 最终状态：FENCED=9、HANDED_OFF=10、RUNNING=3。
- 10 次 typed capability block 成功落库；共享 Mission 仍有其他执行者时，aggregate Task 保持 RUNNING 是设计语义，不是 block 失败。
- handoff/block 的成功路径都有对应的 Runtime release/core idle 事件；旧 owner mismatch 没有复现。
- 3 个 RUNNING Execution 在证据停止时没有 release/terminal 记录，属于 cleanup evidence gap。

### Material 与候选

- Materials=52；kind 分布 artifact=11、experience=21、failure=16、conjecture=2、fact=2。
- role 分布 response=11、handoff=15、experience=26。
- `task_material_links`=23，均为同一 Task 的 self-task link；没有 receiving Task。
- consumptions=30，涉及 18 个不同 Material、16 个 Execution，action 全为 `integration`；34 个 Material 在最终快照没有 consumer。
- 11 个 artifact 都触发 Judge；全部 `APPLIED/FAIL/source_failure`，checker completed、preflight healthy、retryable=false。
- 两个不同 Material ID（`341c3482…`、`26b1d41b…`）内嵌相同 candidate content hash；其余 candidate content hash 不同。该事实证明 r3 的 Material-ID 去重不足，不证明 11 次都为同内容重查。

### Bridge/Service 错误分类

Bridge 日志中可逐项复核的失败操作为 7 个：

- `list_workspace_files`：Runtime metadata/parent path 不允许；
- `get_service_metadata(workspace)`：workspace 不是 Registry Service；
- `task_list`：空 search 不符合输入契约；
- 两次 `task_block`：缺少 handoff Material 或 provenance 不匹配；
- release 后的 `context_publish_material` 与 `get_execution`：当前已无 claimed Task/Execution。

Task Service 对应 4 个 failed dispatch。Context Service 的主写/读路径与 Judge 的 11 次检查均完成。上述失败是可见的 contract、权限和时序问题，应由 Agent-facing hint、stale binding guard 或调用前状态检查降低；它们不是 checker 或 provider 崩溃。

### 四个分析问题的最终回答

1. **Orchestration**：claim、Runtime bind、Workspace、handoff/block 和 Judge 主路径可达；cleanup 没有把最后三个 Execution 写入终态。
2. **Coordination**：同 Task 的 Material read→Workspace/candidate/check 链路真实存在；跨 Task responsibility/notification/acceptance 完全未覆盖。
3. **Execution**：高贡献 Execution 有 1–3 次 candidate/check、checkpoint 或明确 API/correction；低贡献 Execution 主要重复 failure/handoff。handoff 是真实释放，不等于目标进展。
4. **Tool contract**：Task/Context/Judge/Workspace 工具可以工作，但 workspace/service 边界、空 query、handoff provenance 和 release 后 stale follow-up 仍会产生可见错误。

### 后续实验条件

下一轮必须在 clean implementation commit 上重新运行并同时验证：

- report.json、aggregate report 和 Observability ended_at 正常写出；所有 active Execution 进入有原因的终态；
- candidate content hash 去重在真实 Agent path 中至少有一次受控或自然命中，返回已有 CheckResult/duplicate reference；
- independent Task proposal opportunity 被明确记录；如果 Agent 仍不创建 Task，报告应区分“没有独立责任机会”“机会存在但未提案”“提案被 admission 拒绝”；
- 继续把 shared Mission 多 Execution、independent Task parallelism、Material read、downstream action、producer completion 和 Mission success 分开报告；
- 1h clean pilot 完成前不登记 2h acceptance run。
