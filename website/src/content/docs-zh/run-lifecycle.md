---
title: 一次运行的完整脉络
description: 通过一个双 Agent 协作重构场景，按时间顺序走通 createRuntime、空闲 spawn、统一 send、文件交接、安全 interrupt 与先归档再销毁的 close。
section: 系统架构
order: 4
---

把 Runtime 原语放进真实时间线里最容易理解。下面我们走通一个典型场景：**`architect` 与 `tester` 协作重构解析器模块并补齐回归测试**——途中出现边界条件通知、`tester` 偏离方向后被安全中断且不丢消息、最后完整归档收尾。

## Agent 生命周期状态机

每个通过 `spawn()` 创建的 Agent 都遵循同一套明确的状态流转：

<div class="doc-diagram" role="region" aria-label="Agent 生命周期状态机">
  <div class="dd-fsm-top">
    <span class="dd-state dd-muted">(未分配)</span>
    <span class="dd-fsm-edge"><span>spawn()</span><span class="dd-edge-bar">──────►</span></span>
    <span class="dd-state">starting</span>
    <span class="dd-fsm-edge"><span>就绪</span><span class="dd-edge-bar">──────►</span></span>
    <span class="dd-state dd-service-state">idle</span>
    <span class="dd-fsm-edge"><span>send() [唤醒] / settled</span><span class="dd-edge-bar">◄══════►</span></span>
    <span class="dd-state dd-active">running</span>
  </div>

  <div class="dd-fsm-branches">
    <div class="dd-fsm-branch">
      <strong>starting → closing</strong>
      <span>启动失败或被取消；清理完成前槽位保持占用。</span>
    </div>
    <div class="dd-fsm-branch">
      <strong>idle / running → closing</strong>
      <span>宿主机显式调用 <code>runtime.stop()</code> 或 <code>runtime.close()</code>。</span>
    </div>
    <div class="dd-fsm-branch">
      <strong>running → exited → closing</strong>
      <span>容器内进程异常退出时自动吊销凭证；经 <code>stop()</code>/<code>close()</code> 释放槽位。</span>
    </div>
  </div>

  <div class="dd-fsm-close">
    <span class="dd-state">closing</span>
    <div class="dd-steps-box">
      <ol>
        <li>停止 Pi 进程组（冻结磁盘状态）</li>
        <li>归档原生 Pi 会话（<code>&lt;agentId&gt;/session/</code>）</li>
        <li>导出声明的 <code>collect</code> 产物（<code>&lt;agentId&gt;/artifacts/</code>）</li>
        <li>销毁沙箱容器并释放并发槽位</li>
      </ol>
    </div>
    <span class="dd-state dd-muted">closed</span>
  </div>
</div>

并发容量槽位（`maxAgents`）从 `starting` 注册那一刻起即被占用，历经 `idle`、`running`、`exited`、`closing`，直到容器销毁确认进入 `closed` 才会释放。

## 阶段一：启动 Run 并创建空闲 Agent

调用 `createRuntime()` 会冻结 Profile 与 `ServiceRegistry`，创建 `outputDir/<runtimeId>/`，并拉起 Model Gateway 和 Service Bridge。此时尚未创建任何容器。

务必在 `spawn` 或发送首条输入**之前**注册 `runtime.onEvent()`，避免漏掉快速事件。`runtime.spawn()` 会预占槽位、启动容器与 Pi 会话、完成就绪探针，并以 `status: 'idle'` 返回——不会自动发起任何模型推理：

```ts
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'output') {
    console.log(`[${event.agentId}] output seq=${event.seq}`);
  } else if (event.type === 'settled') {
    handleTurnSettled(event); // outcome: 'completed' | 'failed' | 'aborted'
  } else if (event.type === 'error' && event.fatal) {
    // 回调触发前，Core 已同步吊销该 Agent 权限
    handleFatalAgentFailure(event.agentId, event.error);
  } else if (event.type === 'exit' && !event.expected) {
    handleUnexpectedExit(event.agentId, event.reason);
  }
});

const architect = await runtime.spawn({
  requestId: 'spawn-architect',
  profile: 'architect',
  workspace: { id: 'parser-repo', mode: 'read-write' },
});

const tester = await runtime.spawn({
  requestId: 'spawn-tester',
  profile: 'tester',
  workspace: { id: 'parser-repo', mode: 'read-write' },
});
```

