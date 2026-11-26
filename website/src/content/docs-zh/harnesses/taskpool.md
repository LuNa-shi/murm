---
title: TaskPool
description: 面向长时项目的共享任务池——只读发现、独占租约领任务、宿主授权写入、Model Access Policy 租约门控与版本化 Workspace main 合并。
section: 内置 HARNESS
order: 8
---

**TaskPool**（`src/harnesses/taskpool/`）专为长周期项目设计，允许单个 Agent 超时、完工或轮换而不丢失团队进度。系统没有常驻管理员：所有同构 `researcher` 从共享 **Task** 池自主发现待办任务、发布不可变 **Material**、向公共 **Workspace** 保存并验证修订版本，通过持久化公共状态接力协作。

## 1. 注册的 Services

| Service | 核心 CLI 操作 | 领域保障 |
| --- | --- | --- |
| **`task`** | `list`、`view`、`create`、`take`、`link`、`finish`、`revise`、`cancel`、`dependency-replace`、`feedback` | 任务依赖 DAG + 独占认领，生成带单调 `fencing_version` 的租约 **Execution** |
| **`material`** | `list`、`view`、`search`、`publish`、`consume`、`dispute`、`supersede`、`unsupersede` | 不可变研究发现与跨 Task / Execution 的生产消费溯源 |
| **`workspace`** | `view`、`history`、`status`、`diff`、`public-diff`、`files`、`read`、`search`、`save`、`apply`、`merge` | 版本化公共 `main` 及未合并的公开保存修订；`merge` 可接入宿主校验器把关 |
| **`judge`** *(可选)* | `check`、`result` | 对固定的公开 Workspace 修订运行可信宿主检查 |
| **`mission`** *(可选)* | `view`、`submit`、`submission view` | 读取共享 Mission 目标，并提交固定 `main` + Material 集合进行最终验收 |

容器内一个典型的 Worker 完整周期如下：

```bash
# 1. UNBOUND 阶段只读发现并领任务
swarm task list --state ready
swarm task view T1
swarm task take T1 --request-id take-t1

# 2. 宿主授权写入后：编码、保存快照、检查、发布 Material 并结束任务
swarm workspace save --request-id save-t1
swarm judge check --revision 0.2 --request-id check-t1
swarm material publish --content '{"revision":"0.2","summary":"Fixed parser edge case"}' --request-id pub-m1
swarm task link --task-id T1 --material-id M1 --role experience --request-id link-m1
swarm task finish --outcome done --workspace-revision 0.2 --material-ids '["M1"]' --request-id finish-t1
```

## 2. 协同工作的三项 Runtime 原语

### 只读发现 → `files.prepare()` + `files.grant()`

每个 `researcher` 启动时都强制 **`writable: false`**。在未认领任务前，它可以通过 Services 浏览 Task、Material 和公共 Workspace 文件，但无法修改 `/workspace/project`。

一旦 `swarm task take` 成功，[task-handoff.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/task-handoff.ts) 会在续约心跳保护下完成四步宿主交接：

```ts
// 1. 按固定的公共 Workspace 修订与引用 Material 组装输入文件集
const inputs = await prepareTaskPoolInputs({
  execution: taken.execution,
  taskService,
  missionWorkspace,
  workspaceId,
  workspaceManager,
  contextService,
});

// 2. 写入空的只读工作目录，返回受信任的冻结句柄 PreparedFiles
const prepared = await runtime.files.prepare(agentId, {
  requestId: `${id}:prepare`,
  files: inputs.files,
});

// 3. 在 TaskService 中正式激活 Execution 并设置执行与交接截止时间
execution = taskService.dispatch(
  'start_execution',
  { core_id: agent.core_id, started_at, execution_deadline, handoff_deadline },
  executionEnvelope(execution, `${id}:start`),
).execution;

// 4. 传入原 PreparedFiles 内存对象，在线解锁该容器的写权限
await runtime.files.grant({ requestId: `${id}:grant`, prepared });
```

