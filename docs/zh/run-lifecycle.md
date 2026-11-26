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

此时还没有 Agent 沙箱。Runtime 已经拥有监听器和运行记录，也负责初始化失败后的清理。一个 backend 句柄只能被一个 Runtime 认领。Profile 与 Service 注册在该 Runtime 生命周期中保持固定；Harness 可以在这些已配置的 Profile 中选择，创建不同角色的 Agent。

## 2. 派发工作前开始观察

交接示例在 spawn 和 send 前调用 `runtime.observe({ signal })`。新订阅同时返回当前快照，以及紧接快照游标之后的事件流，因此读取当前状态与订阅后续变化之间不会出现空档。

```ts
const observation = runtime.observe({ signal });
const initialState = observation.snapshot;
```

工作进行时，宿主并行消费 `observation.events`，观察 Agent 注册、就绪、输入受理、原生执行边界、Service attempt 和资源清理。该流提供精简的身份与状态信息。需要读取 Agent 输出文本时，使用 `onEvent`，它公开 `output`、`settled`、`error`、`exit` 四类事件。

保存最后一个游标后，可在同一 Runtime 上用 `observe({ after: cursor })` 续读；续读返回 `snapshot: null`。Runtime 只缓存 256 条更新，消费者落后过多时会收到 `gap`，迭代器随后结束。这时重新调用 `observe()`，从新快照重建视图。游标不能跨 Runtime 重建使用。订阅不再需要时应显式取消，即使 Core 已关闭也一样。

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
| `execution` / `settled` | 观察到 Agent 执行完成、失败或被中止 |
| Service 操作成功 | 这个具体操作通过 Bridge 成功返回 |
| 导出文件与预期字节一致 | 交接业务结果通过宿主检查 |

一次 settlement 不会指出若干条输入中具体消费了哪些。当前执行更新给出 `association: 'unknown'`，输入事件分别保留自己的 request ID。交接示例能够把收束作为一个完成条件，是因为它独占各 Agent 的输入，并检查指定 Service 操作和最终文件。多输入源 Harness 需要自己的任务与结果协议。

已接受或尚不明确的输入可能让 Agent 状态保持 `running`，此时观察到的原生执行仍可能是 `unknown`。之后的 settlement 会释放该次执行的活动占位，通常让 Agent 回到 idle。会话、文件和 Slot 都会继续保留，供后续工作使用。

## 5. 决定怎样纠偏或中断

新任务需要排在当前执行之后时，使用 `mode: 'followUp'`；需要引导当前执行时，使用默认的 `mode: 'steer'`。Pi 在工具批次之后、下一次模型请求之前消费 steer，Codex 则对当前原生 turn 发送 steer。Pi 支持显式的 `all` 和 `one-at-a-time`，Codex 支持显式的 `all`。

`wakeIfIdle: false` 请求只向活动执行投递。Worker 可以用 `not-accepted` / `idle` 拒绝，此时 Harness 可将通知保留在自己的信箱中。跨过收束边界的已接受队列项，可能留待以后显式激活时消费。因此应检查真实回执，不能仅凭先前 `get()` 的快照推断受理结果。

`interrupt(agentId, { requestId, timeoutMs })` 会隔离旧的执行世代，取消该 Agent 挂起的 Bridge 调用，要求 Worker 清空队列并中止当前执行，然后等待确认。它保留容器、会话、工作区和 Slot。中断尚未确认时，新输入会被拒绝；重复相同 interrupt 请求可继续核对原操作。

确认后的 interrupt 可能提供 `discardedInputHashes`，即被丢弃队列文本的 SHA-256 摘要。Harness 若保存了自己提交的原文，可以用这些摘要核对信箱。摘要不能还原文本，也不证明某个任务已经完成。哪些被丢弃的内容需要用新的请求身份重新排队，由 Harness 决定。原先已接受的回执仍然描述其原始受理结果。

## 6. 选择协作所需的文件边界

交接示例使用私有工作区，并通过 Service 共享内容。其他 Harness 可以选择不同的文件策略：

| 模式 | Runtime API | 行为 |
| --- | --- | --- |
| 私有目录 | `spawn({ files })` | 为隔离项目目录预置文件；未显式选择 workspace 时采用这一方式 |
| 共享实时目录 | `spawn({ workspace: { id, mode } })` | 挂载 Runtime 内的共享项目，模式为 `read-only` 或 `read-write` |
| 冻结副本 | `spawn({ workspace: { mode: 'frozen-copy', files } })` | 从固定 `FileSeed` 创建独立目录 |
| 只读发现后取得任务所有权 | `files.prepare()`，再 `files.grant()` | 在空的只读工作区准备文件，再凭原始 prepared 句柄授予写权限 |
| 一致性捕获 | `files.snapshot()` | 在有限额度内暂停项目写者并捕获文件；共享目录需要隔离全部写者 |
| 受控替换 | `files.install()`，再 `files.confirm()` | 仅当可写私有目录仍匹配 expected snapshot 时替换，并保持写者暂停直到确认 |

这些接口管理受信的工作区访问。任务属于谁、成果是否应该发布等领域决策，由 Harness 或 Service 提交。[API 参考](./reference/api.md#受控文件原语runtimefiles)说明文件额度与请求重放行为。

## 7. 确定结果并完成 Run 收尾

交接示例停止观察，将 `business` 分类为 completed、failed 或 cancelled，再调用 `finalizeRun`。Finalizer 调用 `runtime.close`，将取得的清理回执交给产物验证器。验证器从 `receipt.agents` 定位 reader 的导出目录，并把 `received.txt` 与最初的字节比较。

开始收尾前，应停止 Harness 中会继续投递工作的定时器和外部事件源。若多个 Agent 共享可写目录，需要建立一致的导出时点：先停止其他写者，检查其 `execution: 'stopped'` 回执，再从剩下的持有者收集文件。

Core 对清理顺序提供以下保证：

1. `close` 拒绝新工作，并启动所有已注册 Agent 的清理，包括尚未完成的启动。入口关闭与 Agent 清理并行进行。
2. 每个 Agent 内部按 **确认执行停止 → 归档原生会话 → 导出声明产物 → 删除沙箱** 执行。必需归档或导出失败会阻止沙箱删除。
3. 所有 Agent 清理完成后，Core 关闭后端，刷写 evidence 和 trace，保存 `runtime.json`。尚未完成的工作会进入回执。
4. `finalizeRun` 取得 Core 回执后尝试应用的产物验证。只有 Core 清理完成时才关闭应用拥有的设施，最后保存 `run-finalization.json`。

`StopReceipt` 分别给出 `execution: 'stopped' | 'unknown'` 与 `cleanup: 'complete' | 'pending'`。`CloseReceipt` 在 `agents` 中汇总这些回执，并给出整体清理状态、待处理资源和证据进度；它没有顶层的 `execution` 字段。

必需导出失败时，沙箱会保留以便恢复。再次调用 `stop` 或 `close` 会等待原操作，或重试未完成的阶段。pending 也可能指向监听器、trace 或报告，应查看 `pending[].kind` 与 `action`；它不总是表示仍有沙箱存在。每个 Runtime 对象只调用一次 `finalizeRun`，后续通过原 Runtime 和设施句柄核对未完成的清理。

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
