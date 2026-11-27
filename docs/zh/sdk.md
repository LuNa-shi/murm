---
title: 使用 TypeScript SDK
description: 安装 @luna-shi/murm，通过公开 Runtime、Service 和 OpenSandbox 接口构建你自己的多智能体协作机制。
section: 构建
order: 5
---

当你希望由自己的程序决定 Agent 怎样协作时，就可以使用 SDK：谁接收输入、共享哪些状态、什么时候启动另一个 Agent，以及什么结果才算完成。这个程序就是 **Harness**。Runtime 提供 Agent 执行、Service 接入、状态观察与资源收尾，Harness 决定具体的协作机制。

如果想直接用 CLI 在现有项目上运行内置 Harness，请先看[快速上手](./quickstart.md)或[选择 Harness](harnesses/index.md)。本篇深入说明如何在自己的项目中嵌入 `@luna-shi/murm`。

## 安装 SDK

在 Node.js 22.19+ 项目中安装指定版本的 GitHub Release 附件。

```sh
npm install --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

在 npm 12 下从锁文件重新安装此依赖时，使用 `npm ci --allow-remote=root`。

在 Linux 上运行前，按[快速上手](./quickstart.md#2-连接或部署-opensandbox)连接已有 OpenSandbox 或引导本地部署，并使用 `murm doctor --smoke` 检查 Worker 和回连。

运行期间还可通过[管理 API](reference/api.md#runtime-管理)动态扩展 Profile 和 Service 目录，并调整 Agent 的 Service 权限。

## 公共导入入口

所有公开值和类型统一从 `@luna-shi/murm` 导入。七个运行时导出为：

- `createSandbox`：配置 OpenSandbox 生命周期与磁盘/网络隔离边界
- `createRuntime`：创建并管理 Runtime、Agent 生命周期、文件控制与清理
- `DEFAULT_WORKER_IMAGE`：与当前包版本对应的官方 Worker 镜像引用（`ghcr.io/luna-shi/murm-worker:0.2.0`）
- `getExecutorCapabilities`：静态查询执行器（`pi` / `codex`）能力，无网络副作用
- `ServiceRegistry`、`createInProcessAdapter`、`createHttpJsonAdapter`：注册进程内或外部 HTTP JSON v2 Service

## 创建 Harness 所需的 Runtime

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createRuntime,
  createSandbox,
} from '@luna-shi/murm';

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
  }),
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      upstream: {
        url: process.env.MURM_MODEL_URL!,
        headers: process.env.MURM_MODEL_TOKEN
          ? { authorization: `Bearer ${process.env.MURM_MODEL_TOKEN}` }
          : {},
      },
    },
  },
  services: new ServiceRegistry(),
  profiles: {
    reader: {
      model: 'default',
      image: process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE,
      writable: false,
      services: {},
    },
  },
  maxAgents: 2,
  outputDir: './runs',
});
```

- **模型路由**：`upstream.url` 需指向支持流式输出的 OpenAI Responses 兼容端点（以 `/v1/responses` 结尾）。默认执行器为 Pi，支持内置 `openai` / `kimi_proxy` / `gpt_proxy` 目录以及任意自定义 `provider` + `model` 组合（宿主会自动生成并校验对应 Pi 模型目录）。切换 Codex 时传入 `executor: 'codex'`。
- **Worker 镜像**：默认直接传入 `DEFAULT_WORKER_IMAGE`；只有当你自定义了沙箱工具链镜像时才需替换。
- **隔离与凭据**：上游模型凭据仅保存在宿主 Model Gateway 中，绝不会进入容器。同一个 `createSandbox` 句柄可以配置多个独立拥有的 Runtime。

## 完整双 Agent 交接示例

仓库中的 [Messages 交接示例](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services) 展示了更完整的生产级收尾模式（带操作 ID 校验、导出文件字节比对和外部 HTTP Service 接入）：

1. 注册 `messages`，为 `writer` 与 `reader` 创建两个 Profile：`writer` 只能 `put`，`reader` 只能 `get`。
2. 在创建或启动 Agent 前通过 `runtime.onEvent` 打开观察订阅。
3. 把随机内容放进 `writer` 的私有目录，发送发布请求。
4. 用 operation ID 确认对应 Service 操作成功，同时观察 `writer` 的执行收束。
5. 启动 `reader`，让它读取该内容并写入自己目录中的 `received.txt`。
6. 结束 Runtime，导出 `reader` 文件，将其字节与最初内容比较，然后保存 `handoff-report.json`。

