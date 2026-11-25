---
title: Flat · 公共任务池与项目版本
description: 拆解 Flat Program 如何组合排他认领、只读到可写的文件交接、Model Access Policy 租约护栏与自动补位控制器，持续推进长周期项目。
section: 内置协作 Program
order: 7
---

**Flat** 面向长周期、执行者可能随时超时或更替的项目。系统不设常驻总管，所有参与者以相同身份启动，通过**公共任务池（Task）**、**不可变材料库（Material）**和**有版本的公共项目（Workspace `main`）**接力推进目标。完整实现位于 [src/environments/flat](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/src/environments/flat)。

## 1. 这个 Program 注册了哪些 Service？

Flat 把项目状态拆成四个职责分明的 Service 注册给 `researcher` 角色：

| Service | 核心操作 | 负责的业务规则 |
| --- | --- | --- |
| **`task`** | `task_list`、`task_view`、`task_take`、`task_link_material`、`task_finish`、`task_revise`、`task_cancel` | 维护任务依赖图与排他归属；`take` 创建带租约与 `fencing_version` 的 Execution |
| **`material`** | `read_materials`、`context_get_material`、`context_publish_material`、`consume_materials`、`material_dispute`、`material_supersede` | 沉淀不可变的推理结论、尝试路线与失败经验，记录跨任务引用关系 |
| **`workspace`** | `workspace_public_view/files/read/diff`、`workspace_save`、`workspace_merge` | 管理公共项目主干 `main` 与私有提交版本；保存需抓取稳定快照，合入需过合并检查 |
| **`judge`**（可选） | `workspace_check`、`get_check_result` | 对已保存的公共版本执行受信任的构建或形式化检验 |

## 2. 它组合了 Runtime 的哪些核心原语？

Flat 是最充分运用 Runtime 安全边界与受控文件原语的 Program，核心靠三招锁死“执行者归属”：

### 第一招：先只读选工，认领后由宿主 `prepare + grant` 开写

Flat 控制器启动每只 `researcher` 时故意传入 **`writable: false`**——在没认领到任务前，Agent 只能浏览公共状态，无法写工作目录。一旦 `swarm task take T1` 成功锁定任务，[task-handoff.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/task-handoff.ts) 立即在宿主侧完成四步交接：

```ts
// 1. 按任务合同读取选定的公共 Workspace 版本与引用材料
const inputs = await prepareFlatInputs({ execution, missionWorkspace, contextService });

// 2. 将初始文件铺进尚为空的只读工作目录，拿到 Core 签发的受信对象
const prepared = await runtime.files.prepare(agentId, {
  requestId: `${handoffId}:prepare`,
  files: inputs.files,
});

// 3. 在 TaskService 中激活 Execution（设定执行截止时间与交接提醒边界）
taskService.dispatch('start_execution', { execution_deadline, handoff_deadline }, envelope);

// 4. 将原样 PreparedFiles 交给 Core，解锁工作目录写权限；Agent 在原会话中继续干活
await runtime.files.grant({ requestId: `${handoffId}:grant`, prepared });
```

### 第二招：用 `modelAccessPolicy` 在模型网关层截断过期租约

很多开发者初次看到 **`modelAccessPolicy`** 会觉得抽象。用 Flat 里的一个真实故障就能一秒讲明白：

> 假设 Agent A 认领了 Task 1，租约有效期 5 分钟。第 5 分钟时 Agent A 卡死失联，控制器回收了 Task 1 并重新分给 Agent B。但在彻底销毁 Agent A 容器前的几秒钟里，Agent A 仍可能发出下一次大模型请求——如果没有网关级拦截，它既白烧 Token，还可能继续基于过期上下文做无用功。

`modelAccessPolicy` 就是挂在宿主 **Model Gateway** 入口前的一道同步闸门（[model-access-policy.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/model-access-policy.ts)）。每次 Agent 向 Gateway 发起模型调用，Gateway 都会同步询问 Flat：

```ts
const modelAccessPolicy: ModelAccessPolicy = {
  authorize(caller) {
    const bot = taskService.getBot(caller.botId);
    if (!bot || isStopping()) return null; // 拒绝请求

    if (bot.state === 'UNBOUND') {
      // 选工阶段：限制在 selection_deadline 前完成选工
      return { phase: 'selection', deadlineAt: Date.parse(bot.selection_deadline) };
    }
    const exec = taskService.getExecution(bot.execution_id);
    if (bot.state !== 'ACTIVE' || exec?.state !== 'RUNNING') return null;

    // 执行阶段：把任务租约 key/version/expiresAt 交给 Gateway 持续复核
    return {
      phase: 'work',
      deadlineAt: Math.min(missionDeadline, Date.parse(exec.execution_deadline)),
      lease: {
        key: exec.execution_id,
        version: exec.fencing_version,
        expiresAt: Date.parse(exec.lease_expires_at),
      },
    };
  },
  // 与 TaskService 状态写入共用同步临界区，消除租约切换瞬间竞态
  withCommit: (commit) => taskService.withServiceLifecycleWrite(commit),
};
```

只要租约过期、版本号变化或任务中止，Model Gateway 立刻中止在途流式响应并拒绝后续推理。

### 第三招：自动续轮与失败换人

Flat 把“一轮模型结束（`settled`）”和“业务任务完成（`task finish`）”彻底分开——模型输出一段话停下时，只要任务还没 `finish`，控制器就自动续发提醒继续推进；一旦超时或停滞，直接 `runtime.stop()` 清理旧 Agent 并向空闲 Slot 补位新 Agent。

## 3. 宿主控制循环是如何编写的？

[controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/controller.ts) 是一个典型的**状态对账控制器（Reconciliation Loop）**，由“事件响应 + 周期心跳”两条线共同驱动：

```ts
// 线 1：事件驱动 —— 根据业务状态决定续轮还是收尾
runtime.onEvent((event) => {
  if (event.type !== 'settled') return;
  const { owner, execution } = readDomainState(event.botId);

  if (owner?.state === 'CLOSING' || execution?.state === 'CLOSING') {
    // Agent 已调用 task finish，停机并核对 Workspace 后释放 Slot 补位
    void stopAndRefill(event.botId, 'task-finish');
  } else if (owner?.state === 'ACTIVE' && execution?.state === 'RUNNING') {
    // 任务仍在运行，在原会话中自动发一条续轮输入
    void runtime.send(event.botId, buildContinuationMessage(execution), {
      requestId: `continue:${event.botId}:${event.seq}`,
      mode: 'followUp',
    });
  } else if (owner?.state === 'UNBOUND') {
    // 仍未认领任务，在选工预算内继续提醒选工
    void runtime.send(event.botId, FLAT_DISCOVERY_MESSAGE, {
      requestId: `discovery:${event.botId}:${event.seq}`,
      mode: 'followUp',
    });
  }
});

// 线 2：周期对账 —— 心跳续约、解锁已完成依赖、停滞清理、发交接提醒、补位空闲 Slot
setInterval(() => void reconcileAndRefill(), heartbeatMs);
```

## 源码位置

- 宿主总入口：[src/environments/flat/environment.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/environment.ts)
- 状态对账控制器：[src/environments/flat/controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/controller.ts)
- 认领与文件交接：[src/environments/flat/task-handoff.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/task-handoff.ts)
- 模型租约策略：[src/environments/flat/model-access-policy.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/model-access-policy.ts)
