---
title: 核心心智模型
description: 理解 murm 的底层模型——Harness 如何调度 Runtime 沙盘中的隔离沙箱、可定制共享 Services、外部 Host Gateway 与持久化 Run 追踪。
section: 快速开始
order: 2
---

多智能体系统之所以难以维护，往往是因为**协作逻辑**（谁拆解任务、谁能看到什么、何时打断、何时算成功）和**基础设施**（容器、会话、密钥、网络规则、追踪日志、资源清理）搅在了一起。

`murm` 在二者之间划清了边界：**你只写协作规则，`murm` 负责跑稳基础设施。**

## 整体心智模型

可以把在 `murm` 上运行的一个集群想象成五个相互配合的层次：

<div class="doc-diagram" role="region" aria-label="murm 五层协同心智模型图">
  <div class="dd-row-2-arrow">
    <div class="dd-box dd-yellow">
      <div class="dd-box-title">HARNESS</div>
      <ul class="dd-list">
        <li>你写的控制循环与协作规则</li>
        <li>角色 Profiles 与结束策略</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄── spawn · send · onEvent ──►</div>
    <div class="dd-box dd-indigo">
      <div class="dd-box-title">RUNTIME（沙盘舞台）</div>
      <div class="dd-sandbox-stack">
        <div class="dd-sandbox-pill"><strong>SANDBOX A</strong> · Agent（Pi + 工作区）</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX B</strong> · Agent（Pi + 工作区）</div>
        <div class="dd-sandbox-pill"><strong>SANDBOX C</strong> · Agent（Pi + 工作区）</div>
      </div>
    </div>
  </div>

  <div class="dd-pipes">
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>注册服务</strong><span>v2 Manifest 与适配器</span></span>
    </div>
    <div class="dd-pipe">
      <span class="dd-pipe-line" aria-hidden="true">│<br/>▼</span>
      <span class="dd-pipe-meta"><strong>swarm CLI · /v1/responses</strong><span>经宿主机网关鉴权转发</span></span>
    </div>
  </div>

  <div class="dd-row-3">
    <div class="dd-box dd-service">
      <div class="dd-box-title">SHARED SERVICES</div>
      <ul class="dd-list">
        <li>可定制共享状态与工具</li>
        <li>看板、任务池、Git 与验证器</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">◄──</div>
    <div class="dd-box dd-teal">
      <div class="dd-box-title">HOST GATEWAY</div>
      <ul class="dd-list">
        <li>Service Bridge（鉴权 + Schema）</li>
        <li>Model Gateway（宿主机密钥）</li>
      </ul>
    </div>
    <div class="dd-arrow-h" aria-hidden="true">──►</div>
    <div class="dd-box dd-amber">
      <div class="dd-box-title">RUN TRACES</div>
      <ul class="dd-list">
        <li>outputDir/&lt;runtimeId&gt;/</li>
        <li>会话、调用记录与导出产物</li>
      </ul>
    </div>
  </div>
</div>

1. **你编写 Harness**：运行在宿主机上的普通 TypeScript 程序，定义 Agent 角色（**Profile**）、注册共享 **Services**，并用控制循环调用 `spawn`、`send`、`interrupt`、`onEvent`、`stop`、`close`。
2. **Runtime 是集群沙盘**：负责按 `maxAgents` 槽位分配隔离的 **Sandbox**，在多轮交互间保持每个 **Agent** 存活，并强制执行权限与容量上限。
3. **每个 Agent 运行在独立 Sandbox 中**：一个 Docker 容器，内置持久化 **Pi** 会话、独立工作目录（或显式挂载的共享工作区），以及最精简的四个本地工具（`read`、`write`、`edit`、`bash`）。
4. **跨 Agent 协作全部通过可定制 Services 完成**：容器之间不直接互连，而是经由沙盘外的 **Host Gateway**（Service Bridge + Model Gateway）用统一的 `swarm` CLI 调用宿主注册的 Services，同时上游模型 API 密钥绝不进入容器。
5. **每次 Run 自动沉淀完整 Trace**：生命周期事件、Service 调用、原始模型请求/响应、原生 Pi 会话与导出产物全部写入 `outputDir/<runtimeId>/`。

---

## 1. Harness —— 你写的控制循环与规则

**Runtime 本身是被动的。** 当某个 Agent 完成一轮思考并触发 `settled` 事件时，它只会安安静静回到 `idle` 状态，保留自己的会话与文件。Runtime 永远不会擅自替你把结果转发给另一个 Agent、追加下一轮输入或结束任务。

所有主动策略都归 **Harness** 掌控：
- 决定有哪些角色，以及每个角色允许调用哪些 Service 操作；
- 决定何时派生新 Agent、何时从父 Agent 分叉上下文（`forkFrom`）、何时挂载共享工作区；
- 决定如何响应 `settled` 事件、外部聊天消息或任务领取，以及何时 `interrupt` 或 `stop` 某个 Agent；
- 决定什么才算真正的业务成功（例如验证通过的 Git 提交、Lean 证明通过、或宿主校验过的产物文件）。

