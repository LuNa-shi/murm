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

stderr 输出游标和事件类型，stdout 输出 JSON 结果。报告默认保存在 `handoff-runs/<runtime-id>/run-finalization.json`，可用 `MURM_SDK_OUTPUT` 修改根目录。应一起检查 `business`、`artifactVerification`、`coreClose` 和 `reportSaveFailure`。交接失败、产物未验证、Core 清理未完成或报告保存失败时，示例都会以非零状态退出。

在源码检出中，运行 `npm run build`，再运行 `node dist/examples/bridge-services/handoff.js`，执行的也是同一份实现。[快速开始](./quickstart.md)介绍这条路径。

## 公共导入入口

下面是**同一个 npm 包**的不同导入路径：

| 导入路径 | 用途 |
| --- | --- |
| `@murm/core` | `createRuntime`、`finalizeRun`，以及 Runtime、Profile、观察与结果类型 |
| `@murm/core/services` | `ServiceRegistry`、进程内与 HTTP JSON adapter、Service 契约和校验辅助接口 |
| `@murm/core/backends/opensandbox` | `createOpenSandboxBackend`、执行器能力查询与后端配置 |
| `@murm/core/backends/pi-opensandbox` | 已弃用的 Pi 专用便捷工厂；改用通用 OpenSandbox 入口 |

新 Harness 通常使用前三个入口。后端句柄是不透明对象，只归属一个 Runtime；新建另一场 Run 时，应重新创建句柄。

## 装配 Harness 所需的 Runtime

下面摘出交接示例的装配部分。`handoffConfig` 和 `createMessageService` 就来自前面复制的文件：

```ts
import { createRuntime } from '@murm/core';
import { createOpenSandboxBackend } from '@murm/core/backends/opensandbox';
import { ServiceRegistry } from '@murm/core/services';
import { handoffConfig } from './handoff-config.js';
import { createMessageService } from './messages.js';

const config = handoffConfig();
const services = new ServiceRegistry();
services.registerService(createMessageService(config.externalMessages));
const profile = { model: 'default', image: config.image, writable: true };

const runtime = await createRuntime({
  backend: createOpenSandboxBackend(config.backend),
  services,
  maxAgents: 2,
  outputDir: config.outputDir,
  profiles: {
    writer: { ...profile, services: { messages: ['put'] } },
    reader: {
      ...profile,
      services: { messages: ['get'] },
      collect: {
        paths: ['received.txt'], includeGit: false,
        maxBytes: 4096, required: true,
      },
    },
  },
});
```

这段只展示装配。完整的 `handoff.ts` 还设置工作期限、处理取消、观察结果，并在成功和失败路径中调用 `finalizeRun`。改造示例时应一并保留收尾流程。

`createRuntime` 对 Profile 和 Service 注册取快照、校验引用，创建 Run 目录并打开宿主入口，此时不分配 Agent 沙箱。之后修改原配置对象或 Registry，不会改变这个 Runtime。应在装配前声明 Harness 所需的角色和操作；当前公共 API 没有运行时新增 Profile 或 Service 的方法。

`spawn({ requestId, profile })` 才会分配沙箱并初始化空闲会话，不会自动触发模型执行。先保存新的 Agent ID，接好 Harness 的路由或所有权状态，再发送第一条输入。空闲会话仍占用 Slot，直到清理确认沙箱已删除才释放。

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

交接示例能够等待单个 Agent 的收束，是因为它独占该 Agent 的输入，并额外核对对应 Service 操作和导出文件。通用的多输入源 Harness 必须自己维护任务与结果身份：目前原生执行边界不携带已消费输入的身份，所以执行事件给出 `association: 'unknown'`。

## 连贯地观察快照与后续变化

```ts
const observation = runtime.observe({ signal: shutdownSignal });
console.log(observation.snapshot);

try {
  for await (const update of observation.events) {
    if (update.type === 'gap') {
      // 重新调用 observe()，从新快照重建当前视图。
      break;
    }
    console.log(update.cursor, update.type);
  }
} finally {
  observation.cancel();
}
```

