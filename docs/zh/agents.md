---
title: Agent 与 Profile
description: 学会用 Profile 定义角色、启动持久化 Agent 会话、发送消息与途中纠偏、区分受理与收束，以及处理中断和幂等重试。
section: 核心构件与实战
order: 5
---

在 `murm` 中，**Profile** 是角色蓝图，**Agent** 是按蓝图启动的持久化执行器会话。理解这一页，你就能自如地控制每个成员何时启动、怎么接任务、怎样中途纠偏以及何时回收资源。

## 1. 用 Profile 定义角色

每个 Agent 都从你在 `createRuntime({ profiles })` 中命名的角色模板创建：

```ts
const profiles = {
  researcher: {
    prompt: '独立分析代码库中的性能瓶颈，并把经过验证的结论发布到共享黑板。',
    model: 'default', // 引用 runtime.models 中的别名
    image: DEFAULT_WORKER_IMAGE, // 该角色使用的容器镜像
    writable: false, // 限制是否允许修改 /workspace/project
    services: { board: ['publish', 'search'] }, // 该角色获准调用的 Service 白名单
    collect: { paths: ['notes.md'], includeGit: false, maxBytes: 1_048_576, required: false }, // 关闭前自动导出的产物
  },
};
```

> **为什么 `image` 配在 Profile 而不是 Runtime 上？**
> 在多智能体团队里，不同角色常常需要不同的运行环境——比如普通研究员用轻量的官方镜像（`workerImageFor(executor)` 或 `DEFAULT_WORKER_IMAGE`），而负责形式化证明或特定语言编译的专家角色需要预装 Lean / Rust 工具链的镜像。把 `image` 放在 Profile 上，同一场 Run 就能混编不同环境的角色；如果团队环境相同，所有角色填同一个镜像常量即可。

其余常用可选字段：`spawnProfiles` 与 `allowContextFork`（允许该角色通过内置 `agent` Service 派生哪些子角色以及能否分叉上下文）、`network: { allow: [...] }`（放行特定内网地址）。

## 2. 启动与持久化会话生命周期

```text
spawn() ──► starting ──► idle ◄──► running ──► stop() / close() ──► closing ──► closed
                          │           │
                          └───────────┴──► 进程异常退出 ──► exited ──► stop() / close()
```

```ts
// 启动一个 Agent（可选通过 files 灌入初始私有文件）
const researcher = await runtime.spawn({
  requestId: 'spawn-researcher-1',
  profile: 'researcher',
  files: {
    'brief.txt': { encoding: 'utf8', data: '重点检查内存分配与缓存失效。' },
  },
});
```

使用 Agent 时记住三个直观特性：

1. **启动后处于空闲（`idle`）**：`spawn()` 只准备容器与会话，不会自动调用模型，直到你调用 `runtime.send()` 派发任务。
2. **多轮对话保留上下文与文件**：一轮执行结束回到 `idle` 后，Agent 仍保留之前的对话历史和工作区文件，你可以继续追问、让它补充调研或修改代码。
3. **槽位直到 `stop()` 才释放**：每个未关闭的 Agent（包括 `idle` 和异常 `exited`）都会占用 `maxAgents` 配额中的一个槽位。成员干完活不再需要时，调用 `runtime.stop(agent.id)` 归档并销毁容器，槽位随即释放给新成员。

## 3. 给 Agent 发消息：`runtime.send()`

调用 `runtime.send(agentId, text, options)` 可以按不同场景向 Agent 投递输入：

| 选项组合 | 效果 | 适合的场景 |
| --- | --- | --- |
| `mode: 'steer'`（默认） | 如果 Agent 正在干活，在安全边界立刻把消息插进去纠偏；如果空闲则直接开始新一轮 | 中途补充需求、把队友的最新发现推给正在忙的成员 |
| `mode: 'followUp'` | 排在当前轮次后面，等这轮做完再接着做（空闲时立即启动） | 按顺序串联下一阶段任务 |
| `wakeIfIdle: false` | **只投给正在忙的 Agent**；如果对方已经空闲，明确返回 `not-accepted` (`idle`)，不唤醒它 | 避免用一条次要通知无谓唤醒已空闲的成员、浪费 token |

```ts
const receipt = await runtime.send(
  researcher.id,
  '请开始检查缓存模块，并把有价值的发现写进 board。',
  { requestId: 'task-1', mode: 'followUp' },
);
```

## 4. 分清「消息收到了」和「这轮干完了」

调用 `runtime.send()` 会立刻返回一条**接纳回执（receipt）**，它只代表消息有没有送进执行器，不代表推理已经完成：

- **`receipt.status === 'accepted'`**：执行器收下了这条消息（`started` 刚启动 / `queued` 已排队 / `handled` 已注入），请继续在 `runtime.onEvent()` 里等 `settled` 事件判断这一轮是否结束。
- **`receipt.status === 'not-accepted'`**：比如传入 `wakeIfIdle: false` 时目标刚好空闲，你的 Harness 可以放心把消息留在自己的邮箱里，等下次需要时再发。
- **`receipt.status === 'unknown'`**：遇到网络超时等不确定情况时，**千万别换新 `requestId` 重发**（容易导致重复执行）；直接沿用原来的 `requestId` 原样重试 `send()` 对账，Runtime 会告诉你那条消息当初到底有没有被接纳。

> 同理，这一轮执行结束（`settled`）只说明模型停下来了，并不自动等于业务目标达成——真正的验收应结合你的 Service 状态和导出文件判断。

## 5. 中断当前执行而不销毁容器：`runtime.interrupt()`

如果任务方向变了、需要立刻叫停正在推理的 Agent，但又想保留它的对话记忆和工作区文件，调用 `runtime.interrupt()`：

```ts
const result = await runtime.interrupt(researcher.id, {
  requestId: 'interrupt-1',
});
// 如果中断前有排队但尚未消费的消息，result.discardedInputHashes 会返回它们的 SHA-256 摘要，
// 方便你的 Harness 邮箱精准找回未处理的消息。
```

`interrupt()` 会立刻中止当前推理和在途 Service 调用、清空排队输入，同时保留容器、会话和并发槽位；确认中断后即可重新 `send()` 新指令。

---

**下一步**：看看沙箱里的 Agent 是如何穿过 **[Host Gateway 宿主机网关](gateway.md)** 安全调用模型与共享 Services 的。