仓库中五种内置拓扑都是普通的 Harness，位于 `src/harnesses/` 和 `examples/`。

---

## 2. Agent 与 Profile —— 持久化执行单元与硬边界

每个 **Agent** 都是容器内运行的持久化 Pi `1.3.0` 会话，具备两个关键特性：

1. **跨轮次持久化**：一轮执行结束后，Agent 从 `running` 回到 `idle`，不会销毁容器或清空上下文，Harness 可随时向同一会话与工作区发送后续指令。
2. **提示词引导，Profile 硬约束**：`Profile.prompt` 告诉模型该如何协作，而 `Profile.services`、`Profile.writable`、`Profile.network` 与 `Profile.spawnProfiles` 由 Runtime 和 Bridge 强制执行。

```ts
import type { Profile } from '@murm/core';

const profiles: Record<string, Profile> = {
  writer: {
    prompt: 'Inspect review-input.json and publish the finding with `swarm notes put`.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['put'] },
  },
  reader: {
    prompt: 'Read the published note via `swarm notes get` and write review.md.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['get'] },
    collect: {
      paths: ['review.md', 'followup.md'],
      includeGit: false,
      maxBytes: 64 * 1024,
      required: true,
    },
  },
};
```

调用 `createRuntime()` 时，Profile 会被深拷贝并冻结；未知模型别名或未注册的 Service 操作会在分配任何沙箱前立即报错。

---

## 3. 可定制 Services —— 自由构建协作方式

由于容器内只暴露四个本地工具（`read`、`write`、`edit`、`bash`），**所有跨 Agent 交互都由你注册的 Services 定义**。

无论你需要共享键值表、层级邮箱、SQLite 事务任务板、Lean 证明验证器，还是 Git PR 合并门控，只需声明一份 v2 `ServiceManifest`（操作列表 + 严格 JSON Schema draft-07 契约），并绑定以下任一适配器：
- **`createInProcessAdapter`**：直接运行在宿主 Harness 进程内的 TypeScript 函数；
- **`createHttpJsonAdapter`**：由宿主机鉴权的 HTTP JSON 代理，对接外部独立服务。

```ts
import { ServiceRegistry, createInProcessAdapter } from '@murm/core/services';

const records = new Map<string, { key: string; text: string; author: string }>();
const services = new ServiceRegistry();

services.registerService({
  manifest: notesManifest, // 声明 put / get 操作与 JSON Schema
  adapter: createInProcessAdapter({
    invoke({ capability, input, caller, assertAuthorized }) {
      const req = input as { key: string; text?: string };
      const existing = records.get(req.key);
      if (capability.operation === 'get') return existing ?? null;

      if (existing) {
        if (existing.author === caller.agentId && existing.text === req.text) return existing;
        throw Object.assign(new Error('Key already exists with different content'), { code: 'CONFLICT' });
      }

      // 在真正修改共享状态前再次同步确认调用者权限未被撤销
      assertAuthorized();
      const entry = { key: req.key, text: req.text!, author: caller.agentId };
      records.set(req.key, entry);
      return entry;
    },
  }),
});
```

在沙箱内，Agent 只需通过统一的 `swarm` CLI 发现并调用已授权的 Service，无需编写任何自定义 Pi 插件或专属工具定义：

```bash
swarm service list
swarm service view notes
swarm notes put --input note-request.json --request-id notes-put
swarm notes get --key core-service-boundary --request-id notes-get
```

最关键的是：`caller`（`{ runtimeId, agentId, profile, binding? }`）由宿主 Service Bridge 根据容器专属的 bearer 令牌反查注入，任何 Agent 都无法伪造他人身份。

---

## 4. Runtime 与 Sandbox —— 隔离的集群执行舞台

**Runtime** 统一负责容器创建、并发槽位（`maxAgents`）、输入投递、事件流、受控文件操作与安全清理。其核心控制面非常精简：

```ts
// 1. 启动 Agent（初始为 idle，不会自动触发模型推理）
const reader = await runtime.spawn({
  requestId: 'spawn-reader',
  profile: 'reader',
  files: { 'review-input.json': { encoding: 'utf8', data: serializedFact } },
});

// 2. 订阅实时生命周期事件（output, settled, error, exit）
const unsubscribe = runtime.onEvent((event) => {
  if (event.type === 'settled') {
    console.log(event.agentId, event.outcome, event.output);
  }
});

// 3. 用统一的 send() 投递任务或中途通知
await runtime.send(reader.id, 'Fetch the shared note and write review.md.', {
  requestId: 'reader-turn-1',
  mode: 'followUp',
});

// 4. 停止单个 Agent（先归档会话与 collect 文件，再销毁容器）
const stopReceipt = await runtime.stop(reader.id, { timeoutMs: 30_000 });

// 5. 关闭整次 Run 并刷盘所有追踪日志
unsubscribe();
await runtime.close({ timeoutMs: 30_000 });
```

