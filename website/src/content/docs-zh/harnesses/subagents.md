---
title: Subagents
description: 基于单一自定义 collaboration Service 实现的递归命名委派、会话上下文分叉、非唤醒邮箱消息与无损中断。
section: 内置 HARNESS
order: 7
---

**Subagents** 建模了一套层级协作团队：由主 Agent（`/root`）拆解目标、递归派生命名子 Agent（最多 `maxDepth` 层）、通过消息实时协同并最终整合交付。源码：[examples/subagents](https://github.com/LuNa-shi/murm/tree/main/examples/subagents)。

## 1. 注册的 Service（`collaboration`）

Subagents 没有把底层 `agent` 原语直接暴露给模型，而是注册了一个领域专属的 **`collaboration` Service**（[collaboration-service.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/collaboration-service.ts)），为每位成员分配层级路径（如 `/root`、`/root/reviewer`、`/root/reviewer/parser`）：

| 操作 | 核心参数 | 宿主行为 |
| --- | --- | --- |
| `spawn_agent` | `task_name`、`message`、`fork_turns?: 'all' \| 'none'` | 校验深度与路径唯一性 → 默认 `fork_turns: 'all'` 时传入 `runtime.spawn({ forkFrom })` → 投递初始任务 |
| `send_message` | `target`、`message` | 写入目标邮箱 → 尝试 `runtime.send(..., { mode: 'steer', wakeIfIdle: false })`，绝不唤醒空闲成员 |
| `followup_task` | `target`、`message` | 将未读邮箱消息与新任务打包，以 `wakeIfIdle: true` 在原会话中继续执行（拒绝以 `/root` 为目标） |
| `wait_agent` | `timeout_ms?` *(默认 30s，最小 10s，最大 1h)* | 在当前轮次内挂起等待，直到收到新消息/子结果、有新输入唤醒或超时 |
| `interrupt_agent` | `target` | 调用 `runtime.interrupt()` 并将确认的 `discardedInputHashes` 恢复回目标邮箱（拒绝 `/root` 与自身） |
| `list_agents` | `path_prefix?` | 结合 `runtime.list()` 与层级树返回可见成员的路径、状态与最近 `lastOutcome` |

容器内的 Agent 使用标准 `swarm` CLI 调用：

```bash
swarm service view collaboration
swarm collaboration spawn_agent \
  --task-name reviewer \
  --message 'Audit src/parser.ts edge cases and report back.' \
  --fork-turns none \
  --request-id reviewer-start
swarm collaboration wait_agent --timeout-ms 60000 --request-id wait-reviewer
```

## 2. 控制器如何协调消息投递

[examples/subagents/controller.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/controller.ts) 的核心由三部分组成：按成员串行化操作（`serial(member, ...)`）、非唤醒 `steer` 尝试以及子结果自动上浮至直属父节点：

```ts
// 1. 向成员投递消息：若正在 wait_agent 则直接唤醒，否则仅在 running 时 steer
async function offer(member: Member, message: Message) {
  if (message.state === 'returned' || (message.state === 'pending' && releaseWait(member))) {
    return;
  }
  const { state: _state, ...payload } = message;
  const body = JSON.stringify(payload);
  const receipt = await runtime.send(member.id!, body, {
    requestId: message.id,
    source: message.from,
    mode: 'steer',
    wakeIfIdle: false,
  });

  if (receipt.status === 'accepted') {
    message.state = 'queued';
    // 按 SHA-256 记录已入队的 steer 消息，供 interrupt_agent 精准恢复
    if (receipt.disposition === 'queued') {
      member.submitted.set(createHash('sha256').update(body).digest('hex'), message);
    }
    removeMemberMessage(member, message);
    member.wait?.({ reason: 'input' });
  } else if (receipt.status === 'unknown') {
    message.state = 'unknown';
  } else {
    // 确认空闲 ('not-accepted')：安全保留在 member.inbox 中
    message.state = 'pending';
    releaseWait(member);
  }
}

// 2. 自动将子 Agent 的 settled 结果路由回直属父节点
const unsubscribe = runtime.onEvent((event) => {
  const member = byId.get(event.agentId);
  if (!member) return;
  if (event.type === 'settled' || event.type === 'exit') member.executionRevision++;
  if (event.type === 'settled') {
    member.lastOutcome = event.outcome === 'aborted' ? 'interrupted' : event.outcome;
    if (event.outcome !== 'aborted' && !(member.fatalReported && event.outcome === 'failed')) {
      resultFor(member, event); // 推入 member.parent.inbox 并调用 offer()
    }
  } else if (event.type === 'error' && event.fatal && !member.fatalReported) {
    member.lastOutcome = 'failed';
    member.fatalReported = true;
    resultFor(member, event);
  }
});
```

当用户输入发给 `/root`（或父节点调用 `followup_task`）时，`submit()` 会先对账所有 `unknown` 消息、将当前 `pending` 邮箱消息冻结打包进请求体，再以 `wakeIfIdle: true` 唤醒目标会话。

## 3. 共享工作区的安全收尾

默认情况下每位成员使用独立工作目录，子 Agent 以文本或补丁形式回报结果。当通过 `config.workspace` 给 `/root` 和子 Agent 挂载同一 `read-write` 共享工作区且 `/root` 配置了 `collect` 导出时，[examples/subagents/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/main.ts) 会先停止全部子写者并确认 `execution === 'stopped'`，再调用 `runtime.close()` 归档：

```ts
if (sharedWriters && collect && !sharedDeliveryUnverified) {
  const children = (await runtime.list()).filter((a) => a.parentId && a.status !== 'closed');
  const stops = await Promise.allSettled(
    children.map((a) => runtime.stop(a.id, { timeoutMs: childStopBudgetMs })),
  );
  sharedDeliveryUnverified = stops.some(
    (s) => s.status === 'rejected' || s.value.execution !== 'stopped',
  );
}
const receipt = await runtime.close({ timeoutMs: remainingCloseMs });
```

若任一子写者未确认停止，Harness 会追加 `SHARED_WRITERS_UNCONFIRMED` 错误并保持 `cleanup: 'pending'`，避免采集到撕裂文件。

## 4. 命令行与代码集成方式

从命令行运行（支持单次任务或交互模式）：

```bash
export MURM_SUBAGENTS_IMAGE=$(docker image inspect murm-worker:local --format '{{.Id}}')
export MURM_SUBAGENTS_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SUBAGENTS_MODEL_TOKEN='your-bearer-token'

node dist/examples/subagents/main.js dist/examples/subagents/config.js \
  'Split this task into two independent checks and summarize the results.'

node dist/examples/subagents/main.js dist/examples/subagents/config.js --interactive
```

或在 Node.js 中直接嵌入 `createSubagentsHarness`：

```ts
import { createSubagentsHarness } from './main.js';

const team = await createSubagentsHarness(config);
try {
  await team.input('Analyze the repository structure and delegate module reviews.', 'req-1');
  const reply = await team.waitForReply({ signal });
  console.log('Root reply:', reply);
} finally {
  await team.close({ timeoutMs: 30_000 });
}
```

## 源码索引

- 入口与交互 CLI：[examples/subagents/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/main.ts)
- 控制器、邮箱与中断恢复：[examples/subagents/controller.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/controller.ts)
- `collaboration` Service Manifest：[examples/subagents/collaboration-service.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/collaboration-service.ts)
- 运行说明与实验记录：[examples/subagents/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md) · [ProgramBench `fd` 实验报告](https://github.com/LuNa-shi/murm/blob/main/docs/experiments/EXP-20261125-10-issue199-fd.md)
