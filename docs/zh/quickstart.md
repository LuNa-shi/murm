---
title: 快速上手
description: 安装宿主机依赖、用一行命令安装 @luna-shi/murm，并通过 CLI 或 TypeScript SDK 跑通第一次多智能体运行。
section: 快速开始
order: 1
---

`murm` 通过 npm 包 **`@luna-shi/murm`** 同时提供命令行工具与 TypeScript SDK。完成一次宿主机环境准备后，你可以直接通过 CLI 在现有项目中运行内置 Harness，也可以在自己的 TypeScript 程序中嵌入 SDK。

## 1. 环境准备（宿主机前置依赖）

当前 OpenSandbox 隔离后端需要**同一台 Linux 宿主机**（不支持 macOS、Docker Desktop 或 rootless Docker），并满足以下 5 项前置条件：

| 依赖 | 最低要求 | 用途 |
| --- | --- | --- |
| **Linux 内核** | 支持 **Landlock ABI >= 5**（通常需 Linux 6.10+，x86_64 或 aarch64） | 沙箱内 Agent 文件系统访问边界强制 |
| **Node.js & npm** | **Node.js 22.19+** | 运行 `murm` CLI 与 TypeScript SDK |
| **Docker Engine** | 本地 **rootful Docker Engine**（`/var/run/docker.sock`，本机 `/run/docker.pid` 可见） | 运行 OpenSandbox 服务端与隔离 Worker 容器 |
| **宿主机系统工具** | `python3`、`nftables`、`util-linux`、`coreutils`、`iproute2` | 为每个沙箱挂载独立配额 `tmpfs` 与 `nftables` 出站防火墙 |
| **免密 `sudo` 规则** | 允许宿主非交互调用 `unshare`、`nft` 与 `mount-agent-workspace.py` | 宿主侧设置容器网络与磁盘隔离（Agent 容器内保持无特权） |

### 1.1 检查 Linux 内核与 Node.js

```bash
# 确认 Node.js >= 22.19.0
node -v

# 确认内核已启用 Landlock ABI >= 5
python3 -c "import ctypes, platform; assert platform.machine() in ('x86_64', 'aarch64'); abi = ctypes.CDLL(None).syscall(444, 0, 0, 1); print('Landlock ABI:', abi); assert abi >= 5"
```

### 1.2 安装 Docker Engine 与系统工具（Ubuntu / Debian 示例）