把“启动容器”与“发送第一条任务”拆开，使 Harness 能在任何模型调用发生前先把 `agentId` 绑定进路由表、父子树与 Service 状态。

## 阶段二：用统一的 `send()` 投递任务与中途通知

`runtime.send(agentId, input, options)` 同时承担派发任务与发送通知两种职责，通过两个关键参数精确控制时机：

- **`mode: 'followUp'`**：排在当前轮次结束之后执行，适合新任务或串行批次。
- **`mode: 'steer'`** *(默认)*：在当前工具批次结束、下一次模型请求之前插入，用来实时纠偏而不杀掉正在跑的 Bash 命令。设置 `steeringMode: 'all'` 可一次合并消费所有待处理的 steer 消息（默认 `'one-at-a-time'`）。
- **`wakeIfIdle: false`** *(默认 `true`)*：**仅在目标 Agent 当前为 `running` 时投递**；如果它已经回到 `idle`，Worker 返回 `{ inputId, status: 'not-accepted', reason: 'idle' }`，不会唤醒模型浪费 token。

```ts
// 1. 启动 architect 开始重构（唤醒空闲 Agent）
const startReceipt = await runtime.send(
  architect.id,
  'Refactor src/parser.ts and publish interface changes via `swarm notes put`.',
  { requestId: 'arch-turn-1', mode: 'followUp' },
);

// 2. 途中 tester 发现边界情况，尝试非唤醒 steer 通知
const noticeText = 'Edge case: case-sensitive paths containing slashes need escaping.';
const notice = await runtime.send(architect.id, noticeText, {
  requestId: 'notice-slash-rule',
  source: 'tester',
  mode: 'steer',
  wakeIfIdle: false,
});

if (notice.status === 'not-accepted') {
  // architect 已空闲——暂存邮箱，不触发多余模型轮次
  mailbox.enqueue(architect.id, noticeText);
} else if (notice.status === 'unknown') {
  // 传输超时——稍后用完全相同的 requestId 和参数重查回执
  pendingReconcile.push({ agentId: architect.id, requestId: 'notice-slash-rule', text: noticeText });
}
```

### 受理回执 vs. 轮次完成

`runtime.send()` 返回的是**受理回执**，而不是模型最终回复：
- `{ inputId, status: 'accepted', disposition: 'started' | 'queued' | 'handled' }`
- `{ inputId, status: 'not-accepted', reason: 'idle' }` *(仅当 `wakeIfIdle: false`)*
- `{ inputId, status: 'unknown' }`

请监听 `onEvent` 中的 `settled` 事件来判断一轮执行结束。如果传输中断或 60 秒等待超时导致 `status: 'unknown'`，请用**完全相同的 `requestId` 和参数**重试 `runtime.send()`——Runtime 会向 Worker 查询原始 RPC 账本，绝不会重复注入同一条提示词；若复用同一 `requestId` 却改动参数，会直接抛出 `CONFLICT`。

