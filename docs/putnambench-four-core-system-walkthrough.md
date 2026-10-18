# PutnamBench 四个 Core Slot 的运行模型

本文说明一个困难 PutnamBench 题目在 SwarmEnv 中的目标运行模型，以及一
次实验应如何留下可审计的证据。一个题目是一个 project；一个 project 只
有一个 root Task。四个 core 是可以领取任务的 worker slot，不是四个
预先固定的 root Task 或固定 execution。

实现边界和决策见 [ADR 0009](adr/0009-root-task-queue-and-reusable-core-slots.md)。
Task、Execution、Workspace、Material 的术语见 [GLOSSARY.md](../GLOSSARY.md)。

## 1. Project 初始化

runner 首先锁定三个输入：SwarmEnv repository commit、PutnamBench
checkout commit、checker/environment manifest。题目文件只允许来自锁定的
formalization 路径，并且必须保留未证明的 `sorry` 占位。solution、candidate
或其它答案文件不会进入输入。

每个 project 建立独立的 SQLite 和持久化目录：

```text
experiments/<experiment-id>/
  state/projects/<problem-id>/project.sqlite
  workspaces/projects/<problem-id>/
  logs/projects/<problem-id>/
    services/task-service.ndjson
    services/context-service.ndjson
    services/service-router.ndjson
    services/judge-service.ndjson
    runtime/core-*.ndjson
    bridge/core-*.ndjson
    agents/core-*.ndjson
    judge/lean-checker.ndjson

reports/<experiment-id>/
  aggregate-report.json
  <problem-id>/report.json
```

`experiments/` 保存原始运行证据，包含 service 调用、agent RPC、Runtime
生命周期、workspace、SQLite 和 checker 输出。它们用于恢复和审计，保留在
磁盘上但不提交 Git。`reports/` 是独立的分享面，只保留 hash、状态、计数、
诊断分类和 cheating 审计结果，不导出 candidate source、proof text、raw
transcript、stdout 或 stderr。

## 2. 一个 root Task 和它的 Workspace

题目初始化时创建一个 root Task。Task 自己包含：

- goal 和 completion contract；
- initial prompt；
- 题目的 formal source、source hash 和锁定环境信息组成的 Workspace；
- `max_children` 等 child Task 安全边界。

题目 formalization 因而属于 Task-owned Workspace。它不会先作为
`problem_statement` Material 发布到 Context Service，也不会靠 agent 从
Context Service 找初始题目。Context Service 在运行中只承载动态的
experience、conjecture、artifact 和 judge feedback。

root Task 的初始状态是 `OPEN`。它不因为有四个 slot 就复制成四个 root，
也不为每个 slot 永久分配一个 execution。

## 3. Slot 如何 claim Task 并创建 Execution

每个 worker slot 都执行同一个循环：

```text
while project deadline not reached:
    claim_next(root_id)
    if no OPEN task: wait briefly and retry
    claim atomically creates one Execution
    Runtime materializes the Task Workspace
    Agent Core works through swarmenv_call
    heartbeat, publish Materials, create children, submit candidate, or wait
    release slot on terminal state, wait, failure, or lease expiry
```

`claim_next` 在 Task Service 的事务里选择队列中最早的可领取 Task，检查
Task version、active Execution 和 lease，然后一次性写入 Execution。带有
`root_id` 的 worker claim 默认跳过 root controller，只领取该 root 下的
child Task；不带 root 过滤的通用队列仍可显式领取 root。这个操作返回的不是
“第几个 core 的固定 execution”，而是本次 slot 当前领取到的 Task/Execution
对。

Execution 至少绑定这些字段：

```text
task_id, owner_ref, attempt_no, fencing_version
lease_expires_at, heartbeat_at
initial_prompt, initial_context_ref, input_snapshot_hash
workspace_ref, checkpoint_ref, candidate_material_id
```

进入 Execution 后，Runtime 才会创建或恢复该 Execution 的私有 workspace，
启动 Pi/NuRouter session，并把 loopback ServicesBridge 注入 Agent 环境。四
个 slot 共享 Task queue 和 Context Service 的 Material，但每个 Execution
拥有独立的 workspace、session 和 fencing version。

当前 PutnamBench runner 在启动一个 project 时先由 root controller 建立一批
初始 direct child，再由 scheduler 用 `claim_next(root_id)` 将它们交给四个
slot；每个 claim 都产生新的 Execution ID。运行中由 parent Execution 创建的
后续 child 会回到同一个 queue，之后由空闲 slot 领取。`ServicesBridge` 和
Task Service 已经支持这种动态 child 路径；完整的 12 题实验应继续验证
一个 slot 在前一 Execution 释放后再次 claim 新 child。

