---
title: 核心概念
description: 通过六个正交概念——Agent、Service、Sandbox、Runtime、Run 与 Program——建立清晰的多智能体系统心智模型。
section: 快速开始
order: 2
---

设计多智能体系统时，容易让人迷失的往往是两类职责混在了一起：**基础设施**（隔离容器、模型会话、凭据管理、日志与清理）与**协作逻辑**（谁拆任务、信息给谁看、何时结束）。

`murm` 用六个彼此正交的概念把这两层彻底拆开：

- **编写侧（你定义什么）**：写一个 **`Program`**，组合若干 **`Agent`** 和 **`Service`**。
- **运行侧（`murm` 管理什么）**：**`Runtime`** 为每个 Agent 分配隔离的 **`Sandbox`**，每次执行产出一条可检查、可回放的 **`Run`**。

下面我们逐个拆解每个概念，每个概念只配几行最关键的代码；全部理解后，再把它们拼成一段完整可运行的程序。

---

## 1. Agent：带持久会话的独立执行个体

**Agent** 是系统中真正思考和动手的执行个体（在当前 `@swarmenv/core` 代码中命名为 `Bot`）。每个 Agent 内部运行一个原生 Pi 会话，手里默认只有四个本地工具：`read`、`write`、`edit`、`bash`。

创建一个 Agent 时，你通过一份静态配置（**Profile**）说明它的角色提示词、使用的模型、镜像以及允许调用的共享能力：

```ts
const readerProfile = {
  prompt: '核对共享笔记中的事实，并将结果整理到 review.md。',
  model: 'default',
  image: 'murm-worker:local',
  writable: true,
  services: { notes: ['get'] }, // 只能读取 notes，不能写入
};
```

理解 Agent 只需记住两件事：
1. **跨轮次持久存活**：完成一轮推理后，Agent 回到 `idle` 状态，不会销毁。它的对话历史（Session）和工作目录完整保留，可以直接接着上一轮继续追问或修改代码。
2. **提示词引导决策，权限划定边界**：`prompt` 告诉模型应该怎么协作；`services` 和 `writable` 则由底层强制校验，越权调用会被直接拦截。

---

## 2. Service：可组合的共享协作能力

既然每只 Agent 都在各自的隔离空间里、只有四个基础工具，它们怎样认领任务、互通消息或发布成果？答案就是 **Service**。

Service 是宿主注册给 Agent 的共享能力。定义一个 Service 只需要提供两样东西：
- **接口说明（`manifest`）**：声明服务名、操作名、用途与输入输出 JSON Schema；
- **实际执行代码**：既可以是宿主进程里的一个本地函数（`createInProcessAdapter`），也可以转发到独立的远端 HTTP 服务（`createHttpJsonAdapter`）。

```ts
services.registerService({
  manifest: notesManifest, // 声明 put / get 两个操作及其 JSON Schema
  adapter: createInProcessAdapter({
    invoke({ capability, input, caller }) {
      if (capability.operation === 'get') return records.get(input.key) ?? null;
      // caller.botId 由 Runtime 鉴权后自动注入，Agent 无法伪造作者身份
      const entry = { key: input.key, text: input.text, author: caller.botId };
      records.set(input.key, entry);
      return entry;
    },
  }),
});
```

在容器内，Agent 用统一的 `swarm` 命令发现和调用所有获准使用的 Service：

```bash
swarm service list
swarm notes put --input note-request.json --request-id notes-put
swarm notes get --key core-service-boundary --request-id notes-get
```

正因调用方式高度统一，把任务池（Flat）、团队消息（Subagents）、信息板（Agensh）或不可变成果库（ScaleMAS）封装成 Service 后，底层 Agent 无需新增任何专用工具就能接入。

---

## 3. Sandbox：隔离的执行空间

每个 Agent 运行在独立的 **Sandbox**（当前为 OpenSandbox 管理的本地 Docker 容器）中，带来三项保障：

- **文件隔离与按需共享**：默认每个 Agent 独占工作目录，可以同时修改同名文件而互不冲突；需要协作编辑同一代码树时，宿主也可以在 `spawn` 时为多只 Agent 挂载同一个共享工作区（`workspace: { id, mode: 'read-write' }`）。
- **网络与凭据隔离**：容器默认只能访问宿主的 Service Bridge 与 Model Gateway，外加 Profile 显式放行的 IPv4 地址。模型 API Key 等敏感凭据永远留在宿主侧。
- **可靠的导出与回收**：停止 Agent 时，先停止执行进程，再从沙箱导出完整会话与声明保留的文件（`collect`），确认归档成功后才删除容器并释放名额（Slot）。

---

## 4. Runtime：控制所有 Agent 的运行引擎

**Runtime** 是宿主操作 Agent 的统一控制面。你向它提交资源与执行指令，它负责把这些指令可靠地落实到沙箱与 Pi 进程中。

Runtime 的核心操作可以归结为四件事：

