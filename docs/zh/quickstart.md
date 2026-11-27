---
title: 快速上手
description: 在 Linux 上安装 @luna-shi/murm、本地启动或连接 OpenSandbox，并用一条命令跑通你的第一次多智能体运行。
section: 快速开始
order: 1
---

`@luna-shi/murm` 把 CLI、TypeScript SDK 和内置 Trace Viewer 打包在同一个安装包里。每个 Agent 都运行在独立的容器沙箱中——`murm` 默认基于开源容器沙箱项目 **OpenSandbox** 来创建与管理这些隔离环境。

**前置环境**：一台 Linux 机器，安装 **Node.js 22.19+** 与 **Docker**，即可直接在本机一键配置（若团队已有共享 OpenSandbox 服务，控制端仅需 Node.js 即可接入）。

## 1. 安装 `murm`

从最新 [GitHub Release](https://github.com/LuNa-shi/murm/releases) 一行命令安装正式版 CLI：

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

也可以直接用 npm 全局安装：

```bash
npm install -g --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
```

<details>
<summary>测试当前源码仓库里尚未发布的最新改动？展开查看本地打包安装命令</summary>

### 从源码检出安装候选包

```bash
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

</details>

## 2. 一键初始化 OpenSandbox

默认在当前 Linux 机器上一键部署托管的 OpenSandbox 服务并准备 Worker 镜像：

```bash
murm setup --mode local
```

它会自动检查本地 Docker 环境，在回环 `127.0.0.1:8080` 启动托管 OpenSandbox、按需生成仅当前用户可读的 Lifecycle 密钥，并拉取（或按需构建）Worker 镜像。如果本机尚未安装 Docker，会直接打印当前 Linux 发行版对应的安装命令。

### 验证环境就绪

```bash
# 快速检查配置与 Lifecycle 鉴权
murm doctor

# 端到端冒烟测试：拉起真实 Worker，验证 Bridge、模型网关、文件读写与清理
murm doctor --smoke
```

<details>
<summary>连接已有远程 OpenSandbox 服务（可选）</summary>

如果团队已经独立部署了 OpenSandbox 服务，只需设置服务端地址与控制端回连地址即可接入（确保控制端能访问 Lifecycle / Worker 端口，且 Worker 能回连控制端的 Bridge 与 Model Gateway）：

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
# 在可信进程环境中设置管理员提供的 MURM_LIFECYCLE_TOKEN
murm setup --mode existing
```

> 如需代理路由（`sandbox.endpointHost` / `sandbox.useServerProxy`）或 HTTPS 反向代理回调模板，见 [Sandbox 隔离沙箱](sandbox.md) 与 [Host Gateway 宿主机网关](gateway.md)。

</details>

<details>
<summary>启用严格本机隔离策略（可选：tmpfs 配额、实时共享挂载、UID 防火墙白名单）</summary>

默认的 OpenSandbox API 策略提供容器隔离、API 鉴权与 CPU/内存上限。

如果你的部署需要**计量工作区 `tmpfs` 配额、实时共享挂载或本机 UID 防火墙白名单**，可在 `createSandbox()` 中显式启用 `local-docker` 策略（需同机 rootful Docker、Linux 命名空间能力与 Landlock ABI 5+，详见 [Sandbox 隔离沙箱](sandbox.md)）：

```ts
isolation: { network: 'local-docker', disk: { bytes: 64 * 1024 ** 2, inodes: 4096 } }
```

</details>

## 3. 配置模型并跑通第一次运行

设置任意流式 **OpenAI Responses 兼容端点（`/v1/responses`）** 和访问密钥（上游密钥留在宿主机 Model Gateway，绝不进入容器；Pi 执行器在配置中同样支持 **Chat Completions**）：

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_TOKEN='sk-...'

# 可选：默认执行器为 pi（provider: openai, model: gpt-5.4），可按需切换：
# export MURM_MODEL_PROVIDER='openai'
# export MURM_MODEL_ID='gpt-4.1'
# export MURM_EXECUTOR='codex'
```

进入任意项目目录，运行内置的 `Subagents` Harness：

```bash
cd my-project
murm --harness subagents --prompt "检查项目测试并解释或修复失败用例"
```

> 也可以直接执行 `murm` 启动当前项目的交互式会话，或用 `murm init --template subagents --dir ./my-harness` 生成一个可编辑的模板项目。

运行结束后（或运行过程中），用内置 **Trace Viewer** 在浏览器中查看完整时间线、协作交接与导出产物：

```bash
murm trace --root ./runs --port 8787 --open
```

如果跑在远程 Linux 服务器上，`murm trace` 会自动打印对应的 `ssh -N -L` 端口转发命令，复制到本机终端即可打开 `http://127.0.0.1:8787`。

## 4. 在自己的 TypeScript 项目中使用 SDK

想用代码编写自定义协作机制，只需在 Node.js 22.19+ 项目中安装 `@luna-shi/murm`（Node.js 22.19+ 原生支持直接运行 `.ts` 文件）：

```bash
mkdir my-swarm && cd my-swarm
npm init -y && npm pkg set type=module
npm install --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/download/v0.2.0/luna-shi-murm-0.2.0.tgz
```

> 如果在测试当前源码检出，直接安装第 1 步 `npm pack` 生成的本地 `.tgz` 即可。想先看一个最小的双 Agent 传消息脚本，可以直接参考仓库中的 [`examples/bridge-services/handoff.ts`](https://github.com/LuNa-shi/murm/blob/main/examples/bridge-services/handoff.ts)。

## 下一步

- **[核心概念](concepts.md)**：2 分钟看懂 6 个核心构件如何协同工作。
- **[实战：构建 Swarm Harness](build-your-harness.md)**：亲手搭一套 3 人并行调研 + 综合的多智能体 Swarm。
- **[选择 Harness](harnesses/index.md)**：对比 `Subagents`、`TaskPool`、`PeerMesh`、`Substrate` 与 `Lead-Worker` 五种内置模式。
- **[CLI 参考](reference/cli.md)** · **[SDK 与 API 参考](reference/api.md)**：查阅全部命令行参数、配置项与执行器/文件预算设置。