> **关于 `send`、`start` 与 `steer`**：`runtime.start()` 和 `runtime.steer()` 只是 `runtime.send()` 的便捷别名（分别对应 `mode: 'followUp'` 和 `mode: 'steer'`，默认均唤醒空闲 Agent）。新建 Harness 时建议统一使用 `runtime.send()`，因为只有它支持非唤醒条件投递（`wakeIfIdle: false`）。

每个 Sandbox 默认提供三项安全保障：
- **默认私有、按需共享的文件系统**：每个 Agent 拥有带字节与 inode 配额的私有工作目录；只有显式传入 `workspace: { id, mode: 'read-write' | 'read-only' }` 时才会挂载共享工作区。
- **默认拒绝的网络防火墙**：容器只能访问宿主 Service Bridge、Model Gateway 及 `Profile.network.allow` 中列出的明确 IPv4 来源。
- **先归档再销毁**：`stop()` 先终止 Pi 进程冻结磁盘，再导出原生会话与 `collect` 文件，确认落盘后才删除容器。

---

## 5. Run —— 面向排障与评测的持久化归档

每次调用 `createRuntime()` 都会分配唯一的 `runtime.id` 并创建私有目录 `outputDir/<runtimeId>/`。

无需在 Harness 中手写任何埋点代码，每次 Run 自动保存：
- `runtime.json` —— 有效配置快照、提示词摘要、停止回执与清理状态；
- `evidence.jsonl` —— 有序的宿主观测时间线（spawn、输入、回执、事件、错误）；
- `service-calls.jsonl` —— 每次经过鉴权的 Service 完整入参、出参与错误；
- `model-trace/<attemptId>/` —— 原始接收/转发 JSON、上游 SSE 流与用量状态；
- `<agentId>/session/` 与 `<agentId>/artifacts/` —— 原生 Pi JSONL 会话日志与导出产物。

---

## 串起来看一个完整最小 Harness

把上面的模块拼在一起，就是一个完整可运行的多智能体 Harness（节选自 [examples/notes/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/notes/main.ts)）：

```ts
import { createRuntime } from '@murm/core';
import { createPiOpenSandboxBackend } from '@murm/core/backends/pi-opensandbox';
import { runInput } from './run-input.js';

const { services } = createNotesService();

const runtime = await createRuntime({
  backend: createPiOpenSandboxBackend(config.backend),
  services,
  profiles,
  maxAgents: 2,
  outputDir: './notes-runs',
});

try {
  const writer = await runtime.spawn({
    requestId: 'writer',
    profile: 'writer',
    files: seedFiles,
  });
  await runInput(runtime, writer.id, 'Publish the seeded note with swarm notes put.', {
    requestId: 'writer-turn-1',
    timeoutMs: 30_000,
  });

  const reader = await runtime.spawn({
    requestId: 'reader',
    profile: 'reader',
    files: readerSeedFiles,
  });
  await runInput(runtime, reader.id, 'Read the note via swarm notes get and write review.md.', {
    requestId: 'reader-turn-1',
    timeoutMs: 30_000,
  });
  await runInput(runtime, reader.id, 'Copy review.md unchanged to followup.md.', {
    requestId: 'reader-turn-2',
    timeoutMs: 30_000,
  });
} finally {
  await runtime.close({ timeoutMs: 30_000 });
}
```

## 概念与代码映射

| 概念 | `@murm/core` 符号 / 目录 | 职责 |
| --- | --- | --- |
| **Harness** | 你的代码（`src/harnesses/`、`examples/`） | 控制循环、角色 Profile、Service 定义与业务验收 |
| **Runtime** | `createRuntime`、`Runtime` | 生命周期、输入投递、文件控制与安全清理的宿主控制面 |
| **Agent** | `AgentInfo`、`AgentStatus`、`AgentEvent` | 容器内具备持久化会话与受限工作目录的执行单元 |
| **Sandbox** | `createPiOpenSandboxBackend` + Worker | 文件系统、网络与进程级的 Docker 隔离边界 |
| **Service** | `ServiceRegistry`、`ServiceManifest`、`ServiceAdapter` | 经 Schema 校验、通过 `swarm` CLI 调用的可定制共享操作 |
| **Run** | `runtime.id` + `outputDir/<runtimeId>/` | 一次具体运行及其完整的追踪与产物归档 |

接下来阅读 [系统架构与边界](../architecture/)，深入了解宿主机与沙箱之间的安全边界与请求链路。
