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

通过 npm 全局安装 CLI（推荐加 `--ignore-scripts`，无需执行依赖生命周期脚本）：

```bash
npm install -g --ignore-scripts @luna-shi/murm
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

配置任意支持流式输出的 **OpenAI Responses 兼容端点（`/v1/responses`）** 和访问密钥。凭据仅保存在宿主机 Model Gateway 中，绝不会注入到 Agent 沙箱内：

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_TOKEN='sk-...'

# 可选：默认执行器为 pi，provider 为 openai，模型为 gpt-5.4
# 可按需改为任意 OpenAI Responses 兼容网关与模型 ID：
# export MURM_MODEL_PROVIDER='openai'
# export MURM_MODEL_ID='gpt-4.1'
# export MURM_EXECUTOR='codex'
```

- **无需手动配置 Worker 镜像**：所有 CLI 与 SDK 默认自动使用与当前 `@luna-shi/murm` 版本对应的 `ghcr.io/luna-shi/murm-worker:0.2.0`（导出常量 `DEFAULT_WORKER_IMAGE`）。只有当你构建了自定义 Worker 镜像（例如在沙箱中预装 Rust、Lean 或专有工具链）时，才需要通过 `export MURM_WORKER_IMAGE='your-custom-image:tag'` 覆盖。
- **连接默认值**：OpenSandbox 默认 `http://127.0.0.1:8080/v1`，沙箱访问宿主的默认网关地址为 `172.17.0.1`。如需覆盖，可设置 `MURM_LIFECYCLE_URL`、`MURM_LIFECYCLE_TOKEN` 和 `MURM_ADVERTISE_HOST`。

## 4. 方式 A：通过 CLI 运行第一个内置 Harness

在任意本地代码仓库或项目目录中，直接运行内置的 `subagents`（或 `messages`、`taskpool`、`peermesh`、`substrate`、`lead-worker`）Harness：

```bash
cd your-project
murm --harness subagents --prompt "检查当前项目的测试覆盖情况，列出两条最值得补充的边界测试"
```

运行结束后，stdout 会输出包含结果、导出产物与清理回执的 JSON，完整轨迹保存在输出目录中。你也可以安装可选的 Trace Viewer 在浏览器中查看时间线：

```bash
npm install -g --ignore-scripts @luna-shi/murm-trace-viewer
murm trace --root ./subagents-runs
```

## 5. 方式 B：在自己的 TypeScript 项目中使用 SDK

如果你想自己编写协作机制（Harness），只需新建目录并安装 `@luna-shi/murm`：

```bash
mkdir my-harness
cd my-harness
npm init -y
npm pkg set type=module
npm install --ignore-scripts @luna-shi/murm
```

创建 `handoff.ts`——下面这段自包含代码注册了一个 `messages` Service，在隔离沙箱中启动两个 Agent 完成值传递，并验证导出结果和资源清理：

```ts
import {
  DEFAULT_WORKER_IMAGE,
  ServiceRegistry,
  createInProcessAdapter,
  createRuntime,
  createSandbox,
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
    put: async ({ input }) => {
      const { key, text } = input as { key: string; text: string };
      store.set(key, text);
      return { stored: true };
    },
    get: async ({ input }) => {
      const { key } = input as { key: string };
      return { text: store.get(key) ?? null };
    },
  }),
};

const services = new ServiceRegistry();
services.registerService(messagesService);

const image = process.env.MURM_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE;
const token = process.env.MURM_MODEL_TOKEN;

const runtime = await createRuntime({
  sandbox: createSandbox({
    lifecycleBaseUrl: process.env.MURM_LIFECYCLE_URL ?? 'http://127.0.0.1:8080/v1',
    isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } },
  }),
  connection: { advertiseHost: process.env.MURM_ADVERTISE_HOST ?? '172.17.0.1' },
  models: {
    default: {
      provider: process.env.MURM_MODEL_PROVIDER ?? 'openai',
      model: process.env.MURM_MODEL_ID ?? 'gpt-5.4',
      upstream: {
        url: process.env.MURM_MODEL_URL!,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    },
  },
  services,
  profiles: {
    writer: { model: 'default', image, writable: false, services: { messages: ['put'] } },
    reader: { model: 'default', image, writable: true, services: { messages: ['get'] } },
  },
  maxAgents: 2,
  outputDir: './handoff-runs',
});

const settled = new Map<string, () => void>();
const waitSettled = (agentId: string) => new Promise<void>(resolve => settled.set(agentId, resolve));
const off = runtime.onEvent(event => {
  if (event.type === 'settled') settled.get(event.agentId)?.();
});

try {
  const writer = await runtime.spawn({ requestId: 'spawn-writer', profile: 'writer' });
  const writerDone = waitSettled(writer.id);
  await runtime.send(
    writer.id,
    `Run: printf '%s' '{"key":"greeting","text":"hello from murm"}' | swarm messages put --stdin --request-id put-1`,
    { requestId: 'send-writer', mode: 'followUp' },
  );
  await writerDone;

  const reader = await runtime.spawn({ requestId: 'spawn-reader', profile: 'reader' });
  const readerDone = waitSettled(reader.id);
  await runtime.send(
    reader.id,
    `Run: printf '%s' '{"key":"greeting"}' | swarm messages get --stdin --request-id get-1, then write the text into received.txt.`,
    { requestId: 'send-reader', mode: 'followUp' },
  );
  await readerDone;

  console.log('Stored in Service:', store.get('greeting'));
} finally {
  off();
  const receipt = await runtime.close({ timeoutMs: 30_000 });
  console.log('Cleanup status:', receipt.cleanup, 'Output:', receipt.outputDir);
}
```

Node.js 22.19+ 原生支持直接运行 TypeScript，无需额外配置 `tsconfig.json` 或编译步骤：

```bash
node handoff.ts
```

（如果需要类型检查，可以按需安装 `npm install -D typescript @types/node` 并运行 `npx tsc --noEmit`。）

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
