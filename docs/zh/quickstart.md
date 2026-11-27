---
title: 快速上手
description: 在 Linux 上连接或部署 OpenSandbox，再通过 CLI 或 TypeScript SDK 跑通第一次多 Agent 运行。
section: 快速开始
order: 1
---

`@luna-shi/murm` 安装包包含 CLI、TypeScript SDK 和 Trace Viewer。准备一个 Linux 普通账号和 Node.js 22.19 或更新版本。已有 OpenSandbox 的用户直接连接，也可以由 setup 引导本地部署。

## 1. 安装 murm

安装你要使用的实现版本。测试尚未发布的改动时，安装对应候选包。

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

正式安装包见 [GitHub Releases](https://github.com/LuNa-shi/murm/releases)，请使用对应版本的文档。

## 2. 连接或部署 OpenSandbox

### 连接已有服务

配置 Lifecycle API 和密钥。Controller 必须能访问服务返回的 Worker 和 Execd 地址，Worker 必须能回连 Controller 的 Bridge 和 Model Gateway。Controller 只需要 Node.js 和 murm 安装包。

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
# 在可信进程环境设置服务管理员提供的 MURM_LIFECYCLE_TOKEN。
murm setup --mode existing
```

路由有额外要求时，在 ESM 配置中设置 `sandbox.endpointHost` 或 `sandbox.useServerProxy: true`，再执行 `murm setup --mode existing --config ./murm.config.mjs`。前者覆盖返回的地址主机，后者使用 OpenSandbox 的服务端代理，两者选其一。服务端代理需要支持代理 token header 的 Worker。若回连需经域名或 TLS 反向代理，使用 `connection.bridge.publicUrl` 和 `connection.modelGateway.publicUrl` 声明包含 `{port}` 的 HTTP(S) 地址模板。发起连接的进程必须信任 TLS 证书。

### 本地部署

```bash
murm setup --mode local
```

setup 检查当前 Docker context，启动 OpenSandbox 并验证 Lifecycle API 鉴权，然后才准备所选 Worker。缺 Docker 时，会打印当前发行版对应的安装和恢复命令。Docker 的首次系统安装可能需要一次性提权，rootful Docker socket 本身也具有较高的宿主权限。日常 Agent 运行走 OpenSandbox API，无需 murm 专属 sudoers。

托管服务默认绑定到本机回环 8080 端口。需要时 setup 自动生成仅当前用户可读的 Lifecycle 密钥，优先使用发布的 Worker 镜像，必要时才用包内 Dockerfile 构建。重复执行会复用已托管的服务，保留用户配置和其他部署。无参 `murm setup` 在配置了 Lifecycle 地址时选择已有服务路径，使用默认地址时选择本地路径。

`murm doctor` 检查配置与 Lifecycle 鉴权，无需创建 Sandbox。`murm doctor --smoke` 会启动真实的 Pi 或 Codex Worker，用受控的 Responses 端点验证 Bridge、网关、文件读写、导出和删除。真实模型验证状态单独报告。

### 保留严格本地隔离

有明确的工作区配额、实时共享挂载或按 UID 网络白名单需求时，继续指定 `isolation: { network: 'local-docker', disk: { bytes, inodes } }`。旧的字节数加 inode 配置也会选择此策略。该策略依赖已有管理员配置的同机 Docker、命名空间能力和 Landlock ABI 5+。默认 API 策略要求 Provider 隔离低权限 Agent 并保护管理接口，实际检查 CPU 和内存上限，出站网络策略由部署提供。显式请求的磁盘上限、网络白名单或实时共享挂载无法落实时，启动会说明缺失能力。

## 3. 配置模型端点

配置模型对应的流式 **OpenAI Responses 兼容端点（`/v1/responses`）** 和访问密钥。上游凭据保存在宿主机 Model Gateway 中。

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_TOKEN='sk-...'

# 可选：默认执行器为 pi，provider 为 openai，模型为 gpt-5.4
# 也可指定该端点支持的提供方与模型：
# export MURM_MODEL_PROVIDER='openai'
# export MURM_MODEL_ID='gpt-4.1'
# export MURM_EXECUTOR='codex'
```

- Subagents、TaskPool、Notes 和 Messages 默认使用 `DEFAULT_WORKER_IMAGE` 对应的版本标签，可通过 `MURM_WORKER_IMAGE` 选择自定义镜像。SDK 调用方需要在每个 Profile 中指定镜像，下文有示例。自定义镜像应使用对应包版本的源码重建，使 Pi 模型目录和 Worker 启动约定匹配。
- **连接默认值**：OpenSandbox 默认 `http://127.0.0.1:8080/v1`，沙箱访问宿主的默认网关地址为 `172.17.0.1`。如需覆盖，可设置 `MURM_LIFECYCLE_URL`、`MURM_LIFECYCLE_TOKEN` 和 `MURM_ADVERTISE_HOST`。

## 4. 方式 A：通过 CLI 运行第一个内置 Harness

在任意本地代码仓库或项目目录中运行 `subagents`。同一套模型配置也适用于 `messages`、`notes` 和 `taskpool`：

```bash
cd your-project
murm --harness subagents --prompt "检查当前项目的测试覆盖情况，列出两条最值得补充的边界测试"
```

PeerMesh、Substrate 和 Lead–Worker 有各自的镜像、模型和 Service 配置。请按[选择 Harness](harnesses/index.md)中的对应入口配置。

运行结束后，stdout 会输出包含结果、导出产物与清理回执的 JSON，完整轨迹保存在输出目录中。你可以直接用内置的 Trace Viewer 在浏览器中查看时间线（无需额外安装包）：

```bash
murm trace --root ./subagents-runs
```

## 5. 方式 B：在自己的 TypeScript 项目中使用 SDK

如果你想自己编写协作机制（Harness），只需新建目录并安装 `@luna-shi/murm`：

```bash
mkdir my-harness
cd my-harness
npm init -y
npm pkg set type=module
npm install --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

安装未发布版本时，将安装命令中的 URL 替换为上一步生成的 tarball 的绝对路径。

创建 `handoff.ts`——下面这段自包含代码注册了一个 `messages` Service，在隔离沙箱中启动两个 Agent 完成值传递，并验证导出结果和资源清理：

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createInProcessAdapter,
  createRuntime,
  createSandbox,
  type JsonValue,
  type ServiceRegistration,
} from '@luna-shi/murm';

const store = new Map<string, string>();
const messagesService: ServiceRegistration = {
  manifest: {
    contract_version: '2',
    id: 'messages',
    title: 'Messages',
    purpose: 'Exchange short text values between Agents by key.',
    provider_version: '1.0.0',
    endpoint: { transport: 'in-process' },
    capabilities: [
      {
        name: 'put',
        operation: 'put',
        description: 'Store a text value under a key.',
        side_effect: 'write',
        idempotent: true,
        help: { when: 'Publish a value for another Agent' },
        errors: [],
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string' }, text: { type: 'string' } },
          required: ['key', 'text'],
          additionalProperties: false,
        },
        output_schema: {
          type: 'object',
          properties: { stored: { type: 'boolean' } },
          required: ['stored'],
          additionalProperties: false,
        },
      },
      {
        name: 'get',
        operation: 'get',
        description: 'Read a stored text value by key.',
        side_effect: 'read',
        idempotent: true,
        help: { when: 'Read a published value' },
        errors: [],
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        output_schema: {
          type: 'object',
          properties: { text: { type: ['string', 'null'] } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
  },
  adapter: createInProcessAdapter({
    invoke({ capability, input, assertAuthorized }): JsonValue {
      const { key, text } = input as { key: string; text: string };
      if (capability.operation === 'get') return { text: store.get(key) ?? null };
      assertAuthorized();
      store.set(key, text);
      return { stored: true };
    },
  }),
};

const services = new ServiceRegistry();
services.registerService(messagesService);

const image = process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE;
const token = process.env.MURM_MODEL_TOKEN;
const url = process.env.MURM_MODEL_URL;
if (!url) throw new Error('Set MURM_MODEL_URL before running the handoff');

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    apiKey: process.env.MURM_LIFECYCLE_TOKEN,
  }),
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      upstream: {
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    },
  },
  services,
  profiles: {
    writer: { model: 'default', image, writable: false, services: { messages: ['put'] } },
    reader: {
      model: 'default', image, writable: true, services: { messages: ['get'] },
      collect: { paths: ['received.txt'], includeGit: false, maxBytes: 4096, required: true },
    },
  },
  maxAgents: 2,
  outputDir: './handoff-runs',
});

async function runTurn(agentId: string, input: string, requestId: string) {
  let unsubscribe = () => {};
  const execution = Promise.withResolvers<void>();
  const timer = setTimeout(() => execution.reject(new Error('Agent turn timed out')), 60_000);
  try {
    unsubscribe = runtime.onEvent(event => {
      if (!('agentId' in event) || event.agentId !== agentId) return;
      if (event.type === 'settled' && event.outcome === 'completed') execution.resolve();
      else if (event.type === 'settled' || event.type === 'exit' || (event.type === 'error' && event.fatal)) {
        execution.reject(new Error('Agent execution failed'));
      }
    });
    const admission = runtime.send(agentId, input, { requestId, mode: 'followUp' }).then(receipt => {
      if (receipt.status !== 'accepted' || receipt.disposition !== 'started') {
        throw new Error('Agent input was not accepted for execution');
      }
    });
    await Promise.all([admission, execution.promise]);
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
}

const expected = 'hello from murm';
let readerId: string | undefined;
let cleanup;
try {
  const writer = await runtime.spawn({
    requestId: 'spawn-writer', profile: 'writer',
    files: { 'message.json': { encoding: 'utf8', data: JSON.stringify({ key: 'greeting', text: expected }) } },
  });
  await runTurn(writer.id, 'Run swarm messages put --input message.json --request-id put-1, then finish.', 'send-writer');
  if (store.get('greeting') !== expected) throw new Error('Writer did not publish the expected value');

  const reader = await runtime.spawn({ requestId: 'spawn-reader', profile: 'reader' });
  readerId = reader.id;
  await runTurn(reader.id, 'Run swarm messages get --key greeting --request-id get-1 | jq -er .text > received.txt and then finish.', 'send-reader');
} finally {
  cleanup = await runtime.close({ timeoutMs: 30_000 });
  console.log('Cleanup status:', cleanup.cleanup, 'Output:', cleanup.outputDir);
}

if (cleanup.cleanup !== 'complete') throw new Error('Runtime cleanup is pending');
const output = cleanup.agents.find(agent => agent.agentId === readerId)
  ?.artifacts.find(path => path.endsWith('/artifacts/files'));
if (!output || await readFile(join(output, 'received.txt'), 'utf8') !== expected + '\n') {
  throw new Error('Reader did not export the expected text');
}
console.log('Handoff verified');
```

Node.js 22.19+ 原生支持直接运行 TypeScript，无需额外配置 `tsconfig.json` 或编译步骤：

```bash
node handoff.ts
```

如需检查示例的类型，可以运行以下命令。

```bash
npm install -D typescript @types/node
npx tsc --noEmit --strict --target es2024 --module nodenext --types node handoff.ts
```

## 从源码贡献开发

如果你要修改 `murm` 本身或运行仓库完整测试套件：

```bash
git clone https://github.com/LuNa-shi/murm.git
cd murm
npm ci --ignore-scripts
npm run build
npm test
```

## 下一步

- 阅读 [最新版本 (v0.2.0)](latest.md) 查看当前版本提供的完整能力，并在 [更新日志](changelog.md) 追踪版本变更。
- 阅读 [使用 SDK](sdk.md)，深入理解 Runtime 生命周期、输入回执、产物验证与外部 HTTP Service 接入。
- 阅读 [构建你自己的 Harness](build-your-harness.md)，设计自己的协作协议、权限矩阵与验收规则。
- 浏览 [选择 Harness](harnesses/index.md)，对比 `Subagents`、`TaskPool`、`PeerMesh`、`Substrate` 与 `Lead-Worker` 五种内置机制。

### 选择执行器或扩大项目文件预算

继续使用 `murm --harness … --cwd … --prompt …`。在配置中选择执行器和模型，通过 `workerImageFor(executor)` 获取匹配的单执行器镜像，或者用 `MURM_WORKER_IMAGE` 指定已有镜像。将同一配置文件交给 `murm setup --config ./murm.config.mjs` 和 `murm doctor --config ./murm.config.mjs` 验证。Pi 支持 Responses 和 Chat Completions。项目超过默认导入限制时，可在 `filePolicy` 中分别扩大导入、在线操作和最终产物导出的预算。[配置说明与示例](sdk.md#配置执行器模型与文件预算)
