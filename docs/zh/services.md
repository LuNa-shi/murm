---
title: Services 与权限
description: 理解为什么用宿主机 Service 而不是本地 Tools 做多智能体协作，学会把自己的业务类或外部 HTTP 服务接入 murm，并管理静态与动态权限。
section: 核心构件与实战
order: 7
---

在 `murm` 里，**Service** 是多个隔离沙箱之间共享状态和协作的核心方式。无论你想要一块共享笔记黑板、一个任务池、一个 Git 协作服务，还是外部的形式化验证器，都是把它注册成 Service，再让容器内的 Agent 用统一的 `swarm` CLI 调用。

## 1. 为什么不用 Agent 自己的 Tools 直接做协作？

每个 Agent 运行在隔离沙箱里，它自带的本地 Tools（`read`、`write`、`edit`、`bash`）只适合处理**自己工作区内的事**，但并不适合跨 Agent 协作：

- **无法安全共享状态**：每个容器文件系统互相隔离，本地 Tool 碰不到其他 Agent 的状态；如果直接挂载共享目录或塞进数据库密码，又会破坏隔离边界。
- **无法防身份冒充**：如果让 Agent 在工具入参里自己填“我是谁”，模型出错或被注入时可能冒充队友写入数据。
- **缺少统一审计**：宿主机 Service 经由 [Host Gateway](gateway.md) 统一鉴权、校验参数并记录到 `service-calls.jsonl`，能直接在 [Trace Viewer](trace-viewer.md) 里画出跨 Agent 协作交接。

因此，在 `murm` 中，**本地 Tools 负责单兵作业，宿主机 Service 负责团队协作**。

## 2. 接入宿主机进程内 Service（先写业务类，再做薄注册）

如果你用 TypeScript 写共享协作逻辑，**不要把业务代码全塞进适配器回调函数里**。推荐拆成两步：先写一个普通的业务类，再用薄薄一层注册接进 `murm`。

### 第 1 步：用普通 TypeScript 写你自己的业务类

```ts
// board.ts —— 普通的业务类，不依赖任何 murm 内部接口
export interface Finding {
  id: number;
  authorId: string;
  topic: string;
  summary: string;
}

export class FindingsBoard {
  private entries: Finding[] = [];

  // 发布一条新发现（由宿主传入经过鉴权的真实 authorId）
  publish(authorId: string, topic: string, summary: string): Finding {
    const entry = { id: this.entries.length + 1, authorId, topic, summary };
    this.entries.push(entry);
    return entry;
  }

  // 按关键词检索队友已发布的发现
  search(query: string): Finding[] {
    const q = query.trim().toLowerCase();
    return q
      ? this.entries.filter((e) => `${e.topic} ${e.summary}`.toLowerCase().includes(q))
      : [...this.entries];
  }

  // 可选：在 runtime.close() 时导出最终快照供复盘
  exportState() {
    return { total: this.entries.length, entries: this.entries };
  }
}
```

### 第 2 步：注册成 murm Service（薄薄一层分发）

注册时只需要两部分：**Manifest**（向 Agent 声明有哪些操作及参数格式）和 **Adapter**（把操作名分发到你的类方法）：

```ts
import { ServiceRegistry, createInProcessAdapter, type JsonValue } from '@luna-shi/murm';
import { FindingsBoard } from './board.js';

const board = new FindingsBoard();
const services = new ServiceRegistry();

services.registerService({
  manifest: {
    contract_version: '2', // 协议固定常量
    id: 'board', // 唯一服务名（'agent' 为内置保留名）
    title: 'Shared Findings Board',
    purpose: '让团队成员发布与检索调研发现。',
    provider_version: '1.0.0',
    endpoint: { transport: 'in-process' },
    capabilities: [
      {
        name: 'publish',
        operation: 'publish',
        description: '发布一条经过验证的新发现。',
        side_effect: 'write',
        idempotent: false,
        help: { when: '有新结论需要分享给队友时' },
        errors: [],
        input_schema: { /* 定义 topic、summary 字段，完整 Schema 见下方折叠示例 */ },
        output_schema: { /* 定义返回值格式 */ },
      },
      {
        name: 'search',
        operation: 'search',
        description: '检索团队已发布的发现。',
        side_effect: 'read',
        idempotent: true,
        help: { when: '查看其他成员的进展以避免重复劳动' },
        errors: [],
        input_schema: { /* 定义 query 字段 */ },
        output_schema: { /* 定义返回数组格式 */ },
      },
    ],
  },
  adapter: createInProcessAdapter({
    invoke({ capability, input, caller, assertAuthorized }): JsonValue {
      if (capability.operation === 'publish') {
        // 写入共享状态前复核一次调用者权限，防止已被停止或撤销权限的 Agent 落盘
        assertAuthorized();
        const { topic, summary } = input as { topic: string; summary: string };
        return board.publish(caller.agentId, topic, summary);
      }
      const { query = '' } = input as { query?: string };
      return { entries: board.search(query) };
    },
    exportState: () => board.exportState(),
  }),
});
```