## 4. Parent Execution 如何提出 subtask

当一个 parent Execution 发现工作需要拆分，它通过公开的
`swarmenv_call({ operation: "create_child_task", ... })` 提出 direct child。
Task Service 要求：

1. 当前 Execution 必须确实属于 parent Task，并且 owner/fencing/version
   都匹配；
2. child creation key 必须幂等；
3. child 的 task type、completion contract、Workspace 输入和 owner 必须
   通过校验；
4. parent 的 `max_children` 和 `max_depth` 只能作为安全边界，不能把 proof
   decomposition 默认关掉。

新 child 的状态是 `OPEN`，随后进入同一个 root 的 queue。空闲 slot 会
`claim_next` 它；因此一个 parent 可以在运行中产生更多 child，child 也可
以继续产生自己的 subtask。root 的完成条件由 completion contract 和 child
结果共同决定。

## 5. Workspace、Context Service 和 private files

Task Workspace 是输入的权威来源。Runtime 的 Workspace Manager 会为一个
Execution 物化：

```text
initial-context.json
initial-prompt.txt
input-snapshot.json
runtime-manifest.json
.swarm/pi-session/
```

Agent 不直接访问 SQLite 或 Workspace Manager；它只能通过
Services SDK 读取 Task/Execution、读取或发布 Material、创建 child、提交
candidate、发送 heartbeat 和请求 durable wait。

Material 是 append-only 的共享记录。它可以传播研究经验、候选 artifact、
失败反馈和 checker 观察，但新 Material 不会偷偷改变已经属于 Task 的初始
Workspace。需要重做时，Task/Execution 生命周期会保存 steer、checkpoint
和 workspace revision。

## 6. Timeout、wait、释放和恢复

Execution 的 lease 有明确截止时间。Agent 通过 heartbeat 延长 lease；如果
它需要等待外部条件，先保存 checkpoint 和 workspace revision，再请求
`request_wait`。Runtime 停掉 session、释放 slot，Task 仍保留责任和恢复
线索。

如果 heartbeat 超时，Runtime 的 sweep 会 fence 旧 Execution、保存审计结果、
释放 slot，并依据 retry policy 让 Task 再次进入可领取状态或进入明确的
失败状态。旧 owner 之后的写入会因为 fencing version 不匹配而失败。

## 7. 成功题和失败题的完整例子

成功题的状态链是：root `OPEN` → 一个 slot claim root → parent Execution
创建若干 proof child → 其它 slot claim child → child 发布 artifact → Judge
在锁定 Lean environment 中返回 `PASS` → Task Service 应用 CheckResult → child
变成 `SATISFIED` → parent 接收满足的 child 结果 → root 变成 `SATISFIED`。
报告只记录 candidate hash、PASS 数量、check id 和 task/execution 状态；
candidate 内容只留在实验目录的私有 evidence 中。

失败题的状态链可以是：root 或 child 被 claim → Agent 发表路线和 artifact
→ Judge 返回 `FAIL` 或 checker timeout → failure feedback Material 持久化
→ parent request rework 或该 Execution wait/expire → slot 释放并由下一次
Execution 接管；如果达到 retry policy 上限，Task 进入 `FAILED`，root 也因
completion contract 无法满足而失败。若输入出现 `sorry`、`admit`、`axiom`，
或 agent 发生非 `swarmenv_call` 工具事件，cheating audit 会把 project 标为
invalid，即使 checker 偶然返回 PASS 也不能算成功。

## 8. 如何检查一次实验是否真实跑通

先看 `experiments/<id>/metadata/experiment.json`，确认 repository commit、
PutnamBench commit、provider/model 和 protocol。再按 project 检查：

- `state/projects/<problem-id>/project.sqlite` 中 root/child Task、Execution、
  lease、fencing、checkpoint 是否连贯；
- `logs/services/` 是否有 Task、Context、Router、Judge 的调用和结果；
- `logs/agents/` 是否有每个 slot 的 RPC/stdout/stderr；
- `logs/runtime/`、`logs/bridge/`、`logs/judge/` 是否能对应到同一 Task 和
  Execution；
- `reports/<id>/<problem-id>/report.json` 是否没有答案字段；
- audit 是否通过输入边界、tool boundary、candidate provenance、placeholder
  和其它 cheating 检查。

只有当原始 evidence 和脱敏 report 都存在，并且 root Task 的最终状态与
Judge/child 证据一致时，才把题目标为成功。
