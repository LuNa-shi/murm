---
title: 一次运行的完整脉络
description: 沿真实 Messages 交接示例，理解 Runtime 装配、空闲 Agent、输入受理、执行观察、产物验证与资源收尾。
section: 系统架构
order: 4
---

Harness 创建 Runtime 后，一场 Run 就开始了；它要在确定业务结果并核对资源去向后完成收尾。Runtime 负责执行与清理，Harness 决定发送哪些工作，以及怎样判断结果成功。

下面沿着真实的 [Messages 交接示例](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts)理解这个过程：writer 通过 Service 发布随机内容，reader 将其写入 `received.txt`，宿主再将导出文件与原始内容比较。[SDK 指南](./sdk.md)给出安装和运行命令，这里的片段解释同一程序的生命周期。

## 1. 装配 Runtime

宿主先选择 OpenSandbox 后端、注册 Service、定义 Profile。writer 的 Profile 允许 `messages.put`，reader 允许 `messages.get`，并把 `received.txt` 声明为必需导出的产物。`createRuntime` 校验并快照化这些配置，创建 `outputDir/<runtime.id>/`，再打开 Model Gateway 和 Service Bridge。

此时还没有 Agent 沙箱。Runtime 已经拥有监听器和运行记录，也负责初始化失败后的清理。一个 backend 句柄只能被一个 Runtime 认领。Harness 创建 Agent 时，可以选择初始 Profile 或运行中登记的新 Profile。也可以通过 [Runtime 管理 API](reference/api.md#runtime-管理) 登记或退役 Service，并更新单个 Agent 的操作授权。

## 2. 派发前订阅事件

调用 `runtime.onEvent(listener)` 后，读取 `runtime.state` 和 `list()`，再创建 Agent 或发送输入。监听 `agentChanged` 时用 `get/list` 更新视图，监听 `runtimeChanged` 时读取 `runtime.state`。`output` 和 `settled` 可能在 `send` 回执之前到达。应用从自己的 Service 获取业务回执。

```ts
const unsubscribe = runtime.onEvent(event => {
  if (event.type === 'output') process.stdout.write(event.text);
});
// After observation is finished:
unsubscribe();
```

## 3. 创建空闲 Agent，再发送输入

writer 的私有目录先收到包含 key 和预期内容的文件：

```ts
const writer = await runtime.spawn({
  requestId: 'writer',
  profile: 'writer',
  files: {
    'handoff-input.json': {
      encoding: 'utf8',
      data: JSON.stringify({ key, text: expected }),
    },
  },
});
```

`spawn` 在分配沙箱前注册 Agent ID 并预占 Slot，然后启动所选 Pi 或 Codex 会话，检查就绪状态，返回空闲 Agent。Harness 发送输入后才会启动推理，因此宿主可以先把 Agent ID 接入业务状态或消息路由。

```ts
const receipt = await runtime.send(
  writer.id,
  `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`,
  { requestId: `input-${key}-put`, mode: 'followUp' },
);
```

这里存在三种不同职责的请求身份：

| 身份 | 用途 |
| --- | --- |
| Spawn 的 `requestId` | 核对同一次 Agent 分配 |
| Send 的 `requestId` 与返回的 `inputId` | 核对同一条输入是否被受理 |
| Service 的 `operation_id` | 标识 Bridge 观察到的具体业务操作 |

相同参数的 spawn 或 send 重放会返回或核对原结果。同一 request ID 下更改参数会冲突。超时不会让一个结果不明的请求自动变成新请求。

## 4. 区分输入受理、执行收束与业务结果

交接示例同时等待输入回执和相关观察。它用 Agent ID、Service ID、operation 与 operation ID 确认对应 Messages 操作成功，再确认 Agent 执行成功收束。reader 也经过相同流程，之后才在收尾时验证文件。

| 观察 | 能够说明什么 |
| --- | --- |
| `accepted`，附带 `started`、`queued` 或 `handled` | 执行器按该方式接受了输入 |
| `not-accepted`，原因为 `idle` | 条件输入没有唤醒空闲 Agent |
| 输入回执为 `unknown` | 暂时无法确认受理情况，应保留原调用以继续核对 |
| `settled` | 观察到 Agent 执行完成、失败或被中止 |
| Service 操作成功 | 这个具体操作通过 Bridge 成功返回 |
| 导出文件与预期字节一致 | 交接业务结果通过宿主检查 |

一次 settlement 不会指出若干条输入中具体消费了哪些。各次投递的请求 ID 由应用在输入回执中核对。交接示例能够把收束作为一个完成条件，是因为它独占各 Agent 的输入，并检查指定 Service 操作和最终文件。多输入源 Harness 需要自己的任务与结果协议。

已接受或尚不明确的输入可能让 Agent 状态保持 `running`，此时观察到的原生执行仍可能是 `unknown`。之后的 settlement 会释放该次执行的活动占位，通常让 Agent 回到 idle。会话、文件和 Slot 都会继续保留，供后续工作使用。

## 5. 决定怎样纠偏或中断

新任务需要排在当前执行之后时，使用 `mode: 'followUp'`；需要引导当前执行时，使用默认的 `mode: 'steer'`。Pi 在工具批次之后、下一次模型请求之前消费 steer，Codex 则对当前原生 turn 发送 steer。Pi 支持显式的 `all` 和 `one-at-a-time`，Codex 支持显式的 `all`。

`wakeIfIdle: false` 请求只向活动执行投递。Worker 可以用 `not-accepted` / `idle` 拒绝，此时 Harness 可将通知保留在自己的信箱中。跨过收束边界的已接受队列项，可能留待以后显式激活时消费。因此应检查真实回执，不能仅凭先前 `get()` 的快照推断受理结果。

`interrupt(agentId, { requestId, timeoutMs })` 会隔离旧的执行世代，取消该 Agent 挂起的 Bridge 调用，要求 Worker 清空队列并中止当前执行，然后等待确认。它保留容器、会话、工作区和 Slot。中断尚未确认时，新输入会被拒绝；重复相同 interrupt 请求可继续核对原操作。

确认后的 interrupt 可能提供 `discardedInputHashes`，即被丢弃队列文本的 SHA-256 摘要。Harness 若保存了自己提交的原文，可以用这些摘要核对信箱。摘要不能还原文本，也不证明某个任务已经完成。哪些被丢弃的内容需要用新的请求身份重新排队，由 Harness 决定。原先已接受的回执仍然描述其原始受理结果。

## 6. 选择协作的文件边界

私有目录的初始内容由 `spawn({ files })` 设置。用 `files.snapshot` 捕获完整 `FileTree` 后，也可以以其文件创建另一个私有目录。共享目录用 `spawn({ workspace: { id, mode } })` 挂载全部写者可见的路径。共享捕获需要暂停相关写者。

在原 Agent 交接工作时，Harness 先建立业务所有权，取得完整目录摘要，再调用一次 `files.replace`。该操作可以在成功后开放写入。成功回执发出时写者已恢复。保留原请求以处理未知结果。Workspace Service 在 Core 文件已更新、业务提交失败时只继续业务提交，保留 Agent 的后续写入。

## 7. 核对结果并关闭 Run

停止派发后调用 `runtime.close({ timeoutMs })`。每个 Agent 依次确认执行停止、归档 Session、导出文件并删除 Sandbox。必需归档或导出失败时保持 Sandbox 和 Slot。重试同一个 Runtime 的 `stop` 或 `close` 可以恢复未完成的工作。

`StopReceipt` 区分 `execution: 'stopped' | 'unknown'` 与 `cleanup: 'complete' | 'pending'`。 `CloseReceipt` 汇总这些回执，并指出需要继续处理的 Runtime 端点和报告。应用从回执定位导出文件，自行判断交接字节是否准确，只清理自己拥有的设施。

## Agent 生命周期与容量

| 状态 | 对 Harness 的含义 |
| --- | --- |
| `starting` | Agent 身份与 Slot 已预留，正在分配或检查就绪 |
| `idle` | 会话已就绪，可以接收输入，Slot 继续占用 |
| `running` | 存在原生执行或尚未解决的输入活动 |
| `exited` | 执行器意外退出，Runtime 仍拥有清理责任 |
| `closing` | 清理正在进行或等待确认 |
| `closed` | 已确认沙箱删除，Slot 释放 |

fatal Agent 错误会在通知订阅者之前拒绝新权限使用。意外退出会吊销凭证，但不会单独释放容量。宿主仍可通过 `get` 或 `list` 检查 Agent，并调用 `stop` 或 `close` 完成清理。停止父 Agent 不会自动停止子 Agent；Runtime close 覆盖所有已注册的 Agent。

[SDK 指南](./sdk.md)在可运行示例中串起这些步骤，[构建自己的 Harness](./build-your-harness.md)则说明如何把交接策略替换为自己的协作机制。
