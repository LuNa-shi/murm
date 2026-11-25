---
title: 编写你自己的 Program
description: 从零组合 Service、Profile、Runtime 驱动循环与安全收尾，在不改动 Core 的前提下实现你自己的多智能体协作机制。
section: 开发者指南
order: 11
---

在 `murm` 中，编写一种全新的多智能体系统，本质上就是写一个调用 `@swarmenv/core` 的普通 TypeScript 程序（**Program**）。你无需改动 Runtime、Worker 镜像或 `swarm` CLI。

一个完整的 Program 由四块积木组成：**共享 Service**、**角色 Profile**、**宿主驱动循环**与**可靠收尾**。

## 1. 先回答三个设计问题

写代码前，先用三句话定清你要的协作形态：
1. **共享状态放哪里？**（宿主内存 Map、本地 SQLite、外部数据库，还是 Git + 聊天服务？）
2. **谁推动下一轮工作？**（固定步骤顺序推进、监听 `onEvent`/外部消息触发路由，还是定时对账循环？）
3. **怎样算任务完成？**（某个 Service 里的记录达标、公共文件/PR 通过校验，还是 Root 返回最终答案？）

## 2. 编写并注册共享 Service

定义一个 Service 需要两份东西：给 Agent 与 Bridge 看的 **manifest**（服务用途、操作列表、输入输出 JSON Schema），以及真正执行业务的**本地函数**（`createInProcessAdapter`）或 **HTTP 转发器**（`createHttpJsonAdapter`）。

下面是一个可直接复用的本地函数 Service 模板，包含三个生产级习惯：**信任 Core 注入的 `caller`**、**幂等去重**、以及**提交写入前复核 `assertAuthorized()`**：

```ts
import {
  ServiceRegistry,
  createInProcessAdapter,
  type ServiceManifest,
} from '@swarmenv/core/services';

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
      help: { when: 'Share a finding for downstream agents' },
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 },
          text: { type: 'string', minLength: 1, maxLength: 4096 },
        },
        required: ['key', 'text'],
        additionalProperties: false,
      },
      output_schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          text: { type: 'string' },
          author: { type: 'string' },
        },
        required: ['key', 'text', 'author'],
        additionalProperties: false,
      },
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
        properties: { key: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['key'],
        additionalProperties: false,
      },
      output_schema: { anyOf: [{ type: 'object' }, { type: 'null' }] },
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
          if (existing.author === caller.botId && existing.text === req.text) return existing;
          throw Object.assign(new Error('Key already exists with different content'), { code: 'CONFLICT' });
        }

        // 在提交关键写入前，再次确认调用者当前仍处于授权状态
        assertAuthorized();
        const entry = { key: req.key, text: req.text!, author: caller.botId };
        records.set(req.key, entry);
        return entry;
      },
      // 可选：关闭 Run 时自动把业务快照写入 service-state.notes.json
      exportState: () => [...records.values()],
    }),
  });

  return { services, records };
}
```

如果你的业务服务独立运行在另一个进程中，将 `endpoint` 改为 `{ transport: 'http-json', url: 'http://127.0.0.1:9000' }` 并使用 `createHttpJsonAdapter({ token, timeoutMs })` 即可，Agent 侧命令完全不变。

## 3. 配置角色 Profile 与权限边界

用 Profile 把“提示词引导”和“硬权限边界”配清楚：

```ts
import type { Profile } from '@swarmenv/core';

const profiles: Record<string, Profile> = {
  researcher: {
    prompt: '调研目标代码，用 `swarm notes put` 发布关键结论。',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['put'] },
  },
  reviewer: {
    prompt: '用 `swarm notes get` 核对调研结论，并将复核报告写入 review.md。',
    model: 'default',
    image: config.image,
    writable: true,
    services: { notes: ['get'] },
    collect: { paths: ['review.md'], includeGit: false, maxBytes: 256 * 1024, required: true },
  },
};
```