`observe()` 一次返回当前快照，以及紧接该快照游标之后的事件流。应在投递工作前打开订阅，并与 Harness 工作并行消费。`observe({ after: cursor })` 返回 `snapshot: null`，重放缓存中位于该游标之后的更新；续读时继续使用已有状态，遇到 gap 时重新取得快照。

Runtime 缓存 256 条更新，最多允许 64 个活动订阅。游标只属于当前 Runtime 实例，不能作为进程重启后的恢复令牌。即使 Runtime 已关闭，观察订阅也需要由调用方取消。`onEvent` 适合读取输出文本和四类 Agent 事件；`observe` 额外提供 Runtime、输入、Service 和清理状态。[API 参考](./reference/api.md#实时观察)解释了各序号的含义与容量限制。

## 收尾时分别检查各项结果

交接示例先确定自己的业务结果，再使用公开的 finalizer：

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finalizeRun } from '@murm/core';

const report = await finalizeRun({
  runtime,
  outputDir: config.outputDir,
  business,
  cleanupTimeoutMs: 30_000,
  ...(readerId === undefined ? {} : {
    async verifyArtifacts(receipt, signal) {
      const reader = receipt.agents.find(agent => agent.agentId === readerId);
      const files = reader?.artifacts.find(path => path.endsWith('/artifacts/files'));
      if (!files || await readFile(join(files, 'received.txt'), {
        encoding: 'utf8', signal,
      }) !== `${expected}\n`) {
        throw new Error('HANDOFF_ARTIFACT_MISMATCH');
      }
    },
  }),
});
```

这里的 `business` 是类型化的 `RunBusinessOutcome`，`readerId` 和 `expected` 是交接程序保存的状态。创建过 reader 才请求文件验证；完整成功、失败与取消路径见 `handoff.ts`。Finalizer 调用 `runtime.close`，取得关闭回执后执行产物检查，再关闭显式列在 `ownedFacilities` 中且由本次应用拥有的设施。设施关闭还要求 Core 清理已确认完成。

| 报告字段 | 回答的问题 |
| --- | --- |
| `business` | Harness 完成了声明的结果，还是失败或取消？ |
| `coreClose` | Core 清理已完成、仍待处理，还是尚不能确认？ |
| `artifactVerification` | 应用已验证导出产物、验证失败、暂缓验证，还是未请求验证？ |
| `facilities` | 应用拥有的外部设施是否已关闭？ |
| `reportSaveFailure` | 报告本身是否保存成功？ |

必需产物导出失败时，Core 保留沙箱，并在待处理回执中给出原因。Core 仍需使用的外部设施应保持可用。每个 Runtime 对象只能调用一次 finalizer；继续核对待处理清理时，使用原 Runtime 的 `close()` 与原设施句柄。已发出但超时的设施关闭回调，可以通过 `lateFacilityCleanup` 给出独立的晚到回执。

## 扩展协作机制

Agent 需要共享任务池、信箱、成果库或检查器时，可以把它实现为 Service。[构建自己的 Harness](./build-your-harness.md)提供完整 manifest 与 adapter 示例。进程内 adapter 在宿主进程执行，HTTP JSON adapter 连接已有服务。Service 可以部署在独立容器或外部应用中；将它注册到 Runtime，不会转移该部署的所有权。

父 Agent 负责创建子 Agent 时，授予内置 `agent` Service 操作并声明 `spawnProfiles`；同级协作时，通过自定义 Service 与宿主策略组织输入和成果流转；任务认领时，把业务所有权与受信文件交接接口衔接起来。[Harness 目录](./harnesses/index.md)说明 TaskPool、PeerMesh、Subagents、Substrate 与 Lead-Worker 如何用相同原语实现不同机制。

需要精确参数和恢复行为时，查阅 [API 参考](./reference/api.md)；需要公共声明时，查阅[类型定义](./reference/types.md)；需要理解资源所有权与关闭顺序时，阅读[一次运行的完整脉络](./run-lifecycle.md)。