```ts
// 1. 创建与查询 Agent
const agent = await runtime.spawn({ requestId: 'a1', profile: 'reader', files: seedFiles });

// 2. 投递输入（推荐统一使用 send，通过 mode 和 wakeIfIdle 精确控制时机）
await runtime.send(agent.id, '请阅读笔记并生成 review.md', {
  requestId: 'turn-1',
  mode: 'followUp',
});

// 3. 订阅实时运行事件（输出、本轮收束 settled、错误、退出）
const off = runtime.onEvent((event) => {
  if (event.type === 'settled') console.log(event.botId, event.outcome);
});

// 4. 停止单个 Agent 或关闭整次运行
await runtime.stop(agent.id);
await runtime.close();
```

> **关于 `send`、`start` 与 `steer`**：在当前 `@swarmenv/core` 代码中，`runtime.start` 和 `runtime.steer` 只是 `runtime.send` 的薄别名（分别对应 `mode: 'followUp'` 与 `mode: 'steer'`）。只有 `send` 覆盖全部参数（包括不唤醒空闲 Agent 的 `wakeIfIdle: false`）。编写新 Program 时建议**统一使用 `send`**，语义最清晰。

---

## 5. Run：一次具体的系统执行与留痕

每当你启动 Runtime 跑完一轮协作，就产生了一次独立的 **Run**（拥有唯一的 `runId`，对应当前 `runtime.id`）。

Run 不仅是内存里的运行过程，更是持久化在 `outputDir/<runId>/` 下的完整现场包：包含配置快照、有序事件流水（`evidence.jsonl`）、全部 Service 调用记录（`service-calls.jsonl`）、真实模型请求与流式响应（`model-trace/`）、每只 Agent 的原生会话归档以及最终导出的项目文件。运行结束后，你可以直接把这份目录拖进 [Multi-Agent Trace Viewer](../../trace-viewer/) 复盘整场协作。

---

## 6. Program：你编写的多智能体运行逻辑

如果说 **Runtime** 是“能把多只 Agent 稳定跑起来的引擎”，那么 **Program**（在当前代码库中称为 `Environment`）就是**跑在这个引擎上的多智能体应用程序**。

两者的分工非常明确：
- **Runtime 是被动的**：一只 Agent 跑完一轮发出 `settled` 后，它会停在 `idle` 等待。Runtime 绝不会擅自决定“把 A 的结论转发给 B”或“催它继续干下一轮”。
- **Program 是主动的大脑**：它负责注册 Service、创建参与者、监听 `onEvent`（或外部聊天/Git 事件）、决定下一条 `send` 发给谁、以及判断整个任务何时验收结束。

---

## 把六个概念拼在一起

把上面几段拆解合拢，就是一段完整的多智能体 Program 骨架：

```ts
import { createRuntime } from '@swarmenv/core';
import { ServiceRegistry, createInProcessAdapter } from '@swarmenv/core/services';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';

// 1. 准备共享 Service
const services = new ServiceRegistry();
services.registerService({ manifest: notesManifest, adapter: createNotesAdapter() });

// 2. 启动 Runtime，开启一次 Run
const runtime = await createRuntime({
  backend: createPiOpenSandboxBackend(config.backend),
  services,
  profiles: { writer: writerProfile, reader: readerProfile },
  maxBots: 2,
  outputDir: './runs',
});

// 3. Program 编排多只 Agent 的协作顺序
const writer = await runtime.spawn({ requestId: 'spawn-w', profile: 'writer', files: seedFiles });
await runInput(runtime, writer.id, '用 swarm notes put 发布这段调研结论', { requestId: 't1', timeoutMs: 30_000 });

const reader = await runtime.spawn({ requestId: 'spawn-r', profile: 'reader', files: seedFiles });
await runInput(runtime, reader.id, '用 swarm notes get 核对并输出 review.md', { requestId: 't2', timeoutMs: 30_000 });

// 4. 关闭并自动归档本次 Run 的会话、轨迹与产物
await runtime.close();
```

## 当前代码术语映射表

在阅读仓库源码时，可以随时对照下表：

| `murm` 文档概念 | 当前 `@swarmenv/core` 源码名称 | 说明 |
| --- | --- | --- |
| `Agent` | `Bot` (`BotInfo`, `BotEvent`) | 隔离沙箱中的独立执行个体 |
| `Program` | `Environment` (`src/environments/*`) | 宿主侧协作程序与策略 |
| `Runtime` | `Runtime` (`createRuntime`) | 运行引擎与控制接口 |
| `Run` | 单次 `Runtime` 实例与 `outputDir/<runtimeId>/` | 一次具体执行及其落盘现场 |
| `Sandbox` | OpenSandbox 容器 + `Worker` | 隔离文件系统、网络与进程边界 |
| `Service` | `Service` (`ServiceRegistry`) | 可组合共享操作与业务状态 |

接下来阅读 [系统架构](../architecture/)，看看宿主与沙箱容器内部究竟是如何连接的。