> **提示**：写适配器时请始终使用宿主注入的 `caller.agentId`（或 `caller.binding`）判断作者身份，不要信任入参中 Agent 自己填写的名字。完整字段定义与 JSON Schema 写法请查 [SDK 与 API 参考](reference/api.md) 或下一章 [Swarm 实战](build-your-harness.md)。

## 3. 接入外部 HTTP Service（复用 Python / Go / 已有后端）

如果你已经有现成的 Python、Go 或独立数据库服务，完全不需要用 TypeScript 重写：

1. **在你的后端暴露对应的 HTTP POST 接口**：
   - 每个操作对应一个路径（默认 `/v2/<operation>`，也可在 capability 的 `path` 字段自定义）。
   - 请求体由宿主网关自动打包为 `{ "input": {...}, "envelope": {...}, "caller": { "agentId": "...", "profile": "...", "binding": ... } }`，并附带 `Authorization: Bearer <token>` 与 `Idempotency-Key` 请求头。
   - 你的后端只需先校验 Bearer Token，再按 `caller` 身份执行自己的业务逻辑，最后返回 `{ "ok": true, "result": <json> }` 即可。
2. **在宿主机用几行代码挂进 `ServiceRegistry`**：

```ts
import { createHttpJsonAdapter } from '@luna-shi/murm';

services.registerService({
  manifest: {
    contract_version: '2',
    id: 'math-judge',
    title: 'Lean Verifier',
    purpose: '校验候选证明并更新数学状态。',
    provider_version: '1.0.0',
    endpoint: { transport: 'http-json', url: 'http://127.0.0.1:9000' },
    capabilities: [/* 声明操作名与输入输出 Schema */],
  },
  adapter: createHttpJsonAdapter({ token: process.env.JUDGE_SERVICE_TOKEN }),
});
```

> 外部 HTTP 服务的启动与关闭仍由你的应用自行管理，宿主机只会转发调用并在发生错误或超时时做好审计记录。

## 4. 两类 Service 生命周期与权限控制

`murm` 同时支持**运行前预注册**和**运行中动态管理**两类方式，你可以按团队复杂度灵活组合：

### 方式 A：启动前预注册 + 角色白名单（最常用）

- 在调用 `createRuntime()` 之前，把所有共享 Services 注册到 `ServiceRegistry`。
- 在每个角色的 `Profile.services` 里按最小权限声明允许调用的操作——例如：
  - `researcher` 角色：`services: { board: ['publish', 'search'] }`
  - `synthesizer` 角色：`services: { board: ['search'] }`（只能读、不能改写）

### 方式 B：运行中动态增删 Service 与调整权限

如果你的系统需要在跑起来之后再动态搭建新工具或调整成员权限，`murm` 提供了一整套运行期工具：

- **宿主直接管理**：
  - `runtime.services.register(...)` / `retire(...)`：动态挂载新 Service，或平滑下线已有 Service。
  - `runtime.access.get(agentId)`：查看某个 Agent 当前拥有哪些 Service 权限。
  - `runtime.access.grant(...)` / `revoke(...)`：随时为单个活跃 Agent 新增（可附带 `binding`）或撤销权限，无需重启容器。
- **委托给指定 Agent（内置 `agent` Service）**：
  - 每个 Runtime 自动内置一个保留名为 `agent` 的系统 Service，提供子 Agent 生命周期操作（`spawn`、`get`、`send`、`stop`）以及权限管理操作（`access_get`、`grant`、`revoke`）。
  - 这些操作默认全部关闭；如果希望某个管理角色能动态帮队友授权，只需在它的 `Profile.services.agent` 中显式开放，并在 `createRuntime()` 中传入同步校验函数 `agentAccessPolicy` 把关每一次授权请求。

## 5. Agent 在沙箱里如何使用 Service

无论后端是进程内类还是外部 HTTP 服务，容器里的 Agent 看到的都是完全一致的 `swarm` CLI：

```bash
# 仅列出当前 Agent 获准调用的 Services 与参数说明
swarm service list
swarm service view board --json

# 调用任意授权操作
swarm board publish --topic cache --summary 'LRU 淘汰逻辑在高并发下存在竞态' --request-id note-1
swarm board search --query 'cache' --request-id search-1
```

因为 `swarm service list` 只展示当前身份有权限的操作，Agent 不会把上下文浪费在无权使用的工具上。

---

**下一步**：在 **[观测与调试（Trace Viewer）](trace-viewer.md)** 里直接体验真实的可缩放泳道图，看清模型调用与 Service 协作交接是如何被记录下来的。

候选包的 `swarm service invoke <service> <operation> --help` 显示类型和必填项。Schema 示例和 `SERVICE_INPUT_INVALID` 恢复流程见[交接教程](first-harness.md)。