### 基于 `modelAccessPolicy` 的租约模型门控

如果某个 Agent 卡死导致租约过期而容器尚未完全销毁，[model-access-policy.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/model-access-policy.ts) 会在宿主 Model Gateway 处立刻拦截过期推理：

```ts
export function authorizeTaskPoolAgent({ taskService, missionId, agentId, deadline, isStopping }): ModelPermit | null {
  const at = Date.now();
  const agent = taskService.getAgent(agentId);
  if (isStopping() || agent?.mission_id !== missionId || at >= Math.min(deadline(), Date.parse(agent.hard_deadline))) {
    return null;
  }
  if (agent.state === 'UNBOUND') {
    const selectionDeadline = Date.parse(agent.selection_deadline);
    return !agent.execution_id && at < selectionDeadline
      ? { phase: 'selection', deadlineAt: Math.min(deadline(), Date.parse(agent.hard_deadline), selectionDeadline) }
      : null;
  }
  const execution = taskService.getExecution(agent.execution_id);
  const leaseDeadline = Date.parse(execution?.lease_expires_at);
  if (agent.state !== 'ACTIVE' || execution?.state !== 'RUNNING' || at >= leaseDeadline) return null;

  const phase = isSoftCloseout(execution, at) ? 'closeout' : 'work';
  return {
    phase,
    deadlineAt: Math.min(deadline(), Date.parse(agent.hard_deadline), Date.parse(execution.execution_deadline)),
    lease: { key: agent.execution_id, version: execution.fencing_version, expiresAt: leaseDeadline },
  };
}
```

只要租约到期或 `fencing_version` 变化，Model Gateway 会立即中止正在进行的流式模型响应并拒绝新请求。配合 `modelGateway.selectionReasoningEffort: 'low'`，还可以在 `selection` 选任务阶段降低推理开销、而在正式 `work` 阶段保持完整推理力度。

### 双轨事件 + 心跳协调循环

[controller.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/controller.ts) 将“单轮结束（`settled`）”与“任务完成（`swarm task finish`）”解耦：
- **事件轨道（`runtime.onEvent`）**：如果 Agent 回到空闲但 Execution 仍为 `RUNNING`，自动追加 `followUp` 续跑；仍为 `UNBOUND` 则发送发现提示；已进入 `CLOSING` 则调用 `runtime.stop()`、收尾领域状态，并在空出的槽位启动新 Worker。
- **心跳轨道（`setInterval`）**：定期续租、识别卡死或超时 Agent、清理并补满并发槽位 `capacity`，直到所有任务进入终态（或在 `completionPolicy: 'mission'` 下达成 Mission 验收）。

## 3. 通过前台 CLI 运行

TaskPool 可直接由仓库的前台宿主 CLI（`scripts/run-harness.ts`）驱动，通过 `stdin` 发送 JSON 行命令（`status`、`input`、`stop`），结束后输出包含 `runtimeId` 和 `reportPath` 的摘要：

```bash
node dist/scripts/run-harness.js --config ./my-taskpool-config.mjs

# 运行结束后离线检查保存的报告：
node dist/scripts/read-harness-result.js \
  --run-directory "./runs/$runtime_id" \
  --runtime-id "$runtime_id"
```

## 源码索引

- Harness 装配与收尾：[src/harnesses/taskpool/harness.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/harness.ts)
- 协调控制器：[src/harnesses/taskpool/controller.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/controller.ts)
- 文件交接（`prepare` / `grant`）：[src/harnesses/taskpool/task-handoff.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/task-handoff.ts)
- 租约门控（`ModelAccessPolicy`）：[src/harnesses/taskpool/model-access-policy.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/model-access-policy.ts)
- 产物发布与工作区采集：[src/harnesses/taskpool/publication-services.ts](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/taskpool/publication-services.ts)