按需开启的常见能力：
- **允许 Agent 创建子 Agent**：在 `services` 中开放内置 `bot`（如 `{ bot: ['spawn', 'get', 'send', 'stop'] }`），并用 `spawnProfiles` 限定角色、用 `allowContextFork: true` 允许派生对话历史；或者像 [Subagents](../programs/subagents/) 一样封装自定义的高层 `collaboration` Service。
- **同 Run 多 Agent 共享项目目录**：在 `runtime.spawn()` 中传入 `workspace: { id: 'shared-repo', mode: 'read-write' }`。
- **访问外部内网服务（如 Gitea）**：在 Profile 中配置 `network: { allow: ['http://192.0.2.10:3000'] }`，并在 `spawn` 时通过 `secretEnv` 注入该 Agent 专属凭据。

## 4. 编写宿主驱动循环（三种标准范式）

装配 Runtime 后，根据协作形态任选一种驱动骨架：

```ts
import { createRuntime } from '@swarmenv/core';
import { createPiOpenSandboxBackend } from '@swarmenv/core/backends/pi-opensandbox';

const runtime = await createRuntime({
  backend: createPiOpenSandboxBackend(config.backend),
  services,
  profiles,
  maxBots: 4,
  outputDir: './runs',
});
```

### 范式 A：串行回合型（适用于固定步骤或并发独立轮次）

单输入源、每次向空闲 Agent 发一条任务并等它结束时，使用仓库共享的 [runInput](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/shared/run-input.ts)：

```ts
const researcher = await runtime.spawn({ requestId: 'spawn-1', profile: 'researcher', files: seedFiles });
await runInput(runtime, researcher.id, '分析解析器边界并发布笔记', {
  requestId: 'turn-1',
  timeoutMs: 60_000,
});
```

### 范式 B：事件与非唤醒邮箱型（适用于动态委派与实时协作）

监听 `runtime.onEvent`，子结果或同伴消息到达时先尝试 `wakeIfIdle: false` 实时注入，空闲时暂存邮箱：

```ts
runtime.onEvent((event) => {
  if (event.type !== 'settled') return;
  const payload = JSON.stringify({ from: event.botId, outcome: event.outcome, output: event.output ?? '' });
  void runtime.send(targetId, payload, {
    requestId: `deliver:${event.botId}:${event.seq}`,
    mode: 'steer',
    wakeIfIdle: false,
  }).then((receipt) => {
    if (receipt.status === 'not-accepted') enqueueMailbox(targetId, payload);
  });
});
```

### 范式 C：状态对账循环型（适用于任务池、自动续轮与失败补位）

以业务数据库为真相源：收到 `settled` 若业务任务未结束则发 `mode: 'followUp'` 续轮，并用 `setInterval` 周期续约、清理超期 Agent 并补位空闲 Slot（参考 [Flat Controller](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/flat/controller.ts)）。

## 5. 可靠收尾与可视化验证

使用 [runWithReport](https://github.com/LuNa-shi/SwarmEnv/blob/ac72c76/src/environments/shared/run-report.ts) 包装你的主流程，确保**业务失败**、**资源清理失败**与**报告保存失败**互不覆盖：

```ts
const report = await runWithReport({
  outputDir: './runs',
  closeTimeoutMs: 30_000,
  createRuntime: () => createRuntime({ ... }),
  async run(runtime) {
    // 执行驱动循环并返回业务结果
    return { delivered: true };
  },
  afterClose: async () => {
    // 确认 Core 完成容器清理后，再释放自建外部设施
    await closeExternalResources();
  },
});
```

跑完第一次测试后，执行 `npm run view -- ./runs/<runId>` 在 [Multi-Agent Trace Viewer](../../trace-viewer/) 中打开它，直接核对三件事：
1. 泳道里多只 Agent 是否按预期时机启动与并行；
2. `SERVICE` 蓝色/青色节点里上游产出是否真正被下游读取并带入后续 `ASSISTANT` / `TOOL` 动作；
3. 收尾事件显示 `cleanup: complete` 且所需文件已完整导出。
