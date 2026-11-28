---
title: 快速上手
description: 在 Linux 上准备环境、安装 murm、初始化 OpenSandbox 与 Worker，并运行第一个多智能体示例。
section: GET STARTED
order: 1
---

`murm` 将 CLI 与 TypeScript SDK 打包在同一个安装包中，并在 [OpenSandbox](sandbox.md) 隔离沙箱中运行 Agent。你可以在 Linux 本机通过 Docker 一键启动 OpenSandbox，也可以接入团队已有的服务。

## 前置要求

| 依赖 | 要求与说明 | 检查命令 |
| --- | --- | --- |
| **Linux** | 控制器宿主机（如 Ubuntu / Debian） | `uname -s` |
| **Node.js 与 npm** | `>= 22.19`（Ubuntu 24.04、Debian 13 等软件源默认版本偏旧，请从 [nodejs.org](https://nodejs.org/en/download) 安装 LTS） | `node --version` |
| **Git 与 curl** | 安装脚本与工作区操作必需 | `git --version` |
| **Docker Engine** | 仅本机启动 OpenSandbox 时需要；接入已有服务可跳过（[安装指南](https://docs.docker.com/engine/install/)） | `docker info` |

Ubuntu / Debian 一键安装系统依赖（如已有 Docker 或接入远程服务，去掉 `docker.io` 与 `systemctl` 即可）：

```bash
sudo apt-get update && sudo apt-get install -y docker.io git curl ca-certificates
sudo systemctl enable --now docker.service
```

> **Docker 权限**：请使用实际运行 `murm` 的账号执行 `docker info`。若提示无权访问 socket，请让管理员授权并在用户组变更后重新登录（[`docker` 用户组具有等同于 root 的权限](https://docs.docker.com/engine/install/linux-postinstall/)）。

## 1. 安装 murm

### 方式 A：一键安装最新发行版

```bash
curl -fsSL https://luna-shi.github.io/murm/install.sh | sh
```

安装器优先写入可写的 npm 全局目录，否则安装到 `$HOME/.local`。如果终端打印了 `export PATH=...`，请先在当前 shell 执行后再调用 `murm`。

> **版本提示**：公开安装器下载最新的 GitHub Release。当前 **v0.2.0** 发行版仍依赖旧版宿主机配置（本机 rootful Docker、Landlock ABI 5+ 与非交互式 sudo 规则，Ubuntu 24.04 默认 6.8 内核不满足），使用该发行版请在第 2 步前先完成 [v0.2.0 宿主配置指南](https://github.com/LuNa-shi/murm/blob/v0.2.0/docs/zh/quickstart.md)。若希望仅凭上面的前置要求直接使用默认 OpenSandbox API 模式，请改用下方「方式 B」从源码安装。

<details>
<summary>使用 npm 直接安装发行版（不经过 install.sh）</summary>

```bash
npm install -g --prefix "$HOME/.local" --ignore-scripts --allow-remote=root \
  https://github.com/LuNa-shi/murm/releases/latest/download/luna-shi-murm.tgz
export PATH="$HOME/.local/bin:$PATH"
```

</details>

### 方式 B：从源码构建并安装（`main` 最新版）

在仓库根目录执行以下命令。流程分为三步：`npm ci` 安装依赖、`npm pack` 自动编译并打成发布压缩包、`npm install -g` 将 `murm` CLI 安装到 `$HOME/.local/bin`：

```bash
git clone https://github.com/LuNa-shi/murm.git && cd murm
npm ci --no-audit --no-fund
pack_dir=$(mktemp -d)
npm pack --pack-destination "$pack_dir"
npm install -g --prefix "$HOME/.local" --ignore-scripts "$pack_dir"/*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

## 2. 初始化 OpenSandbox 并构建 Worker

```bash
murm setup
```

`murm setup` 会按顺序完成以下三步（新机器首次运行需要拉取镜像并构建 Worker，耗时约数分钟）：

1. **启动本机 OpenSandbox**：拉取固定版本的 OpenSandbox Server 与 Execd 镜像，并在 `127.0.0.1:8080` 启动托管服务。
2. **准备 Worker 镜像**：优先复用本机缓存中的兼容镜像；缺失时自动从安装包自带的 `deploy/worker/Dockerfile` 构建所选执行器镜像（默认 Pi，依赖 Node 基础镜像、Debian 源与 npm）。
3. **运行端到端自检**：创建临时沙箱，用本地测试响应验证 Service Bridge、Model Gateway、文件导出与沙箱删除（无需配置模型 API Key）。

等待输出出现 `"infrastructure": "ready"` 且 `"ok": true` 即表示环境就绪；若失败，按报告提示处理后重跑 `murm setup` 即可。日常检查可运行 `murm doctor`，重跑完整自检用 `murm doctor --smoke`。

<details>
<summary>接入已有的 OpenSandbox 服务</summary>

在 shell 中设置服务端地址、回调主机与管理员提供的 `MURM_LIFECYCLE_TOKEN`（要求控制端能访问 Lifecycle 与 Worker，Worker 也能回调控制端的 Bridge 与模型网关）：

```bash
export MURM_LIFECYCLE_URL='https://sandbox.example.net/v1'
export MURM_LIFECYCLE_TOKEN='<your-lifecycle-token>'
export MURM_ADVERTISE_HOST='controller.internal.example.net'
murm setup --mode existing
```

如服务端引擎无法自动拉取 Worker 镜像，请管理员提前在服务端准备兼容镜像。代理路由与 HTTPS 回调见 [Sandbox 隔离沙箱](sandbox.md) 和 [宿主网关](gateway.md)。

</details>

<details>
<summary>镜像拉取或 Worker 构建失败排查</summary>

- **OpenSandbox Server / Execd 拉取失败**：setup 会输出失败镜像的完整 digest 与 `docker pull` 命令，在同一 Docker context 中重试即可。网络受限时可配置 [Docker daemon 代理](https://docs.docker.com/engine/daemon/proxy/)、由管理员预置相同固定引用，或改用已有 OpenSandbox 服务。
- **Worker 本地构建失败**：检查 Docker 对 Node 基础镜像、Debian 软件源与 npm 的访问，或直接执行报错里给出的 `docker build` 命令定位具体步骤。若你配置了显式 registry 镜像，缓存缺失时仍会自动拉取。
- **使用可信镜像站构建默认 Pi Worker**（将 `registry.example.net` 替换为你的镜像站）：

```bash
(
  cd "$(dirname "$(readlink -f "$(command -v murm)")")/../.." &&
    docker build -f deploy/worker/Dockerfile -t murm-worker:local \
      --build-arg WORKER_EXECUTOR=pi \
      --build-arg NODE_IMAGE=registry.example.net/library/node:22.19.0-bookworm-slim .
) &&
  export MURM_WORKER_IMAGE=murm-worker:local &&
  murm setup
```

- **跨机器离线导入 Worker**：在有网且同 CPU 架构的机器上导出 `docker save -o worker.tar IMAGE`，传到目标机后在对应 Docker context 执行 `docker load -i worker.tar`。若标签不同于默认值，在 `murm setup` 和运行时均保留 `export MURM_WORKER_IMAGE=IMAGE`。

</details>

## 3. 运行第一个示例

配置任意兼容 OpenAI Responses 流式协议的模型端点与 API Key（下面以 OpenAI 为例），在新建目录中运行一次内置 `subagents`：

```bash
export MURM_MODEL_URL='https://api.openai.com/v1/responses'
export MURM_MODEL_ID='gpt-5-mini'
export MURM_MODEL_TOKEN='<your-api-key>'

mkdir -p murm-first-example && cd murm-first-example
printf '# Hello from murm\n' > README.md
murm --harness subagents --prompt 'Read README.md and report its heading.' --output-dir ./runs
```

如需切换其他模型服务商或执行器（如 Codex），请查看 [CLI 参考](reference/cli.md)。

## 4. 在 Trace Viewer 中回放

```bash
murm trace --root ./runs --port 8787 --open
```

通过 SSH 连接远程机器运行时，`murm trace` 会自动打印一条可直接在本机执行的端口转发命令（如使用了 SSH 别名、映射端口或跳板机，沿用相同连接参数即可）。

## 下一步

- [核心概念](concepts.md)：2 分钟看懂 6 个核心组件如何协同。
- [选择 Harness](harnesses/index.md)：对比 5 种内置多智能体协作模式。
- [构建自己的 Swarm Harness](build-your-harness.md)：结合 [TypeScript SDK](reference/api.md) 定制你自己的多智能体编排。
