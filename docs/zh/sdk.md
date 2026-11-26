---
title: 使用 TypeScript SDK
description: 安装当前包，跑通完整的双 Agent 交接，再通过公开 Runtime、Service 和 OpenSandbox 接口构建自己的协作方式。
section: 构建
order: 5
---

当你希望由自己的程序决定 Agent 怎样协作时，就可以使用 SDK：谁接收输入、共享哪些状态、什么时候启动另一个 Agent，以及什么结果才算完成。这个程序就是 **Harness**。Runtime 提供 Agent 执行、Service 接入、状态观察与资源收尾，Harness 决定具体的协作机制。

本篇从仓库中的 [Messages 交接示例](https://github.com/LuNa-shi/murm/tree/main/examples/bridge-services) 开始。它在两个独立沙箱中运行 Agent，通过 Service 传递一段内容，检查导出的结果，再保存最终报告。完整 TypeScript 源码随包提供，也参与仓库构建时的编译检查。

## 安装当前版本

当前包名是 `@murm/core`，版本为 `0.2.0`，清单中仍有 `private: true`。这里采用从可访问的源码检出构建 tarball，再安装到外部项目的方式。

使用 Node.js 22.19 或更新版本，在仓库根目录运行：

```sh
npm ci
npm pack
```

`npm pack` 会先构建项目，再生成 `murm-core-0.2.0.tgz`。进入另一个项目目录安装该文件，并复制维护中的示例：

```sh
mkdir my-harness
cd my-harness
npm init -y
npm pkg set type=module
npm install --save-exact /absolute/path/to/murm-core-0.2.0.tgz
npm install -D typescript @types/node
cp node_modules/@murm/core/examples/bridge-services/{handoff.ts,handoff-config.ts,messages.ts,tsconfig.handoff.json} .
```

复制后的示例只从包的公共入口导入 SDK。它可以直接运行，不需要先执行 `murm init`，也不依赖仓库内部的 `src/` 相对路径。

运行期间可通过[管理 API](reference/api.md#runtime-管理)扩展 Profile 和 Service 目录，并调整 Agent 的 Service 权限。

## 跑通一次完整交接

先按[快速上手的执行环境准备步骤](./quickstart.md#1-准备代码与执行环境)准备 Linux、Docker、OpenSandbox，以及包含 `jq` 的兼容 murm Worker 镜像。宿主需要访问 Lifecycle API 与 Worker 端点，沙箱需要访问宿主的 Bridge 和 Model Gateway。

配置镜像及完整的 OpenAI Responses 兼容模型端点：

```sh
export MURM_SDK_IMAGE='your-worker-image'
export MURM_SDK_MODEL_URL='https://your-model-endpoint/v1/responses'
export MURM_SDK_MODEL_TOKEN='your-token-if-required'

npx tsc --project tsconfig.handoff.json
node build/handoff.js
```

示例默认使用 Pi 和 `kimi_proxy/k3` 模型组合。使用 Codex 时，设置 `MURM_SDK_EXECUTOR=codex`，并通过 `MURM_SDK_MODEL_ID` 指定模型；其默认 provider 为 `openai`。两种执行器都可显式设置 `MURM_SDK_MODEL_PROVIDER` 与 `MURM_SDK_MODEL_ID`，Worker 镜像需要包含对应的受支持执行器。

同机部署默认使用 `http://127.0.0.1:8080/v1` 访问 Lifecycle API，通过 `127.0.0.1` 访问 Worker 端点，并把 `172.17.0.1` 作为沙箱可见的宿主地址。分别用 `MURM_SDK_LIFECYCLE_URL`、`MURM_SDK_ENDPOINT_HOST` 和 `MURM_SDK_ADVERTISE_HOST` 覆盖；Lifecycle API 需要密钥时设置 `MURM_SDK_LIFECYCLE_TOKEN`。[示例 README](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/README.md)还说明了怎样连接外部 Messages Service。

程序按以下顺序运行：

1. 注册 `messages`，为 writer 与 reader 创建两个 Profile：writer 只能 `put`，reader 只能 `get`。
2. 在创建或启动 Agent 前打开观察订阅。
3. 把随机内容放进 writer 的私有目录，发送发布请求。
4. 用 operation ID 确认对应 Service 操作成功，同时观察 writer 的执行收束。
5. 启动 reader，让它读取该内容并写入自己目录中的 `received.txt`。
6. 结束 Runtime，导出 reader 文件，将其字节与最初内容比较，然后保存报告。

stderr 输出事件类型，stdout 输出 JSON 结果。报告默认保存在 `handoff-runs/<runtime-id>/handoff-report.json`，可用 `MURM_SDK_OUTPUT` 修改根目录。应一起检查 `business`、`artifactVerification`、`coreClose` 和 `reportSaveFailure`。交接失败、产物未验证、Core 清理未完成或报告保存失败时，示例都会以非零状态退出。

在源码检出中，运行 `npm run build`，再运行 `node dist/examples/bridge-services/handoff.js`，执行的也是同一份实现。[快速开始](./quickstart.md)介绍这条路径。

## 公共导入入口

所有公开的值和类型从 `@murm/core` 导入。六个运行时导出为 `createSandbox`, `createRuntime`, `getExecutorCapabilities`, `ServiceRegistry`, `createInProcessAdapter`, `createHttpJsonAdapter`。迁移时，将 Sandbox 的部署参数传给 `createSandbox`，将执行器、模型和宿主连接配置交给 Runtime。Capabilities 查询只需执行器名，返回静态能力。

## 装配 Harness 所需的 Runtime

```ts
import { createRuntime, createSandbox, ServiceRegistry } from '@murm/core';

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: 'http://127.0.0.1:8080/v1',
    isolation: { disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }),
  connection: { advertiseHost: '172.17.0.1' },
  models: {
    default: { provider: 'kimi_proxy', model: 'k3', upstream: { url: modelUrl, headers: modelHeaders } },
  },
  services: new ServiceRegistry(),
  profiles: { reader: { model: 'default', image, writable: false, services: {} } },
  maxAgents: 2,
  outputDir,
});
```

`modelUrl` 和 `modelHeaders` 由宿主提供，模型端点使用 `/v1/responses`。OpenSandbox 和 Pi 分别是 Sandbox 和执行器的默认值。Runtime 装配时冻结 Profiles、模型与 Service 注册，开启宿主端点。Agent 的 Sandbox 在 `spawn` 时分配。同一个 Sandbox 配置句柄可用于创建多个独立的 Runtime。

## 投递输入与判断完成

交接程序创建 writer 并预置输入文件后，按下面的方式提交发布请求：

```ts
const receipt = await runtime.send(
  writer.id,
  `Publish ${key}: run swarm messages put --input handoff-input.json --request-id ${key}-put, then finish.`,
  { requestId: `input-${key}-put`, mode: 'followUp' },
);
```

`send` 返回的是**输入受理回执**。`accepted` 表示执行器接受了输入，`started`、`queued` 和 `handled` 描述受理方式。它不能证明任务或 Service 写入成功。执行收束是另一项观察，业务是否完成则由 Harness 根据所需证据判断。

使用默认的 `mode: 'steer'` 引导正在进行的工作，或用 `followUp` 将输入排在当前执行之后。`wakeIfIdle` 默认是 `true`；设为 `false` 时可能收到明确的 `not-accepted` / `idle`。执行器能力决定可选的 steering mode：Pi 支持 `all` 和 `one-at-a-time`，Codex 支持显式的 `all`。

为每次提交保留 Agent ID、request ID、文本和选项。回执为 `unknown` 时，重复完全相同的调用来核对原提交；同一 request ID 下改变参数会冲突。应用超时或取消只结束自己的等待，不能证明已经提交的输入被取消。需要这一生命周期操作时，应调用 `interrupt` 或 `stop`。

交接示例能够等待单个 Agent 的收束，是因为它独占该 Agent 的输入，并额外核对对应 Service 操作和导出文件。通用的多输入源 Harness 必须自己维护任务与结果身份：原生执行边界只标记该 Agent 的当前执行。

## 在投递前订阅事件

```ts
const unsubscribe = runtime.onEvent(event => {
  if (event.type === 'output') process.stdout.write(event.text);
  if (event.type === 'runtimeChanged') console.log(runtime.state);
});
try {
  const agents = await runtime.list();
  // Dispatch work while the listener is active.
} finally {
  unsubscribe();
}
```

在 `spawn` 或 `send` 前调用 `onEvent`，再用 `get/list` 与 `runtime.state` 读取目前状态。 `output` 是助手内容，`settled` 是执行收束，`agentChanged` 和 `runtimeChanged` 提示重新查询。快速执行可以在 `send` 回执之前发出事件。Service 结果来自自己的 adapter、业务记录或产物。多个输入来源共享 Agent 时，应用需要自己的任务回执。

## 收尾时分别检查各项结果

先停止派发，再调用 `runtime.close({ timeoutMs })`。从 `receipt.agents` 找到 reader 的导出目录，核对 `received.txt` 的字节。必需导出失败时保留 Sandbox；修复后在原 Runtime 上重试。已有 HTTP Service 由原所有者管理。

交接示例把业务结果、产物校验、`coreClose` 和报告写入结果分别写入 `handoff-report.json`。

## 扩展协作机制

Agent 需要共享任务池、信箱、成果库或检查器时，可以把它实现为 Service。[构建自己的 Harness](./build-your-harness.md)提供完整 manifest 与 adapter 示例。进程内 adapter 在宿主进程执行，HTTP JSON adapter 连接已有服务。Service 可以部署在独立容器或外部应用中；将它注册到 Runtime，不会转移该部署的所有权。

父 Agent 负责创建子 Agent 时，授予内置 `agent` Service 操作并声明 `spawnProfiles`；同级协作时，通过自定义 Service 与宿主策略组织输入和成果流转；任务认领时，把业务所有权与受信文件交接接口衔接起来。[Harness 目录](./harnesses/index.md)说明 TaskPool、PeerMesh、Subagents、Substrate 与 Lead-Worker 如何用相同原语实现不同机制。

需要精确参数和恢复行为时，查阅 [API 参考](./reference/api.md)；需要公共声明时，查阅[类型定义](./reference/types.md)；需要理解资源所有权与关闭顺序时，阅读[一次运行的完整脉络](./run-lifecycle.md)。
