---
title: Subagents · 层级委派与消息协作
description: 拆解 Subagents Program 如何通过 collaboration Service、成员邮箱与 wakeIfIdle 条件投递，实现递归委派、实时纠偏与长时并行开发。
section: 内置协作 Program
order: 6
badge: 84.37% fd
---

**Subagents** 是“一个主控 Agent 拆解问题、按需递归创建具名子 Agent 并行推进、在过程中实时互通发现并最终整合”的标准实现。完整代码位于 [examples/subagents-environment](https://github.com/LuNa-shi/SwarmEnv/tree/ac72c76/examples/subagents-environment)。

> 你可以在 [Multi-Agent Trace Viewer](../../../trace-viewer/) 中直接查看这套 Program 在 44 分钟 ProgramBench `fd` 任务中的真实多泳道运行轨迹（84.37% 官方测试通过率）。

## 1. 这个 Program 注册了什么 Service？

Subagents 没有把底层 `bot` Service 直接暴露给模型，而是在宿主注册了一个更贴近团队语义的 **`collaboration` Service**（[collaboration-service.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/subagents-environment/collaboration-service.ts)），并给每个成员分配层级路径（Root 为 `/root`，其子节点为 `/root/reviewer`，支持继续递归到 `maxDepth`）：

| 操作 | 调用示例 / 参数 | 宿主在背后做了什么 |
| --- | --- | --- |
| `spawn_agent` | `--task-name reviewer --message '...' --fork-turns none\|all` | 检查深度与重名 → 调 `runtime.spawn()`（`fork_turns: 'all'` 时传 `forkFrom`）→ 投递首条任务 |
| `send_message` | `--target /root --message '...'` | 放入目标邮箱 → 调 `runtime.send(..., { mode: 'steer', wakeIfIdle: false })`；空闲时不唤醒 |
| `followup_task` | `--target /root/reviewer --message '...'` | 取出邮箱积压消息连同新指令，以 `wakeIfIdle: true` 唤醒原 Agent 继续在同一会话中工作 |
| `wait_agent` | `--timeout-ms 60000` | 在当前轮次内挂起，直到收到任意新消息/子结果或超时返回 |
| `interrupt_agent` | `--target /root/reviewer` | 调用 `runtime.interrupt()` 打断对方，并把 `discardedInputHashes` 对应消息放回邮箱 |
| `list_agents` | `--path-prefix /root` | 结合 `runtime.list()` 返回可见成员路径、状态与上次结果 |

## 2. 它组合了 Runtime 的哪些核心原语？

Subagents 几乎把 Runtime 最精妙的几个控制原语用到了极致：

1. **会话派生（`spawn({ forkFrom })`）**：当父节点调用 `spawn_agent` 且不传 `--fork-turns none` 时，宿主向 `runtime.spawn` 传入 `forkFrom: caller.id`，子 Agent 直接继承父节点当前的完整对话前缀，省去重复铺垫背景；需要轻装独立调研时传 `none` 即可开启全新会话。
2. **不唤醒的条件投递（`send(..., { mode: 'steer', wakeIfIdle: false })`）**：这是实现“成员邮箱”而不产生竞态的关键。收到 `send_message` 或子 Agent `settled` 结果时，宿主先尝试不唤醒投递——目标正在跑，消息立刻进入它的下一轮思考；目标已经空闲，Core 返回 `not-accepted`，消息安全留在邮箱，不会白白唤醒模型。
3. **中断不丢消息（`interrupt` + `discardedInputHashes`）**：宿主记录每条已排队 `steer` 消息正文的 SHA-256。一旦 `interrupt_agent` 触发 `runtime.interrupt()`，宿主按返回的 `discardedInputHashes` 把被 Pi 清空的未消费消息无缝还原回邮箱。
4. **可选共享工作区（`workspace: { id, mode: 'read-write' }`）**：默认各成员使用私有工作目录，靠消息传小补丁；在大型代码改造中可为 Root 和 Child 挂载同一个共享工作区，关闭前宿主先停所有子写入者再导出最终文件，保证产物一致。

## 3. 宿主控制循环是如何编写的？

剥离边界检查后，[controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/subagents-environment/controller.ts) 的核心控制逻辑非常清晰——它围绕每个成员的 `inbox`（邮箱）和 `wait`（等待挂起句柄）运转：

```ts
// 1. 尝试向目标成员推送一条协作消息（不打扰空闲成员）
async function offer(member: Member, message: Message) {
  // 如果对方正在 wait_agent 中挂起，直接把消息交回 wait 并返回
  if (releaseWait(member)) return;

  const body = JSON.stringify(message);
  const receipt = await runtime.send(member.id!, body, {
    requestId: message.id,
    source: message.from,
    mode: 'steer',
    wakeIfIdle: false,
  });

  if (receipt.status === 'accepted') {
    // 若进入 Pi 队列，按正文哈希登记，以便 interrupt 时精确恢复
    if (receipt.disposition === 'queued') {
      member.submitted.set(sha256(body), message);
    }
    removeFromInbox(member, message);
  }
  // receipt.status === 'not-accepted' (idle) 时，消息自然留在 member.inbox 中
}

// 2. 监听 Runtime 事件：子 Agent 完成一轮后自动把结果推送给直属父节点
runtime.onEvent((event) => {
  const member = byId.get(event.botId);
  if (!member?.parent) return;
  if (event.type === 'settled' && event.outcome !== 'aborted') {
    const resultMsg = buildChildResultMessage(member, event);
    member.parent.inbox.push(resultMsg);
    void offer(member.parent, resultMsg);
  }
});
```

而用户在终端（`--interactive` 模式或单次命令）发来的输入，则会走 `submit(root, ...)`：先把 Root 邮箱中尚未读取的通知一并打包，再用 `wakeIfIdle: true` 送进 Root 会话。

## 4. 真实长时运行验证（ProgramBench `fd`）

在 [EXP-20261125-10](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/docs/experiments/EXP-20261125-10-issue199-fd.md) 中，这套 Subagents Program 以 3 个 Slot（Root + 2 Children）共享工作区，在 1 小时窗口内协作重建 `fd 10.3.0`：

- **真实并行**：Root 自主派生 `/root/probe_patterns` 与 `/root/probe_filters`，两个子 Agent 实际模型工作重叠 **515 秒**；
- **成果采用**：`/root/probe_filters` 编写了 66 条过滤测试并交接给 Root，Root 跑出 38 条失败、修复实现并全部转绿；
- **中途插话**：第 3 分钟注入的用户补充要求（符号链接与循环检测）经由 Root 转交子成员，产出了 16 条专项测试；
- **评测与清理**：全程 43 分 54 秒，独立 Cleanroom 评测通过 **1,042 / 1,235（84.37%）**，3 份原生会话、200 条完整模型轨迹与沙箱清理全部确认完成。

## 源码位置

- 入口与交互 CLI：[examples/subagents-environment/main.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/subagents-environment/main.ts)
- 协作控制器与邮箱：[examples/subagents-environment/controller.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/subagents-environment/controller.ts)
- Service 声明：[examples/subagents-environment/collaboration-service.ts](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/examples/subagents-environment/collaboration-service.ts)
