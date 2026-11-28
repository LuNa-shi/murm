---
title: Subagents
description: 主 Agent 按需拆解任务并派生子 Agent，通过邮箱异步沟通、中途纠偏并汇总成果的层级协作模式。
section: 内置 Harness
order: 11
---

**Subagents** 模拟常见的层级研发团队：由主 Agent（`/root`）拆解目标、按需创建子 Agent（最多 `maxDepth` 层）、通过邮箱收发消息并在必要时中途纠偏，最后由 `/root` 整合交付结果。源码：[examples/subagents](https://github.com/LuNa-shi/murm/tree/main/examples/subagents)。

## Harness Session

模块默认导出 `Harness`。SDK Session、显式前台和 RPC 都使用这份定义。Harness 负责业务流程及资源清理。[Harness 编写指南](../first-harness.md)

用 `--lifetime interactive` 保留 Root 以接收后续输入。公共 Session 接受 Root 文本或 `{ text, mode }`。Root 控制还支持结构化 context，`describe()` 列出当前允许的配置和操作。中断封锁旧执行，children 可以继续。中断后收到的结果保留在 inbox，等用户明确提交下一次输入。开启 `--interaction questions` 后，Agent 可通过 `swarm service invoke user-interaction ask` 发起授权问题。

## 快速运行（CLI）

配置好 `MURM_MODEL_URL` 与 `MURM_MODEL_TOKEN`（见 [快速上手](../quickstart.md)）后，在任意项目目录直接启动：

```bash
cd my-project
murm --harness subagents --prompt "根据解析测试修复当前项目"
```

Subagents 会把提示词发送给 `/root`，并为 `/root` 及每个子 Agent 各自准备独立的项目沙箱副本；在 `--mode rpc` 下，运行中追加的用户输入会路由给 `/root`。下文拆解其 `collaboration` Service、邮箱调度器以及从源码嵌入运行的方式。

## 1. 注册的 Service（`collaboration`）

Subagents 注册了一个领域专属的 **`collaboration` Service**（[collaboration-service.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/collaboration-service.ts)），为每位成员分配层级路径（如 `/root`、`/root/reviewer`、`/root/reviewer/parser`）：

| 操作 | 核心参数 | 宿主行为 |
| --- | --- | --- |
| `spawn_agent` | `task_name`、`message`、`fork_turns?: 'all' \| 'none'` | 校验深度与路径唯一性 → 默认 `fork_turns: 'all'` 时传入 `runtime.spawn({ forkFrom })` → 投递初始任务 |
| `send_message` | `target`、`message` | 写入目标邮箱 → 尝试 `runtime.send(..., { mode: 'steer', wakeIfIdle: false })`，绝不唤醒空闲成员 |
| `followup_task` | `target`、`message` | 将未读邮箱消息与新任务打包，以 `wakeIfIdle: true` 在原会话中继续执行（拒绝以 `/root` 为目标） |
| `wait_agent` | `timeout_ms?` *(默认 30s，最小 10s，最大 1h)* | 在当前轮次内挂起等待，直到收到新消息/子结果、有新输入唤醒或超时 |
| `interrupt_agent` | `target` | 调用 `runtime.interrupt()` 并将确认的 `discardedInputHashes` 恢复回目标邮箱（拒绝 `/root` 与自身） |
| `list_agents` | `path_prefix?` | 结合 `runtime.list()` 与层级树返回可见成员的路径、状态与最近 `lastOutcome` |

上下文分叉取决于执行器。随仓库提供的 Pi 后端支持 `fork_turns: 'all'`；Codex 要求显式传入 `fork_turns: 'none'`。宿主读取后端能力并提供对应的 Service schema。复制会话上下文不会共享私有文件。

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

[examples/subagents/harness/controller.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/controller.ts) 按成员串行化操作，在不唤醒空闲成员的前提下尝试投递通知，并把子成员结果送回直属父节点。下面的节选展示投递流程，完整控制器还负责接纳、重试与关闭：

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

从已构建的仓库运行，只需配置模型端点（Subagents 配置默认使用 `DEFAULT_WORKER_IMAGE`，即 `ghcr.io/luna-shi/murm-worker:0.2.0`，也可通过 `MURM_WORKER_IMAGE` 或 `MURM_SUBAGENTS_IMAGE` 覆盖），然后选择单次任务或交互入口。[示例 README](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md) 说明 OpenSandbox 准备步骤与可选宿主设置：

```bash
export MURM_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_MODEL_TOKEN='your-bearer-token'
# 可选：覆盖默认官方 Worker 镜像（ghcr.io/luna-shi/murm-worker:0.2.0）
# export MURM_WORKER_IMAGE='ghcr.io/luna-shi/murm-worker:0.2.0'

node dist/examples/subagents/main.js dist/examples/subagents/config.js \
  'Split this task into two independent checks and summarize the results.'

node dist/examples/subagents/main.js dist/examples/subagents/config.js --interactive
```

或在 Node.js 中直接嵌入 `createSubagentsHarness`：

```ts
// 放在示例 main.js 与 config.js 旁边的宿主模块中。
import { createSubagentsHarness } from './main.js';
import config from './config.js';

const signal = AbortSignal.timeout(120_000);
const team = await createSubagentsHarness(config);
try {
  const admitted = await team.input('Analyze the repository structure and delegate module reviews.', 'req-1');
  if (admitted.status !== 'accepted') throw new Error('Root input is unconfirmed');
  const reply = await team.waitForReply({ signal });
  console.log('Root reply:', reply);
} finally {
  const receipt = await team.close({ timeoutMs: 30_000 });
  console.log('Cleanup:', receipt.cleanup);
}
```

底层工厂不会把 CLI 的工作时限自动应用到自定义宿主的所有操作上；调用者需要传入取消信号并限制自己的工作窗口。连续发送用户输入时，将上一次回复序号传给 `waitForReply({ after, signal })`，避免把旧回复当成新结果。回复 outcome 与关闭回执应分别检查。

## 源码索引

- 入口与交互 CLI：[examples/subagents/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/main.ts)
- 控制器、邮箱与中断恢复：[examples/subagents/harness/controller.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/controller.ts)
- `collaboration` Service Manifest：[examples/subagents/services/collaboration-service.ts](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/collaboration-service.ts)
- 运行说明与实验记录：[examples/subagents/README.md](https://github.com/LuNa-shi/murm/blob/main/examples/subagents/README.md) · [ProgramBench `fd` 实验报告](https://github.com/LuNa-shi/murm/blob/207be6356c16e5fb60c4b3c5b236d7a98383f991/docs/experiments/EXP-20261125-10-issue199-fd.md)
