---
title: 构建你自己的 Harness
description: 基于 @murm/core 从零组装自定义多智能体 Harness：共享 Services、冻结角色 Profile、宿主控制循环与高可靠收尾。
section: 基于 MURM 构建
order: 5
---

在 `murm` 中构建一套全新的多智能体系统，本质上就是针对 `@murm/core` 编写一个宿主机 TypeScript 程序。你不需要修改 Runtime、不需要重做 Worker 镜像，也不需要扩展 `swarm` CLI。

每个 Harness 都由四个部分组成：
1. **共享 Services**：定义 Agent 如何交换状态或调用领域工具；
2. **角色 Profiles**：绑定角色提示词、模型、权限白名单与产物收集策略；
3. **宿主控制循环**：决定何时 `spawn`、`send`、`interrupt` 以及何时停止；
4. **高可靠收尾**：归档交付物，同时让业务错误、清理错误与报告保存错误互不掩盖。

[Messages 交接示例](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services#run-the-typescript-handoff) 可以直接运行，也可复制到新的 TypeScript 项目。独立安装 npm 包，并准备同机 Docker、OpenSandbox、Worker 镜像和模型端点。示例通过公开入口装配，也能接入已运行的 HTTP Messages Service。

## 1. 动手前先确定三个设计决策

| 设计问题 | 常见方案 |
| --- | --- |
| **共享状态存放在哪里？** | 宿主内存 `Map`（Notes、Subagents）、本地 SQLite（Substrate、Lead-Worker）或外部 HTTP / Git / 聊天服务（PeerMesh、TaskPool） |
| **什么驱动下一轮执行？** | 固定串行轮次（`send` 与 `observe`）、事件 + 非唤醒邮箱转向（`wakeIfIdle: false`），或周期性租约协调循环 |
| **什么证明本次运行成功？** | 某条 Service 状态达标、经宿主核验的 Git 提交 / PR、验证器通过，或宿主校验过的归档文件 |

## 2. 定义并注册共享 Service

一个 Service 由声明式 **v2 Manifest**（`ServiceManifest`）和**适配器**（进程内 `createInProcessAdapter` 或外部 HTTP `createHttpJsonAdapter`）组成。

### 进程内 Service（直接写在宿主 Harness 中）

下面的示例取材自 [examples/notes/main.ts](https://github.com/LuNa-shi/murm/blob/main/examples/notes/main.ts)，完整演示了四个好习惯：严格 draft-07 Schema、信任 Bridge 注入的 `caller.agentId`、幂等重试以及在修改状态前调用 `assertAuthorized()`：

```ts
import {
  ServiceRegistry,
  createInProcessAdapter,
  type ServiceManifest,
} from '@murm/core/services';

const keyField = { type: 'string', minLength: 1, maxLength: 64 };
const textField = { type: 'string', minLength: 1, maxLength: 4096 };
const noteSchema = {
  type: 'object',
  properties: { key: keyField, text: textField, author: { type: 'string' } },
  required: ['key', 'text', 'author'],
  additionalProperties: false,
};

const notesManifest: ServiceManifest = {
  id: 'notes',
  title: 'Notes',
  purpose: 'Share verified findings between collaborating agents',
  provider_version: '1',
  contract_version: '2',
  endpoint: { transport: 'in-process' },
  capabilities: [
    {
      name: 'put',
      operation: 'put',
      description: 'Publish a note by key',
      side_effect: 'write',
      idempotent: true,
      help: { when: 'Pass a verified finding to downstream agents' },
      input_schema: {
        type: 'object',
        properties: { key: keyField, text: textField },
        required: ['key', 'text'],
        additionalProperties: false,
      },
      output_schema: noteSchema,
      errors: [{ code: 'CONFLICT', retryable: false }],
    },
    {
      name: 'get',
      operation: 'get',
      description: 'Read a published note by key',
      side_effect: 'read',
      idempotent: true,
      help: { when: 'Inspect a finding published by another agent' },
      input_schema: {
        type: 'object',
        properties: { key: keyField },
        required: ['key'],
        additionalProperties: false,
      },
      output_schema: { anyOf: [noteSchema, { type: 'null' }] },
      errors: [],
    },
  ],
};

export function createNotesService() {
  const records = new Map<string, { key: string; text: string; author: string }>();
  const services = new ServiceRegistry();

  services.registerService({
    manifest: notesManifest,
    adapter: createInProcessAdapter({
      invoke({ capability, input, caller, assertAuthorized }) {
        const req = input as { key: string; text?: string };
        const existing = records.get(req.key);
        if (capability.operation === 'get') return existing ?? null;

        if (existing) {
          if (existing.author === caller.agentId && existing.text === req.text) return existing;
          throw Object.assign(new Error('Key already exists with different content'), { code: 'CONFLICT' });
        }

        // 在提交共享状态变更前同步复核调用者权限
        assertAuthorized();
        const entry = { key: req.key, text: req.text!, author: caller.agentId };
        records.set(req.key, entry);
        return entry;
      },
      // 可选：runtime.close() 时自动导出到 service-state.notes.json
      exportState: () => [...records.values()],
    }),
  });

  return { services, records };
}
```

### 外部 HTTP Service（`createHttpJsonAdapter`）

如果 Service 运行在独立进程中（例如 Python 验证器或已有微服务），只需把 `endpoint` 设为 `{ transport: 'http-json', url: 'http://127.0.0.1:9000' }` 并配合 `createHttpJsonAdapter` 注册：

```ts
import { createHttpJsonAdapter } from '@murm/core/services';

services.registerService({
  manifest: verifierManifest, // endpoint: { transport: 'http-json', url: 'http://127.0.0.1:9000' }
  adapter: createHttpJsonAdapter({
    token: process.env.VERIFIER_HOST_TOKEN, // 留在宿主机并自动从日志脱敏
    timeoutMs: 60_000,
  }),
});
```

Core 会携带 `Idempotency-Key: <operation_id>` 请求头向 `endpoint.url + (capability.path ?? '/v2/' + capability.operation)` 发送 POST `{ input, envelope, caller }`，并校验 `{ "ok": true, "result": <output> }`（响应上限 2 MiB，禁用重定向）。容器内的 `swarm` 调用方式完全不变。

> **CLI 参数解析提示**：`swarm` 会自动把形如 JSON 对象或数组的命令行参数解析为对象（如 `--foo '{"a":1}'`）。如果你的 Schema 要求字段保持纯 `string`（例如 `examples/notes`），请通过 `--input request.json` 或 `--stdin` 传递 JSON 文件。

## 3. 配置冻结的角色 Profiles

Profile 把角色说明（`prompt`）与运行时硬权限（`services`、`writable`、`network`、`collect`）成对绑定：

```ts
import type { Profile } from '@murm/core';

const profiles: Record<string, Profile> = {
  writer: {
    prompt: 'Inspect review-input.json and publish your finding via `swarm notes put`.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['put'] },
  },
  reader: {
    prompt: 'Verify findings with `swarm notes get` and write a concise summary to review.md.',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['get'] },
    collect: {
      paths: ['review.md'],
      includeGit: false,
      maxBytes: 256 * 1024,
      required: true,
    },
  },
};
```

按需可为角色开启的常见能力：
- **内置子 Agent 控制**：授予 `{ agent: ['spawn', 'get', 'send', 'stop'] }`，通过 `spawnProfiles: ['worker']` 限定允许派生的角色。后端声明支持 `contextFork` 时，可以设置 `allowContextFork: true` 开启会话分叉。（也可以像 [Subagents](../harnesses/subagents/) 那样封装成专属领域 Service。）
- **多 Agent 共享仓库**：在 `runtime.spawn()` 中传入 `workspace: { id: 'shared-repo', mode: 'read-write' }`（或 `'read-only'`）。
- **访问内部设施（如 Gitea）**：在 `Profile.network: { allow: ['http://172.17.0.1:3000'] }` 中放行具体非回环 IPv4 来源，并通过 `spawn({ secretEnv })` 注入隔离令牌。

## 4. 编写宿主控制循环

每次 Run 装配一次 Runtime。从源码构建时，可用 `config.backend.executor` 选择 `pi` 或 `codex`，省略时默认使用 Pi。

```ts
import { createRuntime } from '@murm/core';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';

const runtime = await createRuntime({
  backend: createOpenSandboxBackend(config.backend),
  services,
  profiles,
  maxAgents: 4,
  outputDir: './runs',
});
```

根据你的协作拓扑选择对应的控制循环模式：

### 模式 A：用公开输入和观察组织串行轮次

当应用独占某个 Agent 的输入时，先建立 `runtime.observe({ signal })`，再调用 `runtime.send`。保留原始请求 ID 并核对接纳回执。[Messages 交接示例](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services#run-the-typescript-handoff) 同时消费观察更新，等待预期 Service 操作和该 Agent 执行收束，再在收尾中检查导出产物的字节。业务验收依据是实际操作身份和文件检查。游标缺口及输入结果未知的处理见 [Runtime 控制](../reference/api/#实时观察)。

### 模式 B：事件监听 + 非唤醒邮箱

适合动态委派、实时群聊或交互式转向——消息到达时目标可能正在运行也可能已经空闲。先尝试 `mode: 'steer', wakeIfIdle: false`，仅在确认对方空闲时暂存邮箱：

```ts
runtime.onEvent((event) => {
  if (event.type !== 'settled' || event.outcome === 'aborted') return;
  const payload = JSON.stringify({
    from: event.agentId,
    outcome: event.outcome,
    output: event.output ?? '',
  });

  void runtime
    .send(parentId, payload, {
      requestId: `child-result:${event.agentId}:${event.seq}`,
      source: event.agentId,
      mode: 'steer',
      wakeIfIdle: false,
    })
    .then((receipt) => {
      if (receipt.status === 'not-accepted') enqueueMailbox(parentId, payload);
      if (receipt.status === 'unknown') recordUnknownDelivery(event, payload);
    })
    .catch(recordDeliveryError);
});
```

### 模式 C：周期性协调循环（Reconciliation Loop）

适合长时任务池，需要处理 Worker 停滞、租约过期与槽位补位：
- 以领域数据库作为唯一权威状态；
- 在 `settled` 回调中检查该 Agent 的业务 Execution：仍在 `RUNNING` 则发 `mode: 'followUp'` 续跑，已 `CLOSING` 则 `runtime.stop()` 并在释放的槽位上启动新 Worker；
- 用有界的 `setInterval` 心跳定期续约、回收超时 Worker 并补满并发槽位；
- 可选向 `createRuntime()` 传入 `modelAccessPolicy`，让 Model Gateway 在租约失效时立刻截断流式推理。

完整生产实现可参考 [TaskPool](../harnesses/taskpool/)。

## 5. 通过 `finalizeRun()` 收尾

从 `@murm/core` 调用 `finalizeRun`，传入带类型的业务结果，并单独设置清理期限。通过 `verifyArtifacts` 检查所需的导出产物，仅为应用拥有的资源传入 `ownedFacilities`。报告在 `outputDir/<runtimeId>/run-finalization.json` 分别记录业务、验证、Core 关闭、设施清理和保存状态。保留待清理资源的身份，便于后续核对。

## 6. 校验你的第一次 Run

首次运行结束后，在 `outputDir/<runtimeId>/` 中核对应用需要的证据。

1. **`runtime.json`**：`status === 'closed'` 且 `cleanup === 'complete'`，无挂起清理项；
2. **`evidence.jsonl`**：Agent 创建顺序、输入回执与 `settled` 事件符合预期，零 `subscriber-error`；
3. **`service-calls.jsonl`**：下游 Agent 确实用合法参数调用了你的 Services 并读取到了上游数据；
4. **`<agentId>/artifacts/files/` 与 `<agentId>/session/`**：声明的交付物通过验收检查，并可查看当前执行器的原生会话记录。

接下来可以在 [五种协作拓扑总览](../harnesses/) 中查看内置 Harness 如何运用这些模式。