安装 CLI 后可以直接在任意目录运行该内置 Harness：

```sh
murm --harness messages --prompt "检查当前项目并传递一份验证摘要"
```

## 提交输入并判断工作何时完成

在 spawn `writer` 并放入初始文件后，可以向它提交输入：

```ts
const receipt = await runtime.send(
  writer.id,
  `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`,
  { requestId: `input-${key}-put`, mode: 'followUp' },
);
```

`send` 返回**接纳回执（admission receipt）**。`accepted` 表示执行器已经接受输入；`started`、`queued` 和 `handled` 说明接纳方式。它不证明任务或 Service 写入已经成功。执行收束（`settled`）是另一条观察，而业务完成应由 Harness 根据所需证据自行判定。

默认 `mode: 'steer'` 用于引导正在进行的工作；`followUp` 用于把输入排在当前执行之后。`wakeIfIdle` 默认为 `true`；设为 `false` 时，如果 Agent 空闲会明确返回 `not-accepted` / `idle`。Pi 支持 `all` 与 `one-at-a-time` steering 模式；Codex 支持显式 `all`。

请保留每次提交的 Agent ID、request ID、文本和选项。若回执为 `unknown`，用完全相同的参数和 request ID 重试对账；复用同一 request ID 但修改参数会产生 `CONFLICT`。应用侧超时或取消只结束等待，不证明已提交的输入被取消——需调用 `interrupt` 或 `stop` 执行生命周期动作。

## 先订阅，再派发工作

```ts
const unsubscribe = runtime.onEvent(event => {
  if (event.type === 'output') process.stdout.write(event.text);
  if (event.type === 'runtimeChanged') console.log(runtime.state);
});
try {
  const agents = await runtime.list();
  // 在订阅生效期间派发任务
} finally {
  unsubscribe();
}
```

务必在 `spawn` 或 `send` 之前注册 `onEvent`，再用 `get/list` 和 `runtime.state` 读取当前视图。`output` 包含助手文本，`settled` 表示执行器完成一次执行边界，`agentChanged` 和 `runtimeChanged` 提示宿主刷新状态。事件可能在回执返回前到达。

## 关闭并检查结果

停止派发新工作后调用 `runtime.close({ timeoutMs })`。从 `receipt.agents` 中读取每个 Agent 的导出目录并核对产物。如果必需的产物导出失败，Sandbox 会被保留以便恢复；解决阻塞后在原 Runtime 上重试 `close()` 即可。外部 HTTP Service 保持其原有生命周期，不由 Runtime 关闭。

## 扩展协作机制

当 Agent 需要共享任务池、邮箱、成果库、检查器或其他状态时，注册自定义 Service。[构建你自己的 Harness](./build-your-harness.md) 展示了完整的 Manifest 和 Adapter 写法。进程内 Adapter 运行在宿主进程中；HTTP JSON Adapter 可接入已部署的外部服务。

- 父控派发子 Agent：在 `Profile.services.agent` 授予内置操作并声明 `spawnProfiles`。
- 对等协作：通过自定义 Service 和宿主策略转发消息、分支或成果。
- 独占任务认领：结合领域租约与受控文件 API（`runtime.files`）。

继续查阅 [API 与配置参考](./reference/api.md)、[类型定义与源码映射](./reference/types.md) 以及 [Run 生命周期](./run-lifecycle.md)。

## 接入自定义 Sandbox Provider

`createSandbox({ provider, timeoutSeconds })` 接收由可信宿主加载的 `SandboxProvider`。实现从包根入口导入接口，声明稳定的 ID、版本与能力，提供就绪检查，并为给定镜像交付 `SandboxManager`，处理分配、Worker 通信、快照、导出、停止与删除。创建或删除回执丢失时，使用原资源键核对。执行器、模型、Profile 和 Service 仍由 Runtime 配置。

项目可通过 `resolveSandboxConnection` 使用 CLI 的解析逻辑。显式字段优先，其次是通用 `MURM_*`、当前示例的别名和上游兼容变量。返回值可能带 Lifecycle 密钥，请仅在可信宿主配置中使用。