> **单输入源便捷辅助函数**：当每个 Agent 只有单一输入源且一次只跑一轮（如 Notes、Substrate、Lead-Worker）时，可直接复用 [`runInput()`](https://github.com/LuNa-shi/murm/blob/main/src/harnesses/shared/run-input.ts)：它会检查 Agent 处于 `idle`、先订阅事件再发送，并等待 `'started'` 回执与对应 `settled` 事件同时就绪。

## 阶段三：安全协作文件

根据你的协作需求选择合适的文件原语：

| 协作模式 | Runtime 原语 | 行为机制 |
| --- | --- | --- |
| **私有工作区（默认）** | `spawn({ files })` | 每个容器独享 `/workspace/project`，可预置最多 10,000 个文件 / 16 MiB |
| **共享实时工作区** | `spawn({ workspace: { id, mode: 'read-write' \| 'read-only' } })` | 多个沙箱挂载同一 Run 级共享目录；只读挂载在内核层强制只读 |
| **冻结副本** | `spawn({ workspace: { mode: 'frozen-copy', files } })` | 从不可变 `FileSeed`（如先前快照）初始化一份独立私有目录 |
| **先只读发现、认领后再授权写入** | `writable: false` → `files.prepare()` → `files.grant()` | Agent 初期无法写文件；领任务后宿主写入输入并凭内存级 `PreparedFiles` 句柄解锁写权限 |
| **运行中一致性快照** | `files.snapshot(agentId, { requestId, paths })` | Worker 暂停写入进程（共享挂载时暂停全部持有者）并返回 `{ version, digest, files }`（上限 16 MiB） |
| **受保护的在线替换** | `files.install()` → 提交领域状态 → `files.confirm()` | 仅当当前文件仍匹配 `expected: FileSnapshot` 时替换工作区，并保持写进程暂停直到 `confirm()` 放行 |

```ts
// 示例：只读发现后由宿主受控解锁写入（TaskPool 采用的模式）
const prepared = await runtime.files.prepare(worker.id, {
  requestId: 'handoff-1:prepare',
  files: taskSeedFiles,
});
// 先在宿主机提交领域所有权，再传入原 PreparedFiles 对象解锁容器写权限：
await runtime.files.grant({
  requestId: 'handoff-1:grant',
  prepared,
});
```

## 阶段四：不丢上下文的安全中断

假如运行 6 分钟后，`tester` 正在基于旧接口写测试。你不必杀死容器丢弃它积累的上下文，直接调用 `runtime.interrupt()`：

```ts
const interrupted = await runtime.interrupt(tester.id, {
  requestId: 'interrupt-tester-1',
  timeoutMs: 15_000,
});

if (interrupted.status === 'interrupted') {
  // 将 Pi 尚未消费而被清空的 steer 消息放回邮箱
  for (const digest of interrupted.discardedInputHashes ?? []) {
    const lost = submittedSteersBySha256.get(digest);
    if (lost) mailbox.requeueFront(tester.id, lost);
  }

  // 容器、会话与工作区完好保留——立刻派发新方向
  await runtime.send(
    tester.id,
    'The parser signature changed. Re-read src/parser.ts and update the test suite.',
    { requestId: 'tester-turn-2', mode: 'followUp' },
  );
}
```

`interrupt()` 会推进执行世代号（execution epoch）、取消该 Agent 挂起的 Bridge 服务调用、清空 Pi 队列、中止当前执行并等待 Pi 回到 `idle`。返回的 `discardedInputHashes`（被丢弃队列消息的 SHA-256 摘要）让 Harness 能够精准恢复尚未送达的邮箱消息。

## 阶段五：先归档再销毁的安全收尾

每个 Harness 都应遵循严格的四步收尾顺序：

1. 先停止 Harness 自身的定时器、轮询器与外部事件流，阻止新任务派发；
2. 如果多个 Agent 挂载了同一个 `read-write` 共享工作区且其中之一需要 `collect` 产物，先停止其他写者并确认 `execution === 'stopped'`；
3. 调用 `await runtime.close({ timeoutMs: 30_000 })`，Core 严格按以下顺序执行：
   1. 拒绝新受理并关闭 Bridge / Model Gateway 入口（同时执行可选的 `ServiceAdapter.exportState()`）；
   2. 确认所有容器内 Pi 进程已停止；
   3. 归档每个 Agent 的原生 Pi 会话（`<agentId>/session/`）与声明的 `collect` 文件（`<agentId>/artifacts/`）；
   4. 删除沙箱、释放槽位、关闭后端、刷盘 `evidence.jsonl` / `service-calls.jsonl` 并原子写入 `runtime.json`。
4. 仅当 `closeReceipt.cleanup === 'complete'` 后，再关闭 Harness 自己的数据库或吊销外部临时令牌。

每一份 `StopReceipt` 与 `CloseReceipt` 都独立报告两个维度：
- **`execution`（`'stopped' | 'unknown'`）**：容器内执行是否已确认停止；
- **`cleanup`（`'complete' | 'pending'`）**：会话归档、`required: true` 产物导出、沙箱销毁与日志落盘是否全部完成。

一旦某个必选产物导出或容器删除失败/超时，Core 会保留沙箱不删并返回 `cleanup: 'pending'` 及具体的 `pending[].action`（如 `'archive-session'`、`'collect-artifacts'`、`'delete-sandbox'`）。再次调用 `stop()` 或 `close()` 会自动跳过已完成阶段，只重试未完成步骤。

下一篇，在 [构建你自己的 Harness](../build-your-harness/) 中把这些原语组装成一套你自己的多智能体系统。