若尚未安装 rootful Docker Engine，请先按 [Docker Engine 官方文档](https://docs.docker.com/engine/install/) 安装，然后安装系统工具并把当前用户加入 `docker` 组：

```bash
sudo apt-get update
sudo apt-get install -y python3 nftables util-linux coreutils iproute2

# 允许当前用户访问 /var/run/docker.sock（执行后需重新登录 shell 或运行 newgrp docker）
sudo usermod -aG docker "$USER"
docker info --format '{{.OSType}} {{.ServerVersion}}'
```

### 1.3 配置最小权限免密 `sudo`

`murm` 在启动每个 Agent 沙箱时，会在**宿主机侧**为其命名空间配置 `tmpfs` 配额挂载和 `nftables` 规则（只允许访问宿主的 Bridge 与 Model Gateway）。请先安装 `@luna-shi/murm`（见第 2 步），再用 `sudo visudo -f /etc/sudoers.d/murm` 添加如下最小权限规则（把 `<your-user>` 替换为你的用户名，把 `<murm-pkg-root>` 替换为 `npm root -g` 下的 `@luna-shi/murm` 路径）：

```text
<your-user> ALL=(root) NOPASSWD: /usr/bin/unshare --mount --net -- /usr/bin/true
<your-user> ALL=(root) NOPASSWD: /usr/sbin/nft *
<your-user> ALL=(root) NOPASSWD: /usr/bin/nsenter *
<your-user> ALL=(root) NOPASSWD: /usr/bin/mount *
<your-user> ALL=(root) NOPASSWD: /usr/bin/umount *
<your-user> ALL=(root) NOPASSWD: /usr/bin/python3 -I <murm-pkg-root>/dist/scripts/mount-agent-workspace.py *
```

验证权限已生效（均应无密码报错直接退出 0）：

```bash
sudo -n /usr/bin/unshare --mount --net -- /usr/bin/true
sudo -n /usr/sbin/nft -j list tables >/dev/null
```

## 2. 安装 `@luna-shi/murm` 并初始化基础设施

从最新的 GitHub Release 全局安装 CLI：

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

也可以直接使用 npm 安装。

```bash
npm install -g --ignore-scripts --allow-remote=root https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
```

### 从源码检出安装候选包

对于尚未发布的版本，在 murm 的源码目录执行以下命令。如果也要在独立项目中安装 SDK，请保留 tarball。

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --ignore-scripts "$pack_dir"/*.tgz
```

运行 `murm setup` 一键准备并校验本地执行环境：

```bash
murm setup
```

`murm setup` 不是黑盒——它按顺序执行以下 4 件事并输出结构化 JSON 报告：

1. **宿主机预检**：校验 Linux/Landlock ABI、Node 版本、rootful Docker、Docker bridge 网关 IP（默认 `172.17.0.1`）、`nftables`、`unshare` 与免密 `sudo` 权限（可随时单独运行 `murm doctor` 复查）。
2. **启动本地 OpenSandbox**：拉取 `opensandbox/server:release-1.2.0` 与 `opensandbox/execd:v1.1.0`，使用包内置的 `deploy/opensandbox/config.toml` 启动常驻容器 `murm-opensandbox-8080`，在 `http://127.0.0.1:8080/v1` 提供生命周期 API（状态目录位于 `~/.cache/murm/opensandbox/`）。
3. **准备 Worker 镜像**：拉取与当前版本匹配的官方预构建镜像 `ghcr.io/luna-shi/murm-worker:0.2.0`；如果当前网络无法拉取或处于本地开发版，则自动基于包内的 `deploy/worker/Dockerfile` 本地构建并打上同一标签。Worker 镜像包含 `opensandbox-agent-worker`、Pi `1.3.0`、Codex CLI `0.172.0`、`swarm` CLI、`jq` 和 Landlock 策略程序。
4. **真实沙箱冒烟探测**：使用本地回环 mock 模型端点启动一个真实沙箱，确认工具调用、Service Bridge 与资源清理链路全部正常。

<details>
<summary>不想用一键脚本？展开查看手动准备 OpenSandbox 与 Worker 镜像的等价命令</summary>

1. 拉取 OpenSandbox 镜像并启动本地控制面（监听 `127.0.0.1:8080/v1`）：

```bash
docker pull opensandbox/execd:v1.1.0
docker pull opensandbox/server:release-1.2.0

MURM_ROOT="$(npm root -g)/@luna-shi/murm"
mkdir -p ~/.cache/murm/opensandbox/manual/data
cp "$MURM_ROOT/deploy/opensandbox/config.toml" ~/.cache/murm/opensandbox/manual/config.toml

docker run -d \
  --name murm-opensandbox-8080 \
  --network host \
  --restart unless-stopped \
  -e OPENSANDBOX_INSECURE_SERVER=YES \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ~/.cache/murm/opensandbox/manual/config.toml:/config/config.toml:ro \
  -v ~/.cache/murm/opensandbox/manual/data:/root/.opensandbox \
  opensandbox/server:release-1.2.0 --config /config/config.toml
```

2. 拉取预构建 Worker 镜像（或从包内 Dockerfile 本地构建）：

```bash
# 方式 1：直接拉取官方预构建镜像（推荐）
docker pull ghcr.io/luna-shi/murm-worker:0.2.0

# 方式 2：或自行本地构建（自定义依赖时使用）
docker build -f "$MURM_ROOT/deploy/worker/Dockerfile" -t ghcr.io/luna-shi/murm-worker:0.2.0 "$MURM_ROOT"
```

3. 用 `murm doctor --smoke` 验证全部依赖、OpenSandbox 和 Worker 镜像契约：

```bash
murm doctor --smoke
```

</details>

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
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
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

- 阅读 [使用 SDK](sdk.md)，深入理解 Runtime 生命周期、输入回执、产物验证与外部 HTTP Service 接入。
- 阅读 [构建你自己的 Harness](build-your-harness.md)，设计自己的协作协议、权限矩阵与验收规则。
- 浏览 [选择 Harness](harnesses/index.md)，对比 `Subagents`、`TaskPool`、`PeerMesh`、`Substrate` 与 `Lead-Worker` 五种内置机制。
